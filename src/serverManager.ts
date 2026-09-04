import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { spawn, ChildProcessWithoutNullStreams } from 'child_process';
import {
  TomcatServerConfig,
  DeployedApp,
  ServerStatus,
  AppStatus,
  DEFAULT_HTTP_PORT,
  DEFAULT_DEBUG_PORT
} from './model';
import { SourceSyncWatcher, SyncTrigger } from './sourceSync';
import { JavaBuildSyncWatcher } from './javaBuildSync';
import { findProjectRoot, detectBuildInfo } from './sourceOverlay';
import { runBuildOnce } from './buildRunner';

const CONFIG_SECTION = 'tomcat';
const CONFIG_KEY = 'servers';
/** Legacy globalState key used before servers were moved into VSCode settings. */
const LEGACY_STORAGE_KEY = 'tomcat.servers';

interface RunningInfo {
  proc: ChildProcessWithoutNullStreams;
  status: ServerStatus;
  outputChannel: vscode.OutputChannel;
  /** key: app contextPath (e.g. "/myapp", "/" for ROOT) - per-app deployment status, tracked
   *  separately from the server's own `status` so the tree can show each app's real state
   *  instead of just mirroring the server. */
  appStatus: Map<string, AppStatus>;
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
  // Server ids currently between start() being invoked and the child process actually being
  // spawned (registered into `running`). Covers the gap where output-channel setup, deploy-
  // ignore file writes, and - for apps with live source sync - a full pre-start Maven/Gradle
  // build can all run before there's a real process to track. Without this, getStatus() would
  // keep reporting 'stopped' during that whole window: the tree wouldn't show "starting" and
  // the `running.has(id)` double-start guard wouldn't catch a second click yet either, so a
  // fast double-click (encouraged by that exact lack of visible feedback) could spawn two
  // Tomcat processes for the same server.
  private startingIds = new Set<string>();
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

  /** When live-sync (JSP/static files and compiled classes) actually gets copied through to
   *  the deployed app: 'onChange' (default) shortly after each save, or 'onWindowBlur' - not
   *  until VSCode's own window loses focus (see flushAllPendingSyncs, called from
   *  extension.ts's vscode.window.onDidChangeWindowState listener). */
  getSyncTrigger(): SyncTrigger {
    return vscode.workspace.getConfiguration(CONFIG_SECTION).get<SyncTrigger>('syncTrigger', 'onChange');
  }

  /** Flushes every currently-active sync watcher (both JSP/static and compiled-class) right
   *  now, regardless of their individual debounce timers. The only thing that actually
   *  applies a pending change in 'onWindowBlur' trigger mode - called whenever the VSCode
   *  window loses focus. A no-op for any watcher that has nothing pending, so it's always
   *  safe to call this unconditionally rather than tracking which servers are in which mode. */
  flushAllPendingSyncs(): void {
    for (const watcher of this.syncWatchers.values()) watcher.flushNow();
    for (const watcher of this.buildWatchers.values()) watcher.flushNow();
  }

  /** Same as flushAllPendingSyncs(), but scoped to one server. Used before the hot-swap-
   *  failure fallback issues a "Reload Context Now" - that reload just re-reads whatever
   *  bytes currently sit in WEB-INF/classes, so if `syncTrigger` is 'onWindowBlur' and the
   *  window never lost focus yet, the reload would otherwise silently pick up the *old*
   *  class and look like the structural change (new field/method/class) never applied. */
  flushPendingSyncsForServer(serverId: string): void {
    const prefix = `${serverId}::`;
    for (const [key, watcher] of this.syncWatchers) {
      if (key.startsWith(prefix)) watcher.flushNow();
    }
    for (const [key, watcher] of this.buildWatchers) {
      if (key.startsWith(prefix)) watcher.flushNow();
    }
  }

  /** Whether attaching the Java debugger should steal focus to the Debug Console panel.
   *  Defaults to 'neverOpen' so our Output tab (where start/deploy messages are printed)
   *  isn't yanked away the moment the debugger attaches. */
  getDebugInternalConsoleOptions(): 'neverOpen' | 'openOnSessionStart' | 'openOnFirstSessionStart' {
    return vscode.workspace
      .getConfiguration(CONFIG_SECTION)
      .get<'neverOpen' | 'openOnSessionStart' | 'openOnFirstSessionStart'>(
        'debug.internalConsoleOptions',
        'neverOpen'
      );
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

  /** Whether to run the project's compile command once, right before Tomcat starts, for any
   *  exploded app with live reload enabled on a detected Maven/Gradle project. */
  isBuildBeforeStartEnabled(): boolean {
    return vscode.workspace.getConfiguration(CONFIG_SECTION).get<boolean>('buildBeforeStart', true);
  }

  getMavenCommand(): string {
    return vscode.workspace.getConfiguration(CONFIG_SECTION).get<string>('mavenCommand', 'mvn');
  }

  getGradleCommand(): string {
    return vscode.workspace.getConfiguration(CONFIG_SECTION).get<string>('gradleCommand', 'gradle');
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
    if (this.startingIds.has(id)) return 'starting';
    return this.running.get(id)?.status ?? 'stopped';
  }

  /** Per-app status. Falls back to 'stopped' whenever the server itself has no running entry
   *  (not started yet, or already stopped/exited) or the app was deployed after the server
   *  process launched and hasn't been through a start() cycle's tracking yet. */
  getAppStatus(id: string, contextPath: string): AppStatus {
    return this.running.get(id)?.appStatus.get(contextPath) ?? 'stopped';
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

  /** Which of this server's live-synced apps actually had a class file change within the
   *  last `withinMs` ms, per that app's JavaBuildSyncWatcher. Used so a hot-swap-failure
   *  fallback reload only touches the app(s) whose code just changed instead of every
   *  live-synced app on the server - a save only ever recompiles the project(s) you edited. */
  getRecentlyChangedApps(serverId: string, withinMs: number): string[] {
    const now = Date.now();
    const prefix = `${serverId}::`;
    const result: string[] = [];
    for (const [key, watcher] of this.buildWatchers) {
      if (!key.startsWith(prefix)) continue;
      const lastSyncAt = watcher.getLastSyncAt();
      if (lastSyncAt !== undefined && now - lastSyncAt <= withinMs) {
        result.push(key.slice(prefix.length));
      }
    }
    return result;
  }

  private startSourceSync(
    serverId: string,
    contextPath: string,
    overlayPath: string,
    docBase: string,
    outputChannelOverride?: vscode.OutputChannel
  ) {
    this.stopSourceSync(serverId, contextPath);
    // this.running.get(serverId) isn't populated yet during the initial doStart() call site
    // (this runs before `this.running.set(id, info)`, same reason maybeStartJavaBuildSync
    // takes an explicit outputChannel param instead of looking it up the same way) - without
    // outputChannelOverride, that lookup silently returns undefined and this watcher's logger
    // permanently never prints anything again for its whole lifetime, even though the actual
    // file copying works fine. The other two callers (already-running server) don't need to
    // pass this - the lookup works correctly for them.
    const outputChannel = outputChannelOverride ?? this.running.get(serverId)?.outputChannel;
    const watcher = new SourceSyncWatcher(overlayPath, docBase, msg => outputChannel?.appendLine(msg), this.getSyncTrigger());
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
   * Manually runs the project's actual compile command once (unlike forceResyncClasses,
   * which only re-copies whatever's already built) for a deployed exploded app with live
   * reload on, then syncs the result into WEB-INF/classes. Reuses the exact same Maven/Gradle
   * detection and build-running logic as tomcat.buildBeforeStart (buildRunner.ts /
   * detectBuildInfo), so it works transparently for either build tool - no reason to special
   * case Maven only when Gradle projects get the same detection for free.
   */
  async buildNow(serverId: string, contextPath: string): Promise<{ ok: boolean; reason?: string }> {
    const server = this.getServer(serverId);
    if (!server) return { ok: false, reason: '서버를 찾을 수 없습니다.' };
    const app = server.deployedApps.find(a => a.contextPath === contextPath);
    if (!app || app.type !== 'exploded') return { ok: false, reason: 'exploded 배포가 아닙니다.' };
    if (!app.sourceOverlayPath) return { ok: false, reason: '라이브 소스 리로드가 활성화되어 있지 않습니다.' };

    const projectRoot = findProjectRoot(app.sourceOverlayPath) ?? findProjectRoot(app.sourcePath);
    if (!projectRoot) return { ok: false, reason: 'Maven/Gradle 프로젝트 루트(pom.xml/build.gradle)를 찾지 못했습니다.' };

    const buildInfo = detectBuildInfo(projectRoot);
    if (!buildInfo) return { ok: false, reason: 'Maven/Gradle 프로젝트 정보를 감지하지 못했습니다.' };

    const outputChannel = this.running.get(serverId)?.outputChannel;
    outputChannel?.show(true);
    const result = await runBuildOnce(buildInfo, {
      mavenCommand: this.getMavenCommand(),
      gradleCommand: this.getGradleCommand(),
      javaHome: server.javaHome,
      log: msg => outputChannel?.appendLine(msg)
    });
    if (!result.ok) {
      return { ok: false, reason: result.message ? `빌드 실패: ${result.message}` : '빌드가 실패했습니다.' };
    }

    await this.forceResyncClasses(serverId, contextPath);
    return { ok: true };
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
      watcher = new JavaBuildSyncWatcher(buildInfo, classesTargetDir, msg => outputChannel?.appendLine(msg), this.getSyncTrigger());
      watcher.start();
      this.buildWatchers.set(this.syncKey(serverId, contextPath), watcher);
    }

    const success = await watcher.buildOnce();
    return { ok: success };
  }

  /**
   * If `tomcat.buildBeforeStart` is enabled and `overlayPath`/`docBase` sit inside a
   * detectable Maven/Gradle project, runs that project's compile command once (using this
   * server's configured Java Home, so it always matches whatever JDK actually runs Tomcat)
   * and waits for it to finish before returning. Silently does nothing if disabled or no
   * project could be detected. Never throws - a build failure is logged to the server's
   * output channel and otherwise ignored, so it can never prevent Tomcat itself from
   * starting; the point is "best-effort freshness", not a hard gate.
   */
  private async maybeRunBuildBeforeStart(
    server: TomcatServerConfig,
    overlayPath: string,
    docBase: string,
    outputChannel: vscode.OutputChannel
  ): Promise<void> {
    if (!this.isBuildBeforeStartEnabled()) return;

    const projectRoot = findProjectRoot(overlayPath) ?? findProjectRoot(docBase);
    if (!projectRoot) return;

    const buildInfo = detectBuildInfo(projectRoot);
    if (!buildInfo) return;

    outputChannel.appendLine(`[Tomcat] Running pre-start build for ${projectRoot}...`);
    const result = await runBuildOnce(buildInfo, {
      mavenCommand: this.getMavenCommand(),
      gradleCommand: this.getGradleCommand(),
      javaHome: server.javaHome,
      log: msg => outputChannel.appendLine(msg)
    });
    if (!result.ok) {
      outputChannel.appendLine(
        `[Tomcat] Warning: pre-start build failed, starting anyway with whatever's already compiled.`
      );
    }
  }

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
    const watcher = new JavaBuildSyncWatcher(buildInfo, classesTargetDir, msg => outputChannel?.appendLine(msg), this.getSyncTrigger());
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
    if (this.startingIds.has(id)) {
      vscode.window.showInformationMessage(`${server.name} 은(는) 이미 시작 중입니다.`);
      return;
    }
    // Fire immediately, before any of the (potentially multi-second) setup work below - see
    // the startingIds field comment for why this matters.
    this.startingIds.add(id);
    this._onDidChange.fire();

    try {
      await this.doStart(id, server, debug);
    } finally {
      // doStart() resolves right after the process is actually spawned and registered into
      // `running` (everything after that is just attaching listeners, synchronously) - so by
      // the time this fires, running.has(id) is already true and getStatus() reads from there
      // instead. This also covers every early-exit/error path (an unexpected throw anywhere
      // before the process gets spawned), so a failed start can always be retried rather than
      // getting permanently stuck showing "starting".
      this.startingIds.delete(id);
    }
  }

  private async doStart(id: string, server: TomcatServerConfig, debug: boolean): Promise<void> {
    // Covers the whole gap from "start clicked" to "first real Tomcat log line", not just the
    // post-spawn JVM boot - a pre-start Maven/Gradle build (for apps with live source sync) can
    // itself take just as long, and previously ran with no visible progress toast at all.
    // reportPhase()/resolveBoot() are wired up as we go so the same single notification can
    // update its message across phases and then disappear once real output starts.
    let resolveBoot: () => void = () => {};
    let reportPhase: (message: string) => void = () => {};
    const bootDone = new Promise<void>(resolve => {
      resolveBoot = resolve;
    });
    vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `${server.name} 시작 중...`, cancellable: false },
      progress => {
        reportPhase = message => progress.report({ message });
        return bootDone;
      }
    );

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
    // configured. For each one on a detected Maven/Gradle project, optionally run the
    // project's compile command once first (tomcat.buildBeforeStart) and then sync whatever's
    // now in the output folder(s) into WEB-INF/classes, so Tomcat boots against up-to-date
    // classes/resources. A build failure here is logged but never blocks Tomcat from starting.
    const presyncTasks: Promise<void>[] = [];
    for (const app of server.deployedApps) {
      if (app.type === 'exploded' && app.sourceOverlayPath) {
        this.startSourceSync(id, app.contextPath, app.sourceOverlayPath, app.sourcePath, outputChannel);
        presyncTasks.push(
          (async () => {
            await this.maybeRunBuildBeforeStart(server, app.sourceOverlayPath!, app.sourcePath, outputChannel);
            await this.maybeStartJavaBuildSync(
              id,
              app.contextPath,
              app.sourcePath,
              app.sourceOverlayPath!,
              true,
              outputChannel
            );
          })()
        );
      }
    }
    if (presyncTasks.length > 0) {
      outputChannel.appendLine('[Tomcat] Syncing compiled classes/resources for Maven/Gradle app(s)...');
      reportPhase('Maven/Gradle 빌드 및 소스 동기화 중...');
      try {
        await Promise.all(presyncTasks);
      } catch (err) {
        // Defense in depth: a sync/link failure for one app must never prevent Tomcat itself
        // from starting - log it and keep going. (maybeStartJavaBuildSync/JavaBuildSyncWatcher
        // already catch their own copy errors, but this is a last-resort safety net in case
        // something unanticipated throws here.)
        outputChannel.appendLine(`[Tomcat] Warning: pre-start sync had an error, continuing anyway: ${err}`);
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

    // Tomcat/the JVM print nothing at all until the JVM has booted and Catalina's own logging
    // is initialized - normal, but can look like nothing is happening for several seconds,
    // especially in debug mode where attaching the JDWP agent adds real startup overhead on
    // top of the JVM's own cold start. Update the notification already showing (started at the
    // top of this function) to reflect this phase; it disappears as soon as the first line of
    // real output (or an early exit/error) shows up.
    reportPhase(debug ? 'JVM 부팅 및 디버그 에이전트 연결 중...' : 'JVM 부팅 중...');
    proc.stdout.once('data', resolveBoot);
    proc.once('exit', resolveBoot);
    proc.once('error', resolveBoot);

    const info: RunningInfo = { proc, status: 'starting', outputChannel, appStatus: new Map() };
    for (const app of server.deployedApps) {
      info.appStatus.set(app.contextPath, 'deploying');
    }
    this.running.set(id, info);
    this._onDidChange.fire();

    const setAppStatus = (contextPath: string, status: AppStatus) => {
      const current = info.appStatus.get(contextPath);
      if (current === status) return;
      // Once an app is confirmed running or failed, a later stray match (e.g. an unrelated
      // "[]" bracket) shouldn't bounce it back to "deploying".
      if ((current === 'running' || current === 'failed') && status === 'deploying') return;
      info.appStatus.set(contextPath, status);
      this._onDidChange.fire();
    };

    // Filename must be followed by "]", whitespace, or end-of-line - not just found anywhere -
    // so this can't match some unrelated line that merely mentions the filename in passing, and
    // so "app.xml" can't accidentally match inside a longer name like "app.xml.bak". Newer
    // Tomcat versions bracket these paths ("...[C:\...\lgcom.xml] has finished..."), but older
    // ones (confirmed on 8.0.53) don't ("...C:\...\lgcom.xml has finished..." - no brackets at
    // all) - matching on the boundary after the filename instead of specifically "]" covers
    // both without caring which log format a given Tomcat version happens to use.
    const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const deployFileNameBoundary = (fileName: string) => new RegExp(`${escapeRegExp(fileName)}(?:\\]|\\s|$)`);

    // Scans Tomcat log output for per-app deploy start/finish/failure lines and updates that
    // app's status accordingly. Line-based (rather than matching the raw chunk) so an unrelated
    // SEVERE line elsewhere in the same chunk can't be misattributed to an app whose "has
    // finished" line happens to also be in that chunk. Buffers any trailing partial line (no
    // newline yet) across calls, since Node can split a single Catalina log line across two
    // separate 'data' events - without this, a split "...has finished..." line would silently
    // never match and leave that app stuck showing "deploying" forever. stdout and stderr each
    // get their own checker (own buffer) via this factory so a partial line from one stream can
    // never merge with a chunk from the other.
    const makeDeployLineChecker = () => {
      let buffer = '';
      return (chunk: string) => {
        const matchers = this.computeAppDeployMatchers(server);
        const lines = (buffer + chunk).split(/\r?\n/);
        buffer = lines.pop() ?? '';
        for (const line of lines) {
          for (const m of matchers) {
            if (!deployFileNameBoundary(m.deployFileName).test(line)) continue;
            if (/SEVERE|Error deploying/i.test(line)) {
              setAppStatus(m.contextPath, 'failed');
            } else if (/has finished/i.test(line)) {
              setAppStatus(m.contextPath, 'running');
            }
          }
          const contextFailMatch = /Context \[([^\]]*)\] startup failed due to previous errors/.exec(line);
          if (contextFailMatch) {
            const m = matchers.find(x => x.contextBracketNeedle === contextFailMatch[1]);
            if (m) setAppStatus(m.contextPath, 'failed');
          }
        }
      };
    };
    const checkAppDeployLinesStdout = makeDeployLineChecker();
    const checkAppDeployLinesStderr = makeDeployLineChecker();

    let debuggerAttached = false;
    const attachOnce = () => {
      if (debug && !debuggerAttached) {
        debuggerAttached = true;
        this.attachDebugger(server);
      }
    };

    let startupNotified = false;
    const notifyStartedOnce = (viaFallback: boolean) => {
      if (startupNotified) return;
      startupNotified = true;
      const suffix = viaFallback ? ' (시작 배너를 감지하지 못해 20초 후 자동으로 표시됨)' : '';
      vscode.window.showInformationMessage(
        `✅ ${server.name} 서버가 ${debug ? '디버그 모드로 ' : ''}시작되었습니다 — http://localhost:${server.httpPort}${suffix}`
      );
    };

    // Buffered across chunks: Node delivers stdout in arbitrarily-sized pieces, so a marker
    // like "Server startup in" can end up split across two separate 'data' events (e.g.
    // "...Server star" then "tup in 1234 ms"). Testing each chunk in isolation would then
    // never match at all, silently skipping the debugger attach below. Keep a small rolling
    // buffer (just the tail end, bounded so it can't grow unbounded on a very chatty log) and
    // test against that instead.
    let recentOutput = '';
    const STARTUP_MARKER = /Server startup in|INFO.*Starting ProtocolHandler/;
    const STARTUP_COMPLETE_MARKER = /Server startup in/;

    // Fatal problems that mean Tomcat never actually came up, as opposed to routine SEVERE/WARN
    // noise that can legitimately show up once the server's already running. Only checked while
    // status is still 'starting', so errors logged later (e.g. from a deployed app at runtime)
    // never trigger this.
    const STARTUP_ERROR_MARKER =
      /Failed to start component|LifecycleException|A child container failed during start|Address already in use|Could not start Tomcat|Error starting static Resources|BindException/i;

    // Guards against double-handling: once we've decided the startup failed, the 'exit'
    // handler and the 20s safety-net timeout below must not resurrect the server as
    // "running" or show a second, contradictory message.
    let startupFailed = false;
    const failStartup = (reason: string) => {
      if (startupFailed || info.status !== 'starting') return;
      startupFailed = true;
      info.status = 'stopped';
      for (const [contextPath, appSt] of info.appStatus) {
        if (appSt === 'deploying') info.appStatus.set(contextPath, 'failed');
      }
      outputChannel.appendLine(`\n[Tomcat] 시작 중 오류가 감지되어 서버 실행을 취소합니다: ${reason}`);
      vscode.window.showErrorMessage(`${server.name} 시작 실패 (기동 중 오류 감지로 취소됨): ${reason}`);
      this.running.delete(id);
      this.stopAllSyncForServer(id);
      this._onDidChange.fire();
      // Kill whatever came up so a half-started JVM doesn't linger as an orphan process.
      try {
        if (process.platform === 'win32') {
          spawn('taskkill', ['/pid', String(proc.pid), '/T', '/F']);
        } else if (proc.pid) {
          process.kill(-proc.pid, 'SIGKILL');
        }
      } catch {
        // process may already be gone
      }
    };

    proc.stdout.on('data', (d: Buffer) => {
      const text = d.toString();
      outputChannel.append(text);

      recentOutput = (recentOutput + text).slice(-2000);
      if (STARTUP_MARKER.test(recentOutput)) {
        info.status = debug ? 'debugging' : 'running';
        this._onDidChange.fire();
        attachOnce();
      }
      checkAppDeployLinesStdout(text);
      if (STARTUP_COMPLETE_MARKER.test(recentOutput)) {
        notifyStartedOnce(false);
        for (const m of this.computeAppDeployMatchers(server)) {
          if (info.appStatus.get(m.contextPath) === 'deploying') {
            setAppStatus(m.contextPath, 'running');
          }
        }
      }
      if (info.status === 'starting') {
        const match = STARTUP_ERROR_MARKER.exec(text);
        if (match) {
          failStartup(match[0]);
        }
      }
    });

    proc.stderr.on('data', (d: Buffer) => {
      const text = d.toString();
      outputChannel.append(text);
      checkAppDeployLinesStderr(text);
      if (info.status === 'starting') {
        const match = STARTUP_ERROR_MARKER.exec(text);
        if (match) {
          failStartup(match[0]);
        }
      }
    });

    proc.on('exit', (code) => {
      outputChannel.appendLine(`\n[Tomcat] Process exited with code ${code}`);
      if (startupFailed) return;
      this.running.delete(id);
      this.stopAllSyncForServer(id);
      this._onDidChange.fire();
    });

    proc.on('error', (err) => {
      outputChannel.appendLine(`\n[Tomcat] Failed to start: ${err.message}`);
      if (startupFailed) return;
      vscode.window.showErrorMessage(`Tomcat 시작 실패: ${err.message}`);
      this.running.delete(id);
      this.stopAllSyncForServer(id);
      this._onDidChange.fire();
    });

    // Safety net: if we never see the startup banner within 20s (log wording differs between
    // Tomcat versions, or it's just a slow boot), assume running anyway - and, critically,
    // still attach the debugger if this is a debug start. Missing this call here was a real
    // bug: the debugger would simply never attach if the banner regex didn't match, with no
    // error shown, silently leaving `debuggerAttached` false forever.
    setTimeout(() => {
      if (startupFailed) return;
      if (info.status === 'starting') {
        info.status = debug ? 'debugging' : 'running';
        this._onDidChange.fire();
      }
      attachOnce();
      notifyStartedOnce(true);
    }, 20000);
  }

  /** Precomputes, for each of the server's currently deployed apps, the on-disk deployment
   *  filename Tomcat's HostConfig logs while deploying it (the WAR filename, or the context
   *  descriptor XML filename for exploded apps under conf/Catalina/<host>/) - matched against
   *  just the filename rather than the full absolute path, since the JVM's own resolved
   *  CATALINA_BASE can end up textually different from our stored server.homePath even when it
   *  points at the exact same directory (a pre-existing system-wide CATALINA_HOME env var that
   *  catalina.bat/sh prefers over what we pass, 8.3 short paths on Windows, etc.) - the
   *  filename itself is something this extension chose and wrote to disk, so it can't drift.
   *  Also returns the `[contextPath]` bracket Tomcat uses in its own per-context
   *  startup-failure log line - see deployWar()/deployExploded() for where these same names
   *  get written. */
  private computeAppDeployMatchers(
    server: TomcatServerConfig
  ): { contextPath: string; deployFileName: string; contextBracketNeedle: string }[] {
    return server.deployedApps.map(app => {
      const deployFileName =
        app.type === 'war'
          ? path.basename(app.sourcePath)
          : (() => {
              const appName = app.contextPath === '/' ? 'ROOT' : app.contextPath.replace(/^\/+/, '');
              return appName === 'ROOT' ? 'ROOT.xml' : `${appName}.xml`;
            })();
      return {
        contextPath: app.contextPath,
        deployFileName,
        // Tomcat's internal context path for ROOT is "" (logged as "Context [] startup
        // failed..."), while our model stores ROOT's contextPath as "/".
        contextBracketNeedle: app.contextPath === '/' ? '' : app.contextPath
      };
    });
  }


  private async attachDebugger(server: TomcatServerConfig) {
    const debugConfig: vscode.DebugConfiguration = {
      type: 'java',
      name: `Attach to ${server.name}`,
      request: 'attach',
      hostName: 'localhost',
      port: server.debugPort,
      // Without an explicit value, VSCode's default ('openOnFirstSessionStart') steals focus
      // to the Debug Console the moment the session attaches, switching away from our Output
      // tab right after we print the "서버가 디버그 모드로 시작되었습니다" message. Configurable
      // via tomcat.debug.internalConsoleOptions in case someone wants the Debug Console back.
      internalConsoleOptions: this.getDebugInternalConsoleOptions()
    };
    try {
      const started = await vscode.debug.startDebugging(undefined, debugConfig);
      if (!started) {
        // startDebugging can resolve to false (rather than throw) e.g. when no "java" debug
        // type is registered at all - most commonly because the "Debugger for Java"
        // extension isn't installed. Surface that instead of failing silently.
        vscode.window.showWarningMessage(
          `Java 디버거 연결에 실패했습니다. VSCode에 "Debugger for Java" 확장(보통 "Extension Pack for Java"에 포함)이 설치되어 있는지 확인해주세요.`
        );
      }
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
    // Deliberately NOT writing a `path` attribute: for context.xml files placed under
    // conf/Catalina/<host>/ (which is how every app this extension deploys is registered),
    // Tomcat has derived the context path from the *filename* since Tomcat 7 - any `path`
    // attribute inside the file itself is ignored, and modern Tomcat (9+) logs a WARNING
    // about it on every deploy. `contextPath` is still used by callers to name the XML file
    // correctly (e.g. "lgcom.xml" for "/lgcom") - it just doesn't belong inside the file.
    const attrs: Record<string, string> = {
      docBase,
      reloadable: defaultReloadable,
      ...(extraAttributes ?? {})
    };
    delete attrs['docBase'];
    delete attrs['path'];

    const attrStr = [`docBase="${escapeXmlAttr(docBase)}"`]
      .concat(Object.entries(attrs).map(([k, v]) => `${k}="${escapeXmlAttr(v)}"`))
      .join(' ');

    const body = (innerXml ?? '').trim();
    if (body) {
      return `<?xml version="1.0" encoding="UTF-8"?>\n<Context ${attrStr}>\n${body}\n</Context>\n`;
    }
    return `<?xml version="1.0" encoding="UTF-8"?>\n<Context ${attrStr} />\n`;
  }

  private async registerDeployedApp(server: TomcatServerConfig, app: DeployedApp) {
    // Keep apps in the order they were originally added: re-deploying an app that's already
    // registered (same contextPath - e.g. re-running "Deploy WAR..." to push an updated
    // build) replaces it in place rather than removing-then-pushing, which would otherwise
    // bump it to the bottom of the tree every time. A genuinely new contextPath is appended,
    // so first-time deploys still land in the order they were added.
    const existingIndex = server.deployedApps.findIndex(a => a.contextPath === app.contextPath);
    if (existingIndex >= 0) {
      server.deployedApps[existingIndex] = app;
    } else {
      server.deployedApps.push(app);
    }
    await this.save();

    // If the server's already running, this is a deploy-while-live (Tomcat's own autoDeploy
    // background scan will pick up the new WAR/context descriptor within a few seconds) - seed
    // its status as 'deploying' so the tree doesn't show it as freshly running before it
    // actually is. The 'starting' server's stdout listener (see start()) recomputes its app
    // matchers from server.deployedApps on every log chunk, so it'll pick this app's own
    // deploy-finished/error line up automatically once Tomcat logs it.
    const info = this.running.get(server.id);
    if (info) {
      info.appStatus.set(app.contextPath, 'deploying');
      this._onDidChange.fire();
    }
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

    const info = this.running.get(id);
    if (info) {
      info.appStatus.delete(contextPath);
      this._onDidChange.fire();
    }
  }

  getAppUrl(server: TomcatServerConfig, app: DeployedApp): string {
    return `http://localhost:${server.httpPort}${app.contextPath}/`;
  }
}
