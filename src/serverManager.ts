import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { spawn, ChildProcessWithoutNullStreams } from 'child_process';
import {
  TomcatServerConfig,
  DeployedApp,
  ServerStatus,
  DEFAULT_HTTP_PORT,
  DEFAULT_DEBUG_PORT
} from './model';
import { SourceSyncWatcher } from './sourceSync';
import { JavaBuildSyncWatcher } from './javaBuildSync';
import { findProjectRoot, detectBuildInfo } from './sourceOverlay';

const CONFIG_SECTION = 'tomcat';
const CONFIG_KEY = 'servers';
/** Legacy globalState key used before servers were moved into VSCode settings. */
const LEGACY_STORAGE_KEY = 'tomcat.servers';

interface RunningInfo {
  proc: ChildProcessWithoutNullStreams;
  status: ServerStatus;
  outputChannel: vscode.OutputChannel;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Escapes text for safe use inside a double-quoted XML attribute value (e.g. a docBase path
 *  that happens to contain `&`, `<`, or `"`), so generated context.xml files stay valid XML
 *  regardless of what characters show up in a file path. */
function escapeXmlAttr(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export class ServerManager {
  private servers: TomcatServerConfig[] = [];
  private running = new Map<string, RunningInfo>();
  /** key: `${serverId}::${contextPath}` - active source-overlay file sync watchers */
  private syncWatchers = new Map<string, SourceSyncWatcher>();
  /** key: `${serverId}::${contextPath}` - active Java/resource auto-compile watchers */
  private buildWatchers = new Map<string, JavaBuildSyncWatcher>();

  private _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChange = this._onDidChange.event;

  constructor(private context: vscode.ExtensionContext) {
    const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
    let servers = config.get<TomcatServerConfig[]>(CONFIG_KEY, []);

    // One-time migration from the old globalState-based storage (pre-settings-based versions).
    if (servers.length === 0) {
      const legacy = this.context.globalState.get<TomcatServerConfig[]>(LEGACY_STORAGE_KEY, []);
      if (legacy.length > 0) {
        servers = legacy;
        config.update(CONFIG_KEY, legacy, vscode.ConfigurationTarget.Global);
        this.context.globalState.update(LEGACY_STORAGE_KEY, undefined);
      }
    }

    this.servers = servers;
  }

  // ---------- persistence ----------

  private async save() {
    await vscode.workspace
      .getConfiguration(CONFIG_SECTION)
      .update(CONFIG_KEY, this.servers, vscode.ConfigurationTarget.Global);
    this._onDidChange.fire();
  }

  getDefaultLogLevel(): string {
    return vscode.workspace.getConfiguration(CONFIG_SECTION).get<string>('defaultLogLevel', 'INFO');
  }

  /** Relative path (e.g. "src/main/webapp") used to auto-detect the live source overlay for
   *  Maven/Gradle exploded deployments. Configurable for non-default project layouts. */
  getWebappSourceDir(): string {
    return vscode.workspace.getConfiguration(CONFIG_SECTION).get<string>('webappSourceDir', 'src/main/webapp');
  }

  /** Whether Java/resource changes should be auto-compiled and synced into WEB-INF/classes
   *  whenever the live source overlay is enabled for a Maven/Gradle app. */
  isJavaAutoBuildEnabled(): boolean {
    return vscode.workspace.getConfiguration(CONFIG_SECTION).get<boolean>('javaAutoBuild', true);
  }

  /** Whether Tomcat's own bundled sample/admin webapps (ROOT, docs, examples, host-manager)
   *  should be excluded from auto-deployment on startup, so only your own app(s) - and the
   *  Manager app, needed for "Reload Context Now" - actually run. */
  isExcludeDefaultWebappsEnabled(): boolean {
    return vscode.workspace.getConfiguration(CONFIG_SECTION).get<boolean>('excludeDefaultWebapps', true);
  }

  getServers(): TomcatServerConfig[] {
    return this.servers;
  }

  getServer(id: string): TomcatServerConfig | undefined {
    return this.servers.find(s => s.id === id);
  }

  getStatus(id: string): ServerStatus {
    return this.running.get(id)?.status ?? 'stopped';
  }

  // ---------- server registration ----------

  async addServer(homePath: string, name?: string): Promise<TomcatServerConfig> {
    const catalinaScript = this.getCatalinaScript(homePath);
    if (!fs.existsSync(catalinaScript)) {
      throw new Error(
        `선택한 경로는 유효한 Tomcat(CATALINA_HOME) 디렉토리가 아닙니다. (bin/${path.basename(catalinaScript)} 를 찾을 수 없음)`
      );
    }

    const httpPort = this.detectHttpPort(homePath) ?? DEFAULT_HTTP_PORT;

    const config: TomcatServerConfig = {
      id: `tomcat-${Date.now()}`,
      name: name ?? path.basename(homePath),
      homePath,
      httpPort,
      debugPort: DEFAULT_DEBUG_PORT,
      deployedApps: []
    };
    this.servers.push(config);
    await this.save();
    return config;
  }

  async removeServer(id: string) {
    if (this.running.has(id)) {
      await this.stop(id);
    }
    this.stopAllSyncForServer(id);
    this.servers = this.servers.filter(s => s.id !== id);
    await this.save();
  }

  async updatePorts(id: string, httpPort: number, debugPort: number) {
    const server = this.getServer(id);
    if (!server) return;
    server.httpPort = httpPort;
    server.debugPort = debugPort;
    await this.save();
  }

  async updateJavaHome(id: string, javaHome: string | undefined) {
    const server = this.getServer(id);
    if (!server) return;
    server.javaHome = javaHome;
    await this.save();
  }

  async updateLogLevel(id: string, logLevel: string | undefined) {
    const server = this.getServer(id);
    if (!server) return;
    server.logLevel = logLevel;
    await this.save();
  }

  async updateVmOptions(id: string, vmOptions: string | undefined) {
    const server = this.getServer(id);
    if (!server) return;
    server.vmOptions = vmOptions;
    await this.save();
  }

  // ---------- source sync (live JSP/static reload overlay) ----------

  private syncKey(serverId: string, contextPath: string): string {
    return `${serverId}::${contextPath}`;
  }

  private startSourceSync(serverId: string, contextPath: string, overlayPath: string, docBase: string) {
    this.stopSourceSync(serverId, contextPath);
    const outputChannel = this.running.get(serverId)?.outputChannel;
    const watcher = new SourceSyncWatcher(overlayPath, docBase, msg => outputChannel?.appendLine(msg));
    watcher.start();
    this.syncWatchers.set(this.syncKey(serverId, contextPath), watcher);
  }

  private stopSourceSync(serverId: string, contextPath: string) {
    const key = this.syncKey(serverId, contextPath);
    const watcher = this.syncWatchers.get(key);
    if (watcher) {
      watcher.stop();
      this.syncWatchers.delete(key);
    }
  }

  private stopAllSyncForServer(serverId: string) {
    const prefix = `${serverId}::`;
    for (const key of Array.from(this.syncWatchers.keys())) {
      if (key.startsWith(prefix)) {
        this.syncWatchers.get(key)?.stop();
        this.syncWatchers.delete(key);
      }
    }
    for (const key of Array.from(this.buildWatchers.keys())) {
      if (key.startsWith(prefix)) {
        this.buildWatchers.get(key)?.stop();
        this.buildWatchers.delete(key);
      }
    }
  }

  private stopJavaBuildSync(serverId: string, contextPath: string) {
    const key = this.syncKey(serverId, contextPath);
    const watcher = this.buildWatchers.get(key);
    if (watcher) {
      watcher.stop();
      this.buildWatchers.delete(key);
    }
  }

  /**
   * Manually triggers an immediate Java/resource compile + sync for a deployed exploded app,
   * for diagnosing/forcing the auto-build-on-change feature on demand. Returns a reason
   * string (no watcher, no Maven/Gradle project detected, auto-build disabled, etc.) when it
   * can't run at all, distinct from a build that ran but failed (whose output goes to the
   * server's output channel as usual).
   */
  async forceResyncClasses(serverId: string, contextPath: string): Promise<{ ok: boolean; reason?: string }> {
    const server = this.getServer(serverId);
    if (!server) return { ok: false, reason: '서버를 찾을 수 없습니다.' };
    const app = server.deployedApps.find(a => a.contextPath === contextPath);
    if (!app || app.type !== 'exploded') return { ok: false, reason: 'exploded 배포가 아닙니다.' };
    if (!app.sourceOverlayPath) return { ok: false, reason: '라이브 소스 리로드가 활성화되어 있지 않습니다.' };
    if (!this.isJavaAutoBuildEnabled()) return { ok: false, reason: '"tomcat.javaAutoBuild" 설정이 꺼져 있습니다.' };

    const projectRoot = findProjectRoot(app.sourceOverlayPath) ?? findProjectRoot(app.sourcePath);
    if (!projectRoot) return { ok: false, reason: 'Maven/Gradle 프로젝트 루트(pom.xml/build.gradle)를 찾지 못했습니다.' };

    const buildInfo = detectBuildInfo(projectRoot);
    if (!buildInfo) return { ok: false, reason: 'Maven/Gradle 프로젝트 정보를 감지하지 못했습니다.' };

    let watcher = this.buildWatchers.get(this.syncKey(serverId, contextPath));
    if (!watcher) {
      const outputChannel = this.running.get(serverId)?.outputChannel;
      const classesTargetDir = path.join(app.sourcePath, 'WEB-INF', 'classes');
      watcher = new JavaBuildSyncWatcher(buildInfo, classesTargetDir, msg => outputChannel?.appendLine(msg));
      watcher.start();
      this.buildWatchers.set(this.syncKey(serverId, contextPath), watcher);
    }

    const success = await watcher.buildOnce();
    return { ok: success };
  }

  /**
   * If class-sync is enabled and `overlayPath`/`docBase` sit inside a detectable Maven/Gradle
   * project, starts (or restarts) a watcher that mirrors that project's compiled-output
   * folder(s) into `docBase/WEB-INF/classes` live (see JavaBuildSyncWatcher - no build is
   * ever run by this extension). Silently does nothing if disabled or no project could be
   * detected (e.g. a hand-picked, non-standard overlay path). When `runInitialSync` is true,
   * waits for one immediate resync before returning (used right before Tomcat starts, so it
   * boots against whatever's currently built).
   */
  private async maybeStartJavaBuildSync(
    serverId: string,
    contextPath: string,
    docBase: string,
    overlayPath: string,
    runInitialSync = false,
    outputChannelOverride?: vscode.OutputChannel
  ): Promise<void> {
    this.stopJavaBuildSync(serverId, contextPath);
    if (!this.isJavaAutoBuildEnabled()) return;

    const projectRoot = findProjectRoot(overlayPath) ?? findProjectRoot(docBase);
    if (!projectRoot) return;

    const buildInfo = detectBuildInfo(projectRoot);
    if (!buildInfo) return;

    const outputChannel = outputChannelOverride ?? this.running.get(serverId)?.outputChannel;
    const classesTargetDir = path.join(docBase, 'WEB-INF', 'classes');
    const watcher = new JavaBuildSyncWatcher(buildInfo, classesTargetDir, msg => outputChannel?.appendLine(msg));
    watcher.start();
    this.buildWatchers.set(this.syncKey(serverId, contextPath), watcher);

    if (runInitialSync) {
      await watcher.buildOnce();
    }
  }

  // ---------- detection helpers ----------

  private getCatalinaScript(homePath: string): string {
    const isWin = process.platform === 'win32';
    return path.join(homePath, 'bin', isWin ? 'catalina.bat' : 'catalina.sh');
  }

  private detectHttpPort(homePath: string): number | undefined {
    try {
      const serverXml = fs.readFileSync(path.join(homePath, 'conf', 'server.xml'), 'utf8');
      const match = serverXml.match(/<Connector[^>]*\bport="(\d+)"[^>]*protocol="HTTP\/1\.1"/);
      if (match) return parseInt(match[1], 10);
      const fallback = serverXml.match(/<Connector[^>]*\bport="(\d+)"/);
      if (fallback) return parseInt(fallback[1], 10);
    } catch {
      // ignore, use default
    }
    return undefined;
  }

  /**
   * Rewrites the relevant `.level` entries in <CATALINA_HOME>/conf/logging.properties so the
   * server logs at the requested java.util.logging level (root logger + JULI file/console
   * handlers). Missing keys are appended; existing ones are updated in place.
   */
  private applyLogLevel(homePath: string, level: string) {
    const logPropsPath = path.join(homePath, 'conf', 'logging.properties');
    if (!fs.existsSync(logPropsPath)) return;

    try {
      let content = fs.readFileSync(logPropsPath, 'utf8');

      const keys = [
        '.level',
        'java.util.logging.ConsoleHandler.level',
        '1catalina.org.apache.juli.AsyncFileHandler.level',
        '2localhost.org.apache.juli.AsyncFileHandler.level',
        '3manager.org.apache.juli.AsyncFileHandler.level',
        '4host-manager.org.apache.juli.AsyncFileHandler.level'
      ];

      for (const key of keys) {
        const re = new RegExp(`^${escapeRegex(key)}\\s*=.*$`, 'm');
        if (re.test(content)) {
          content = content.replace(re, `${key} = ${level}`);
        } else {
          content += `${content.endsWith('\n') ? '' : '\n'}${key} = ${level}\n`;
        }
      }

      fs.writeFileSync(logPropsPath, content, 'utf8');
    } catch {
      // Non-fatal: if we can't patch logging.properties, Tomcat just uses its existing config.
    }
  }

  /**
   * Adds a `deployIgnore` attribute to the <Host name="localhost"> element in conf/server.xml
   * so Tomcat's own bundled ROOT/docs/examples/host-manager webapps are skipped entirely by
   * auto-deployment (both at startup and by the periodic background scan) - only your own
   * app(s) actually run. The Manager app is deliberately left out of the ignore list since
   * "Reload Context Now" depends on it. Never overwrites an existing deployIgnore the user
   * may have already customized by hand.
   */
  private applyDeployIgnore(homePath: string, outputChannel?: vscode.OutputChannel) {
    const serverXmlPath = path.join(homePath, 'conf', 'server.xml');
    if (!fs.existsSync(serverXmlPath)) return;

    try {
      let content = fs.readFileSync(serverXmlPath, 'utf8');
      const hostTagMatch = content.match(/<Host\b[^>]*\bname="localhost"[^>]*>/);
      if (!hostTagMatch) return;

      const hostTag = hostTagMatch[0];
      if (/\bdeployIgnore\s*=/.test(hostTag)) {
        return; // already customized by the user (or a previous run) - leave it alone
      }

      const ignorePattern = '^(ROOT|docs|examples|host-manager)$';
      const newHostTag = hostTag.replace(/>$/, ` deployIgnore="${ignorePattern}">`);
      content = content.replace(hostTag, newHostTag);
      fs.writeFileSync(serverXmlPath, content, 'utf8');
      outputChannel?.appendLine(
        '[Tomcat] Excluding default webapps (ROOT/docs/examples/host-manager) from auto-deploy.'
      );
    } catch (err) {
      outputChannel?.appendLine(`[Tomcat] Failed to apply deployIgnore: ${err}`);
    }
  }

  // ---------- lifecycle ----------

  async start(id: string, debug: boolean): Promise<void> {
    const server = this.getServer(id);
    if (!server) return;
    if (this.running.has(id)) {
      vscode.window.showInformationMessage(`${server.name} 은(는) 이미 실행 중입니다.`);
      return;
    }

    const script = this.getCatalinaScript(server.homePath);
    if (process.platform !== 'win32') {
      try {
        fs.chmodSync(script, 0o755);
      } catch {
        // ignore permission errors
      }
    }

    const outputChannel = vscode.window.createOutputChannel(`Tomcat: ${server.name}`);
    outputChannel.clear();
    outputChannel.show(true);
    outputChannel.appendLine(`[Tomcat] Preparing to start ${server.name}...`);

    if (this.isExcludeDefaultWebappsEnabled()) {
      this.applyDeployIgnore(server.homePath, outputChannel);
    }

    // Start (or refresh) live source-link watchers for any exploded app with an overlay
    // configured, and sync whatever's currently in the Maven/Gradle output folder(s) into
    // WEB-INF/classes right now, so Tomcat boots against up-to-date classes/resources. No
    // build is run here - only whatever's already been compiled (by VSCode's Java language
    // server, a manual mvn/gradle build, etc.) gets copied over.
    const presyncTasks: Promise<void>[] = [];
    for (const app of server.deployedApps) {
      if (app.type === 'exploded' && app.sourceOverlayPath) {
        this.startSourceSync(id, app.contextPath, app.sourceOverlayPath, app.sourcePath);
        presyncTasks.push(
          this.maybeStartJavaBuildSync(id, app.contextPath, app.sourcePath, app.sourceOverlayPath, true, outputChannel)
        );
      }
    }
    if (presyncTasks.length > 0) {
      outputChannel.appendLine('[Tomcat] Syncing compiled classes/resources for Maven/Gradle app(s)...');
      await Promise.all(presyncTasks);
    }

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      CATALINA_HOME: server.homePath,
      CATALINA_BASE: server.homePath
    };

    if (server.javaHome) {
      env.JAVA_HOME = server.javaHome;
      const javaBin = path.join(server.javaHome, 'bin');
      env.PATH = `${javaBin}${path.delimiter}${env.PATH ?? ''}`;
    }

    if (server.vmOptions && server.vmOptions.trim()) {
      env.CATALINA_OPTS = [env.CATALINA_OPTS, server.vmOptions.trim()].filter(Boolean).join(' ');
    }

    const effectiveLogLevel = server.logLevel ?? this.getDefaultLogLevel();
    this.applyLogLevel(server.homePath, effectiveLogLevel);

    const args = ['run'];
    if (debug) {
      env.JPDA_ADDRESS = String(server.debugPort);
      env.JPDA_TRANSPORT = 'dt_socket';
      args.unshift('jpda');
    }

    outputChannel.appendLine(`[Tomcat] Starting ${server.name} (${debug ? 'debug' : 'run'}) using ${script} ${args.join(' ')}`);
    outputChannel.appendLine(`[Tomcat] JAVA_HOME = ${env.JAVA_HOME ?? '(system default)'}`);
    outputChannel.appendLine(`[Tomcat] Log level = ${effectiveLogLevel}`);
    outputChannel.appendLine(`[Tomcat] CATALINA_OPTS = ${env.CATALINA_OPTS ?? '(none)'}`);

    const proc = spawn(script, args, {
      env,
      cwd: server.homePath,
      detached: process.platform !== 'win32',
      shell: process.platform === 'win32'
    });

    const info: RunningInfo = { proc, status: 'starting', outputChannel };
    this.running.set(id, info);
    this._onDidChange.fire();

    proc.stdout.on('data', (d: Buffer) => {
      const text = d.toString();
      outputChannel.append(text);
      if (/Server startup in/.test(text) || /INFO.*Starting ProtocolHandler/.test(text)) {
        info.status = debug ? 'debugging' : 'running';
        this._onDidChange.fire();
        if (debug) {
          this.attachDebugger(server);
        }
      }
    });

    proc.stderr.on('data', (d: Buffer) => {
      outputChannel.append(d.toString());
    });

    proc.on('exit', (code) => {
      outputChannel.appendLine(`\n[Tomcat] Process exited with code ${code}`);
      this.running.delete(id);
      this.stopAllSyncForServer(id);
      this._onDidChange.fire();
    });

    proc.on('error', (err) => {
      outputChannel.appendLine(`\n[Tomcat] Failed to start: ${err.message}`);
      vscode.window.showErrorMessage(`Tomcat 시작 실패: ${err.message}`);
      this.running.delete(id);
      this.stopAllSyncForServer(id);
      this._onDidChange.fire();
    });

    // Safety net: if we never see the startup banner within 20s, assume running.
    setTimeout(() => {
      if (info.status === 'starting') {
        info.status = debug ? 'debugging' : 'running';
        this._onDidChange.fire();
      }
    }, 20000);
  }

  private async attachDebugger(server: TomcatServerConfig) {
    const debugConfig: vscode.DebugConfiguration = {
      type: 'java',
      name: `Attach to ${server.name}`,
      request: 'attach',
      hostName: 'localhost',
      port: server.debugPort
    };
    try {
      await vscode.debug.startDebugging(undefined, debugConfig);
    } catch (err: any) {
      vscode.window.showWarningMessage(
        `Java 디버거 연결 실패 (Debugger for Java 확장이 설치되어 있는지 확인하세요): ${err?.message ?? err}`
      );
    }
  }

  async stop(id: string): Promise<void> {
    const server = this.getServer(id);
    const info = this.running.get(id);
    if (!server || !info) return;

    info.status = 'stopping';
    this._onDidChange.fire();
    info.outputChannel.appendLine('\n[Tomcat] Stopping...');

    const pid = info.proc.pid;
    const exited = new Promise<void>(resolve => {
      info.proc.once('exit', () => resolve());
    });

    const sendSignal = (signal: 'SIGTERM' | 'SIGKILL' | 'force') => {
      try {
        if (process.platform === 'win32') {
          spawn('taskkill', ['/pid', String(pid), '/T', '/F']);
        } else if (pid) {
          // negative pid targets the whole process group (spawned with detached:true)
          process.kill(-pid, signal === 'force' ? 'SIGKILL' : signal);
        }
      } catch {
        // process may already be gone
      }
    };

    sendSignal('SIGTERM');

    const gracePeriod = new Promise<void>(resolve => setTimeout(resolve, 8000));
    await Promise.race([exited, gracePeriod]);

    if (this.running.has(id)) {
      info.outputChannel.appendLine('[Tomcat] Still running after grace period, forcing kill...');
      sendSignal('force');
      await Promise.race([exited, new Promise<void>(resolve => setTimeout(resolve, 3000))]);
    }
  }

  /**
   * Best-effort shutdown of every currently running server, used when the extension is
   * deactivated (e.g. VSCode window/app closing) so Tomcat processes don't linger as
   * orphans. Sends SIGTERM (which Catalina's JVM shutdown hook picks up) to every running
   * server in parallel and waits briefly for them to exit, without the long per-server
   * grace periods used by stop() - the extension host only gives a short window on shutdown.
   */
  async stopAllForShutdown(): Promise<void> {
    const entries = Array.from(this.running.entries());
    if (entries.length === 0) return;

    entries.forEach(([, info]) => {
      const pid = info.proc.pid;
      try {
        if (process.platform === 'win32') {
          spawn('taskkill', ['/pid', String(pid), '/T', '/F']);
        } else if (pid) {
          process.kill(-pid, 'SIGTERM');
        }
      } catch {
        // ignore
      }
    });

    const allExited = Promise.all(
      entries.map(([, info]) => new Promise<void>(resolve => info.proc.once('exit', () => resolve())))
    );
    await Promise.race([allExited, new Promise<void>(resolve => setTimeout(resolve, 3000))]);

    // Belt-and-braces: make sure no sync/build watchers are left running regardless of
    // whether the process 'exit' events above fired in time.
    for (const w of this.syncWatchers.values()) {
      w.stop();
    }
    this.syncWatchers.clear();
    for (const w of this.buildWatchers.values()) {
      w.stop();
    }
    this.buildWatchers.clear();
  }

  async restart(id: string, debug: boolean): Promise<void> {
    if (this.running.has(id)) {
      await this.stop(id);
    }
    await this.start(id, debug);
  }

  getOutputChannel(id: string): vscode.OutputChannel | undefined {
    return this.running.get(id)?.outputChannel;
  }

  // ---------- deployment ----------

  async deployWar(id: string, warPath: string, contextPath?: string): Promise<void> {
    const server = this.getServer(id);
    if (!server) return;

    const appName = contextPath ?? path.basename(warPath, '.war');
    const destDir = path.join(server.homePath, 'webapps');
    fs.mkdirSync(destDir, { recursive: true });
    const dest = path.join(destDir, `${appName}.war`);
    fs.copyFileSync(warPath, dest);

    await this.registerDeployedApp(server, {
      contextPath: `/${appName}`,
      sourcePath: dest,
      type: 'war'
    });
  }

  async deployExploded(
    id: string,
    folderPath: string,
    contextPath?: string,
    extraAttributes?: Record<string, string>,
    innerXml?: string,
    sourceOverlayPath?: string,
    reloadable?: boolean
  ): Promise<void> {
    const server = this.getServer(id);
    if (!server) return;

    const appName = (contextPath ?? path.basename(folderPath)).replace(/^\/+/, '');
    const confDir = path.join(server.homePath, 'conf', 'Catalina', 'localhost');
    fs.mkdirSync(confDir, { recursive: true });

    const xmlName = appName === '' || appName.toUpperCase() === 'ROOT' ? 'ROOT.xml' : `${appName}.xml`;
    const contextXmlPath = path.join(confDir, xmlName);
    const resolvedPath = `/${appName === 'ROOT' ? '' : appName}`;
    // Live reload defaults reloadable to false (see setSourceOverlay for the full rationale);
    // an explicit choice always wins over that default.
    const effectiveReloadable = reloadable ?? (sourceOverlayPath ? false : true);
    const xml = this.buildContextXml(
      folderPath.replace(/\\/g, '/'),
      resolvedPath,
      extraAttributes,
      innerXml,
      effectiveReloadable ? 'true' : 'false'
    );
    fs.writeFileSync(contextXmlPath, xml, 'utf8');

    await this.registerDeployedApp(server, {
      contextPath: resolvedPath,
      sourcePath: folderPath,
      type: 'exploded',
      sourceOverlayPath,
      contextExtraAttributes: extraAttributes,
      contextInnerXml: innerXml,
      reloadable: effectiveReloadable
    });

    if (sourceOverlayPath) {
      this.startSourceSync(id, resolvedPath, sourceOverlayPath, folderPath);
      await this.maybeStartJavaBuildSync(id, resolvedPath, folderPath, sourceOverlayPath, true);
    }
  }

  /**
   * Enables/updates/disables the live source-sync overlay (see sourceSync.ts) for an
   * already-deployed exploded app. docBase/path stay exactly as originally deployed; this
   * starts/stops a background watcher that mirrors file changes from `overlayPath` into the
   * app's docBase, plus (if enabled and a Maven/Gradle project is detected) a watcher that
   * mirrors compiled classes/resources into WEB-INF/classes. Regenerates the app's
   * context.xml (no <Resources> block - see the class-level notes on why the old
   * <Resources><PreResources> overlay approach was replaced), reusing any
   * `<Resource>`/`<Environment>`/etc. originally detected from the app's own
   * META-INF/context.xml (`app.contextExtraAttributes`/`contextInnerXml`) so toggling live
   * reload never silently drops a JNDI DataSource or similar.
   *
   * `reloadable` lets the caller explicitly choose Tomcat's auto-reload-on-class-change
   * behavior for this app; if omitted, keeps whatever was previously set (or - for a first
   * time enable with no prior value - defaults to false while the overlay is on). See the
   * tradeoff explained on the DeployedApp.reloadable field: true reflects every class change
   * automatically but tears down and rebuilds the whole context every time; false relies on
   * an attached Java debugger's hot-swap for simple changes (silent, instant, no state loss)
   * and needs a manual "Reload Context Now" for anything hot-swap can't handle - which is
   * only actually useful if you're routinely running with a debugger attached. If you mostly
   * run without one, `reloadable: true` is usually the better choice despite the heavier
   * per-change reload, since otherwise nothing reflects automatically at all.
   */
  async setSourceOverlay(
    id: string,
    contextPath: string,
    overlayPath: string | undefined,
    reloadable?: boolean
  ): Promise<void> {
    const server = this.getServer(id);
    if (!server) return;
    const app = server.deployedApps.find(a => a.contextPath === contextPath);
    if (!app || app.type !== 'exploded') return;

    const effectiveReloadable = reloadable ?? app.reloadable ?? (overlayPath ? false : true);

    const appName = contextPath === '/' ? 'ROOT' : contextPath.replace(/^\/+/, '');
    const xmlName = appName === 'ROOT' ? 'ROOT.xml' : `${appName}.xml`;
    const contextXmlPath = path.join(server.homePath, 'conf', 'Catalina', 'localhost', xmlName);
    const xml = this.buildContextXml(
      app.sourcePath.replace(/\\/g, '/'),
      contextPath,
      app.contextExtraAttributes,
      app.contextInnerXml,
      effectiveReloadable ? 'true' : 'false'
    );
    fs.writeFileSync(contextXmlPath, xml, 'utf8');

    app.sourceOverlayPath = overlayPath;
    app.reloadable = effectiveReloadable;
    await this.save();

    if (overlayPath) {
      this.startSourceSync(id, contextPath, overlayPath, app.sourcePath);
      await this.maybeStartJavaBuildSync(id, contextPath, app.sourcePath, overlayPath, true);
    } else {
      this.stopSourceSync(id, contextPath);
      this.stopJavaBuildSync(id, contextPath);
    }
  }

  private buildContextXml(
    docBase: string,
    contextPath: string,
    extraAttributes?: Record<string, string>,
    innerXml?: string,
    defaultReloadable: 'true' | 'false' = 'true'
  ): string {
    // path/docBase always come from us; caller-supplied attributes (from a detected
    // META-INF/context.xml) can override defaults like `reloadable`.
    const attrs: Record<string, string> = {
      path: contextPath,
      docBase,
      reloadable: defaultReloadable,
      ...(extraAttributes ?? {})
    };
    delete attrs['docBase'];
    delete attrs['path'];

    const attrStr = [`path="${escapeXmlAttr(contextPath)}"`, `docBase="${escapeXmlAttr(docBase)}"`]
      .concat(Object.entries(attrs).map(([k, v]) => `${k}="${escapeXmlAttr(v)}"`))
      .join(' ');

    const body = (innerXml ?? '').trim();
    if (body) {
      return `<?xml version="1.0" encoding="UTF-8"?>\n<Context ${attrStr}>\n${body}\n</Context>\n`;
    }
    return `<?xml version="1.0" encoding="UTF-8"?>\n<Context ${attrStr} />\n`;
  }

  private async registerDeployedApp(server: TomcatServerConfig, app: DeployedApp) {
    server.deployedApps = server.deployedApps.filter(a => a.contextPath !== app.contextPath);
    server.deployedApps.push(app);
    await this.save();
  }

  async undeploy(id: string, contextPath: string): Promise<void> {
    const server = this.getServer(id);
    if (!server) return;
    const app = server.deployedApps.find(a => a.contextPath === contextPath);
    if (!app) return;

    this.stopSourceSync(id, contextPath);
    this.stopJavaBuildSync(id, contextPath);

    try {
      if (app.type === 'war') {
        if (fs.existsSync(app.sourcePath)) fs.unlinkSync(app.sourcePath);
        const explodedDir = app.sourcePath.replace(/\.war$/, '');
        if (fs.existsSync(explodedDir)) fs.rmSync(explodedDir, { recursive: true, force: true });
      } else {
        const appName = contextPath === '/' ? 'ROOT' : contextPath.replace(/^\/+/, '');
        const xmlName = appName === 'ROOT' ? 'ROOT.xml' : `${appName}.xml`;
        const contextXmlPath = path.join(server.homePath, 'conf', 'Catalina', 'localhost', xmlName);
        if (fs.existsSync(contextXmlPath)) fs.unlinkSync(contextXmlPath);
      }
    } catch (err: any) {
      vscode.window.showWarningMessage(`Undeploy 중 일부 파일을 제거하지 못했습니다: ${err?.message ?? err}`);
    }

    server.deployedApps = server.deployedApps.filter(a => a.contextPath !== contextPath);
    await this.save();
  }

  getAppUrl(server: TomcatServerConfig, app: DeployedApp): string {
    return `http://localhost:${server.httpPort}${app.contextPath}/`;
  }
}
