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

  private getMavenCommand(): string {
    return vscode.workspace.getConfiguration(CONFIG_SECTION).get<string>('mavenCommand', 'mvn');
  }

  private getGradleCommand(): string {
    return vscode.workspace.getConfiguration(CONFIG_SECTION).get<string>('gradleCommand', 'gradle');
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
   * If Java auto-build is enabled and `overlayPath`/`docBase` sit inside a detectable
   * Maven/Gradle project, starts (or restarts) a watcher that recompiles Java changes and
   * syncs the result into `docBase/WEB-INF/classes`. Silently does nothing if auto-build is
   * disabled or no project could be detected (e.g. a hand-picked, non-standard overlay path).
   */
  private maybeStartJavaBuildSync(serverId: string, contextPath: string, docBase: string, overlayPath: string) {
    this.stopJavaBuildSync(serverId, contextPath);
    if (!this.isJavaAutoBuildEnabled()) return;

    const projectRoot = findProjectRoot(overlayPath) ?? findProjectRoot(docBase);
    if (!projectRoot) return;

    const buildInfo = detectBuildInfo(projectRoot, this.getMavenCommand(), this.getGradleCommand());
    if (!buildInfo) return;

    const outputChannel = this.running.get(serverId)?.outputChannel;
    const classesTargetDir = path.join(docBase, 'WEB-INF', 'classes');
    const watcher = new JavaBuildSyncWatcher(buildInfo, classesTargetDir, msg => outputChannel?.appendLine(msg));
    watcher.start();
    this.buildWatchers.set(this.syncKey(serverId, contextPath), watcher);
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

    const outputChannel = vscode.window.createOutputChannel(`Tomcat: ${server.name}`);
    outputChannel.clear();
    outputChannel.show(true);
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

    // Start (or refresh) live source-sync watchers for any exploded app with an overlay
    // configured, so docBase is up to date before/while Tomcat deploys it. Also kicks off
    // Java/resource auto-compile watching for Maven/Gradle projects, if enabled.
    for (const app of server.deployedApps) {
      if (app.type === 'exploded' && app.sourceOverlayPath) {
        this.startSourceSync(id, app.contextPath, app.sourceOverlayPath, app.sourcePath);
        this.maybeStartJavaBuildSync(id, app.contextPath, app.sourcePath, app.sourceOverlayPath);
      }
    }

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
    sourceOverlayPath?: string
  ): Promise<void> {
    const server = this.getServer(id);
    if (!server) return;

    const appName = (contextPath ?? path.basename(folderPath)).replace(/^\/+/, '');
    const confDir = path.join(server.homePath, 'conf', 'Catalina', 'localhost');
    fs.mkdirSync(confDir, { recursive: true });

    const xmlName = appName === '' || appName.toUpperCase() === 'ROOT' ? 'ROOT.xml' : `${appName}.xml`;
    const contextXmlPath = path.join(confDir, xmlName);
    const resolvedPath = `/${appName === 'ROOT' ? '' : appName}`;
    const xml = this.buildContextXml(folderPath.replace(/\\/g, '/'), resolvedPath, extraAttributes, innerXml);
    fs.writeFileSync(contextXmlPath, xml, 'utf8');

    await this.registerDeployedApp(server, {
      contextPath: resolvedPath,
      sourcePath: folderPath,
      type: 'exploded',
      sourceOverlayPath
    });

    if (sourceOverlayPath) {
      this.startSourceSync(id, resolvedPath, sourceOverlayPath, folderPath);
      this.maybeStartJavaBuildSync(id, resolvedPath, folderPath, sourceOverlayPath);
    }
  }

  /**
   * Enables/updates/disables the live source-sync overlay (see sourceSync.ts) for an
   * already-deployed exploded app. docBase/path stay exactly as originally deployed; this
   * starts/stops a background watcher that mirrors file changes from `overlayPath` into the
   * app's docBase, plus (if enabled and a Maven/Gradle project is detected) a watcher that
   * auto-compiles Java/resource changes into WEB-INF/classes. Also regenerates the app's
   * context.xml as a plain (no <Resources>) file, which cleans up any leftover
   * <Resources><PreResources> block from older versions of this extension that used Tomcat's
   * Resources-overlay mechanism (that approach hit a NullPointerException on some Tomcat
   * 8.0.x builds - see DirResourceSet - so it was replaced with this file-sync approach,
   * which works identically on any Tomcat version).
   */
  async setSourceOverlay(id: string, contextPath: string, overlayPath: string | undefined): Promise<void> {
    const server = this.getServer(id);
    if (!server) return;
    const app = server.deployedApps.find(a => a.contextPath === contextPath);
    if (!app || app.type !== 'exploded') return;

    const appName = contextPath === '/' ? 'ROOT' : contextPath.replace(/^\/+/, '');
    const xmlName = appName === 'ROOT' ? 'ROOT.xml' : `${appName}.xml`;
    const contextXmlPath = path.join(server.homePath, 'conf', 'Catalina', 'localhost', xmlName);
    const xml = this.buildContextXml(app.sourcePath.replace(/\\/g, '/'), contextPath);
    fs.writeFileSync(contextXmlPath, xml, 'utf8');

    app.sourceOverlayPath = overlayPath;
    await this.save();

    if (overlayPath) {
      this.startSourceSync(id, contextPath, overlayPath, app.sourcePath);
      this.maybeStartJavaBuildSync(id, contextPath, app.sourcePath, overlayPath);
    } else {
      this.stopSourceSync(id, contextPath);
      this.stopJavaBuildSync(id, contextPath);
    }
  }

  private buildContextXml(
    docBase: string,
    contextPath: string,
    extraAttributes?: Record<string, string>,
    innerXml?: string
  ): string {
    // path/docBase always come from us; caller-supplied attributes (from a detected
    // META-INF/context.xml) can override defaults like `reloadable`.
    const attrs: Record<string, string> = {
      path: contextPath,
      docBase,
      reloadable: 'true',
      ...(extraAttributes ?? {})
    };
    delete attrs['docBase'];
    delete attrs['path'];

    const attrStr = [`path="${contextPath}"`, `docBase="${docBase}"`]
      .concat(Object.entries(attrs).map(([k, v]) => `${k}="${v}"`))
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
