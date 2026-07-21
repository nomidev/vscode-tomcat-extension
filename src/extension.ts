import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { ServerManager } from './serverManager';
import { TomcatTreeProvider, ServerTreeItem, AppTreeItem } from './tomcatTreeProvider';
import { findMetaInfContext, parseMetaInfContext } from './contextXml';
import { LOG_LEVELS, TomcatServerConfig } from './model';
import { detectBuildInfo, detectWebappSource, findProjectRoot } from './sourceOverlay';
import { hasManagerApp, ensureManagerUser, resetManagerUser, reloadContext } from './tomcatManager';
import { runBuildOnce } from './buildRunner';

let activeManager: ServerManager | undefined;

export function activate(context: vscode.ExtensionContext) {
  const manager = new ServerManager(context);
  activeManager = manager;
  const treeProvider = new TomcatTreeProvider(manager);
  const treeView = vscode.window.createTreeView('tomcatServers', {
    treeDataProvider: treeProvider
  });
  context.subscriptions.push(treeView);

  // Also surface the same server list as a section inside the built-in Explorer sidebar,
  // for people who'd rather not hunt for a separate activity-bar icon.
  const explorerTreeView = vscode.window.createTreeView('tomcatServersExplorer', {
    treeDataProvider: treeProvider
  });
  context.subscriptions.push(explorerTreeView);

  // --- Hot-swap failure notifications -------------------------------------------------
  // The Java debugger ("Debugger for Java") does its own Hot Code Replace when you save a
  // .java file while attached, entirely outside this extension's control. Its exact custom
  // Debug Adapter Protocol event schema for reporting hot-swap failures isn't something we
  // can rely on with full certainty, so this listens broadly: every custom event from a
  // debug session we recognize as one we started (name matches "Attach to <server>") gets
  // logged to that server's output channel for visibility, and anything that looks like a
  // hot-swap-related failure (event name or body mentioning both "hotcodereplace"/"hotswap"
  // and "error"/"fail") triggers a warning toast with a concrete next step - since a generic
  // Java-debugger failure message wouldn't know "Reload Context Now" exists.
  const debugSessionServers = new Map<string, TomcatServerConfig>();

  context.subscriptions.push(
    vscode.debug.onDidStartDebugSession(session => {
      const server = manager.getServers().find(s => session.name === `Attach to ${s.name}`);
      if (server) {
        debugSessionServers.set(session.id, server);
      }
    })
  );

  context.subscriptions.push(
    vscode.debug.onDidTerminateDebugSession(session => {
      debugSessionServers.delete(session.id);
    })
  );

  context.subscriptions.push(
    vscode.debug.onDidReceiveDebugSessionCustomEvent(e => {
      const server = debugSessionServers.get(e.session.id);
      if (!server) return;

      const channel = manager.getOutputChannel(server.id);
      channel?.appendLine(`[debug] custom event: ${e.event} ${JSON.stringify(e.body ?? {})}`);

      const eventName = (e.event ?? '').toLowerCase();
      const bodyText = JSON.stringify(e.body ?? {}).toLowerCase();
      const mentionsHotSwap = eventName.includes('hotcodereplace') || eventName.includes('hotswap');
      const mentionsFailure = eventName.includes('error') || /error|fail/.test(bodyText);

      if (mentionsHotSwap && mentionsFailure) {
        vscode.window.showWarningMessage(
          `"${server.name}" 에서 핫스왑(코드 교체)이 실패한 것 같습니다. 필드/메서드/클래스 추가 같은 구조적 변경이라면 정상적인 제약이니, 배포된 앱을 우클릭해 "Reload Context Now" 로 반영해보세요.`
        );
      }
    })
  );

  // Wraps every command handler so an unexpected exception anywhere (a filesystem error, a
  // bad state assumption, etc.) always surfaces as a clear message instead of failing
  // silently or with just a generic "command failed" notification - the debugger-attach bug
  // earlier in this session was exactly this class of problem (a failure with no visible
  // error at all), so this is a blanket safety net against the same thing happening elsewhere.
  const reg = (cmd: string, handler: (...args: any[]) => any) =>
    context.subscriptions.push(
      vscode.commands.registerCommand(cmd, async (...args: any[]) => {
        try {
          return await handler(...args);
        } catch (err: any) {
          const message = err?.message ?? String(err);
          vscode.window.showErrorMessage(`Tomcat: "${cmd}" 실행 중 오류가 발생했습니다: ${message}`);
        }
      })
    );

  /**
   * If the server is currently running (or debugging), restart it automatically so that
   * deploy/undeploy changes take effect immediately, without asking the user to do it manually.
   * Returns true if a restart was triggered.
   */
  async function applyChangesIfRunning(serverId: string): Promise<boolean> {
    const status = manager.getStatus(serverId);
    if (status === 'running' || status === 'debugging') {
      await manager.restart(serverId, status === 'debugging');
      return true;
    }
    return false;
  }

  /**
   * Forces a currently-running server to actually pick up a context.xml change (e.g. a
   * reloadable/live-overlay toggle) via the Manager API's "reload", the same thing the
   * explicit "Reload Context Now" command does. Attribute-only changes like `reloadable` are
   * only read by Tomcat when a context (re)loads - rewriting context.xml on disk alone does
   * NOT make an already-running server notice by itself, so callers that change these
   * settings must call this afterwards or the change silently won't take effect until the
   * next restart. Handles first-time Manager credential setup and quietly recovers from a
   * stale/invalid credential (401) the same way the explicit command does. Set `quiet: true`
   * to skip the final success toast (e.g. when this is a side-effect of another action that
   * already shows its own confirmation).
   */
  async function ensureContextReloaded(
    server: TomcatServerConfig,
    contextPath: string,
    options: { quiet?: boolean } = {}
  ): Promise<void> {
    const status = manager.getStatus(server.id);
    if (status !== 'running' && status !== 'debugging') {
      return; // nothing to do - a fresh start will already pick up the current context.xml
    }

    if (!hasManagerApp(server.homePath)) {
      vscode.window.showWarningMessage(
        `이 Tomcat 설치에는 Manager 웹앱이 없어 "${contextPath}" 변경사항을 지금 서버에 자동으로 적용할 수 없습니다. ` +
          '서버를 재시작하면 반영됩니다.'
      );
      return;
    }

    const creds = await ensureManagerUser(server, context.secrets);
    if (creds.justProvisioned) {
      const choice = await vscode.window.showInformationMessage(
        `"${contextPath}" 변경사항을 지금 서버에 반영하려면 Tomcat Manager 계정이 필요한데, 방금 새로 만들었습니다. ` +
          '최초 1회는 서버를 재시작해야 활성화됩니다. 지금 재시작할까요?',
        '지금 재시작',
        '나중에'
      );
      if (choice === '지금 재시작') {
        await manager.restart(server.id, status === 'debugging');
        vscode.window.showInformationMessage('재시작 완료. 변경사항이 반영되었습니다.');
      } else {
        vscode.window.showWarningMessage(
          `설정은 저장됐지만, 서버를 재시작하거나 나중에 "Reload Context Now" 를 눌러야 실제로 적용됩니다.`
        );
      }
      return;
    }

    const timeoutSeconds = vscode.workspace.getConfiguration('tomcat').get<number>('managerRequestTimeoutSeconds', 45);
    const result = await reloadContext(server, creds, contextPath, timeoutSeconds * 1000);
    const channel = manager.getOutputChannel(server.id);
    channel?.appendLine(`[manager] reload ${contextPath || '/'}: ${result.message}`);

    if (result.ok) {
      if (!options.quiet) {
        vscode.window.showInformationMessage(`"${contextPath}" 를 즉시 리로드해 변경사항을 반영했습니다.`);
      }
      return;
    }

    if (result.statusCode === 401) {
      const choice = await vscode.window.showErrorMessage(
        `"${contextPath}" 를 반영하려던 중 Tomcat Manager 인증에 실패했습니다 (401). 저장된 계정 정보가 서버와 어긋난 것 같습니다.`,
        '자격 증명 초기화 후 재시작',
        '취소'
      );
      if (choice === '자격 증명 초기화 후 재시작') {
        await resetManagerUser(server, context.secrets);
        await manager.restart(server.id, status === 'debugging');
        vscode.window.showInformationMessage('Manager 계정을 새로 만들고 서버를 재시작했습니다. 변경사항이 반영되었습니다.');
      } else {
        vscode.window.showWarningMessage(
          `설정은 저장됐지만, 서버를 재시작하거나 "Reload Context Now" 를 다시 시도해야 실제로 적용됩니다.`
        );
      }
      return;
    }

    vscode.window.showWarningMessage(
      `"${contextPath}" 를 지금 서버에 반영하지 못했습니다 (${result.message}). 설정은 저장됐으니, ` +
        `서버를 재시작하거나 "Reload Context Now" 를 다시 시도해주세요.`
    );
  }

  async function reloadTargetApps(server: TomcatServerConfig, target: ServerTreeItem | AppTreeItem): Promise<void> {
    const status = manager.getStatus(server.id);
    if (status !== 'running' && status !== 'debugging') {
      return;
    }

    const contextPaths =
      target instanceof AppTreeItem
        ? [target.app.contextPath].filter(Boolean)
        : target.server.deployedApps.map(app => app.contextPath).filter(Boolean);

    await Promise.all(contextPaths.map(contextPath => ensureContextReloaded(server, contextPath, { quiet: true })));
  }

  async function runBuildForTarget(target: ServerTreeItem | AppTreeItem): Promise<void> {
    const server = target.server;
    const candidates = target instanceof AppTreeItem
      ? [target.app.sourcePath, target.app.sourceOverlayPath]
      : target.server.deployedApps.flatMap(app => [app.sourcePath, app.sourceOverlayPath]);

    const projectRoot = candidates
      .filter((value): value is string => !!value)
      .map(value => findProjectRoot(value))
      .find((value): value is string => !!value);

    if (!projectRoot) {
      vscode.window.showWarningMessage('이 항목에서 Maven/Gradle 프로젝트 루트를 찾을 수 없습니다.');
      return;
    }

    const buildInfo = detectBuildInfo(projectRoot);
    if (!buildInfo) {
      vscode.window.showWarningMessage('Maven/Gradle 프로젝트가 아니어서 빌드를 실행할 수 없습니다.');
      return;
    }

    const channel = manager.getOutputChannel(server.id);
    channel?.show(true);
    channel?.appendLine(`[build] Manual build requested for ${projectRoot}`);

    await reloadTargetApps(server, target);

    const result = await runBuildOnce(buildInfo, {
      javaHome: server.javaHome,
      log: message => channel?.appendLine(message)
    });

    if (result.ok) {
      await reloadTargetApps(server, target);
      vscode.window.showInformationMessage(`"${server.name}" 의 프로젝트 빌드를 완료하고 앱을 다시 불러왔습니다.`);
    } else {
      vscode.window.showWarningMessage(`"${server.name}" 의 프로젝트 빌드가 실패했습니다: ${result.message ?? 'unknown error'}`);
    }
  }

  reg('tomcat.refresh', () => treeProvider.refresh());

  reg('tomcat.buildProject', async (item: ServerTreeItem | AppTreeItem | undefined) => {
    if (!item) return;
    await runBuildForTarget(item);
  });

  reg('tomcat.addServer', async () => {
    const uris = await vscode.window.showOpenDialog({
      canSelectFiles: false,
      canSelectFolders: true,
      canSelectMany: false,
      openLabel: 'Tomcat 설치 폴더 선택 (CATALINA_HOME)'
    });
    if (!uris || uris.length === 0) return;
    const homePath = uris[0].fsPath;

    const name = await vscode.window.showInputBox({
      prompt: '서버 이름',
      value: path.basename(homePath)
    });
    if (name === undefined) return;

    try {
      await manager.addServer(homePath, name);
      vscode.window.showInformationMessage(`Tomcat 서버 "${name}"가 추가되었습니다.`);
    } catch (err: any) {
      vscode.window.showErrorMessage(err?.message ?? String(err));
    }
  });

  reg('tomcat.removeServer', async (item: ServerTreeItem) => {
    if (!item) return;
    const confirm = await vscode.window.showWarningMessage(
      `"${item.server.name}" 서버를 목록에서 제거할까요? (Tomcat 설치 파일은 삭제되지 않습니다)`,
      { modal: true },
      '제거'
    );
    if (confirm !== '제거') return;
    await manager.removeServer(item.server.id);
  });

  reg('tomcat.startServer', async (item: ServerTreeItem) => {
    if (!item) return;
    await manager.start(item.server.id, false);
  });

  reg('tomcat.debugServer', async (item: ServerTreeItem) => {
    if (!item) return;
    await manager.start(item.server.id, true);
  });

  reg('tomcat.stopServer', async (item: ServerTreeItem) => {
    if (!item) return;
    await manager.stop(item.server.id);
  });

  reg('tomcat.restartServer', async (item: ServerTreeItem) => {
    if (!item) return;
    const wasDebugging = manager.getStatus(item.server.id) === 'debugging';
    await manager.restart(item.server.id, wasDebugging);
  });

  reg('tomcat.showLogs', async (item: ServerTreeItem) => {
    if (!item) return;
    const channel = manager.getOutputChannel(item.server.id);
    if (channel) {
      channel.show();
    } else {
      vscode.window.showInformationMessage('서버가 실행 중이 아닙니다. 먼저 시작하세요.');
    }
  });

  reg('tomcat.editPorts', async (item: ServerTreeItem) => {
    if (!item) return;
    const httpPortStr = await vscode.window.showInputBox({
      prompt: 'HTTP 포트',
      value: String(item.server.httpPort),
      validateInput: v => (/^\d+$/.test(v) ? undefined : '숫자를 입력하세요')
    });
    if (httpPortStr === undefined) return;

    const debugPortStr = await vscode.window.showInputBox({
      prompt: '디버그 포트 (JPDA)',
      value: String(item.server.debugPort),
      validateInput: v => (/^\d+$/.test(v) ? undefined : '숫자를 입력하세요')
    });
    if (debugPortStr === undefined) return;

    await manager.updatePorts(item.server.id, parseInt(httpPortStr, 10), parseInt(debugPortStr, 10));
    vscode.window.showInformationMessage(
      `${item.server.name} 의 포트가 HTTP ${httpPortStr} / Debug ${debugPortStr} 로 설정되었습니다. 포트는 서버 시작 시에만 적용되는 설정이라, 다음 시작/재시작 시 반영됩니다.`
    );
    const restarted = await applyChangesIfRunning(item.server.id);
    if (restarted) {
      vscode.window.showInformationMessage('실행 중인 서버를 자동으로 재시작해 새 포트를 적용했습니다.');
    }
  });

  reg('tomcat.editJavaHome', async (item: ServerTreeItem) => {
    if (!item) return;
    const current = item.server.javaHome;

    const pick = await vscode.window.showQuickPick(
      [
        { label: '$(folder-opened) JDK 폴더 선택...', value: 'browse' as const },
        { label: '$(discard) 시스템 기본값 사용 (설정 해제)', value: 'clear' as const }
      ],
      {
        placeHolder: current
          ? `현재 JAVA_HOME: ${current}`
          : '현재: 시스템 기본 JAVA_HOME 사용 중'
      }
    );
    if (!pick) return;

    if (pick.value === 'clear') {
      await manager.updateJavaHome(item.server.id, undefined);
      vscode.window.showInformationMessage(
        `${item.server.name} 이(가) 시스템 기본 JAVA_HOME 을 사용하도록 설정되었습니다. JAVA_HOME 은 서버 시작 시에만 적용되는 설정이라, 다음 시작/재시작 시 반영됩니다.`
      );
      const restarted = await applyChangesIfRunning(item.server.id);
      if (restarted) {
        vscode.window.showInformationMessage('실행 중인 서버를 자동으로 재시작해 적용했습니다.');
      }
      return;
    }

    const uris = await vscode.window.showOpenDialog({
      canSelectFiles: false,
      canSelectFolders: true,
      canSelectMany: false,
      openLabel: 'JDK 홈 디렉토리 선택 (JAVA_HOME)',
      defaultUri: current ? vscode.Uri.file(current) : undefined
    });
    if (!uris || uris.length === 0) return;

    const javaHome = uris[0].fsPath;
    const javaBinExists =
      fs.existsSync(path.join(javaHome, 'bin', 'java')) || fs.existsSync(path.join(javaHome, 'bin', 'java.exe'));
    if (!javaBinExists) {
      const proceed = await vscode.window.showWarningMessage(
        `선택한 폴더(${javaHome})에서 bin/java 실행 파일을 찾을 수 없습니다. 그래도 사용할까요?`,
        { modal: true },
        '사용'
      );
      if (proceed !== '사용') return;
    }

    await manager.updateJavaHome(item.server.id, javaHome);
    vscode.window.showInformationMessage(
      `${item.server.name} 의 JAVA_HOME 이 "${javaHome}" 으로 설정되었습니다. JAVA_HOME 은 서버 시작 시에만 적용되는 설정이라, 다음 시작/재시작 시 반영됩니다.`
    );
    const restarted = await applyChangesIfRunning(item.server.id);
    if (restarted) {
      vscode.window.showInformationMessage('실행 중인 서버를 자동으로 재시작해 적용했습니다.');
    }
  });

  reg('tomcat.setLogLevel', async (item: ServerTreeItem) => {
    if (!item) return;
    const defaultLevel = manager.getDefaultLogLevel();
    const useDefaultLabel = `$(sync) 전역 기본값 사용 (현재: ${defaultLevel})`;

    const picks = [
      { label: useDefaultLabel, value: undefined as string | undefined },
      ...LOG_LEVELS.map(level => ({
        label: level === item.server.logLevel ? `$(check) ${level}` : level,
        value: level as string | undefined
      }))
    ];

    const pick = await vscode.window.showQuickPick(picks, {
      placeHolder: `현재: ${item.server.logLevel ?? `(전역 기본값: ${defaultLevel})`}`
    });
    if (!pick) return;

    await manager.updateLogLevel(item.server.id, pick.value);
    vscode.window.showInformationMessage(
      `${item.server.name} 의 로그 레벨이 ${pick.value ?? `전역 기본값(${defaultLevel})`} 으로 설정되었습니다. 다음 시작/재시작 시 conf/logging.properties 에 반영됩니다.`
    );

    const restarted = await applyChangesIfRunning(item.server.id);
    if (restarted) {
      vscode.window.showInformationMessage(`실행 중인 서버를 자동으로 재시작해 새 로그 레벨을 적용했습니다.`);
    }
  });

  reg('tomcat.editVmOptions', async (item: ServerTreeItem) => {
    if (!item) return;
    const vmOptions = await vscode.window.showInputBox({
      prompt: 'Tomcat VM(JVM) 옵션 (CATALINA_OPTS 에 추가됩니다)',
      placeHolder: '예: -Xms256m -Xmx1024m -Dspring.profiles.active=local',
      value: item.server.vmOptions ?? '',
      ignoreFocusOut: true
    });
    if (vmOptions === undefined) return;

    const trimmed = vmOptions.trim();
    await manager.updateVmOptions(item.server.id, trimmed || undefined);
    vscode.window.showInformationMessage(
      trimmed
        ? `${item.server.name} 의 VM 옵션이 설정되었습니다: ${trimmed}`
        : `${item.server.name} 의 VM 옵션이 초기화되었습니다.`
    );

    const restarted = await applyChangesIfRunning(item.server.id);
    if (restarted) {
      vscode.window.showInformationMessage('실행 중인 서버를 자동으로 재시작해 새 VM 옵션을 적용했습니다.');
    }
  });

  reg('tomcat.openSettings', async () => {
    await vscode.commands.executeCommand('workbench.action.openSettings', 'tomcat.');
  });

  reg('tomcat.deployWar', async (item: ServerTreeItem) => {
    if (!item) return;
    const uris = await vscode.window.showOpenDialog({
      canSelectMany: false,
      filters: { 'WAR files': ['war'] },
      openLabel: '배포할 WAR 파일 선택'
    });
    if (!uris || uris.length === 0) return;

    const defaultName = path.basename(uris[0].fsPath, '.war');
    const contextPath = await vscode.window.showInputBox({
      prompt: '컨텍스트 경로 (애플리케이션 이름)',
      value: defaultName
    });
    if (contextPath === undefined) return;

    await manager.deployWar(item.server.id, uris[0].fsPath, contextPath);
    const running = manager.getStatus(item.server.id) !== 'stopped';
    vscode.window.showInformationMessage(
      `${contextPath}.war 가 webapps 에 배포되었습니다.` +
        (running
          ? ' 서버가 실행 중이라면 Tomcat 이 자동으로(보통 수 초 내) 감지해 배포합니다. 전체 서버 재시작은 필요 없습니다.'
          : ' 서버를 시작하면 반영됩니다.')
    );
  });

  reg('tomcat.deployExploded', async (item: ServerTreeItem) => {
    if (!item) return;
    const uris = await vscode.window.showOpenDialog({
      canSelectFiles: false,
      canSelectFolders: true,
      canSelectMany: false,
      openLabel: '배포할 웹앱 폴더 선택 (WEB-INF 포함 폴더)'
    });
    if (!uris || uris.length === 0) return;
    const folderPath = uris[0].fsPath;

    // Detect META-INF/context.xml inside the webapp and offer to reuse it.
    const metaInfPath = findMetaInfContext(folderPath);
    const detected = metaInfPath ? parseMetaInfContext(metaInfPath) : undefined;

    let useDetected = false;
    if (detected) {
      const extraCount = Object.keys(detected.attributes).length;
      const detailParts: string[] = [];
      if (detected.path !== undefined) detailParts.push(`path="${detected.path}"`);
      if (extraCount > 0) detailParts.push(`속성 ${extraCount}개`);
      if (detected.innerXml) detailParts.push('하위 리소스 정의 포함');

      const pick = await vscode.window.showQuickPick(
        [
          {
            label: '$(check) META-INF/context.xml 설정 사용',
            description: detailParts.join(', ') || '감지된 설정 적용',
            value: true
          },
          {
            label: '무시하고 직접 입력',
            description: '컨텍스트 경로를 수동으로 지정',
            value: false
          }
        ],
        { placeHolder: `META-INF/context.xml 이 감지되었습니다 (${metaInfPath}). 어떻게 할까요?` }
      );
      if (!pick) return;
      useDetected = pick.value;
    }

    const defaultName =
      (useDetected && detected?.path !== undefined
        ? detected.path.replace(/^\/+/, '') || 'ROOT'
        : undefined) ?? path.basename(folderPath);

    const contextPath = await vscode.window.showInputBox({
      prompt: '컨텍스트 경로 (ROOT 로 배포하려면 "ROOT" 입력)',
      value: defaultName
    });
    if (contextPath === undefined) return;

    // Maven/Gradle projects typically point docBase at a build-output folder
    // (target/<artifactId> for Maven, build/exploded-<name> etc. for Gradle), which only
    // reflects JSP/static-file edits after a rebuild. Offer to overlay the source webapp
    // folder (src/main/webapp by default, configurable via tomcat.webappSourceDir) so edits
    // show up immediately, without needing to rebuild or restart.
    let sourceOverlayPath: string | undefined;
    const webappSourceDir = manager.getWebappSourceDir();
    const autoOverlay = detectWebappSource(folderPath, webappSourceDir);
    const overlayChoices: { label: string; description?: string; value: 'auto' | 'browse' | 'skip' }[] = [];
    if (autoOverlay) {
      overlayChoices.push({ label: '$(check) 활성화 (자동 감지된 경로 사용)', description: autoOverlay, value: 'auto' });
    }
    overlayChoices.push({ label: '$(folder-opened) 다른 소스 폴더 선택...', value: 'browse' });
    overlayChoices.push({ label: '사용 안 함', value: 'skip' });

    const overlayPick = await vscode.window.showQuickPick(overlayChoices, {
      placeHolder: autoOverlay
        ? `Maven/Gradle 프로젝트가 감지되었습니다 (${webappSourceDir}). JSP/정적 파일을 소스에서 즉시 반영하도록 라이브 오버레이를 활성화할까요?`
        : `JSP/정적 파일을 즉시 반영하려면 ${webappSourceDir} 같은 소스 폴더를 오버레이로 지정할 수 있습니다 (선택사항)`
    });
    if (overlayPick) {
      if (overlayPick.value === 'auto') {
        sourceOverlayPath = autoOverlay;
      } else if (overlayPick.value === 'browse') {
        const overlayUris = await vscode.window.showOpenDialog({
          canSelectFiles: false,
          canSelectFolders: true,
          canSelectMany: false,
          openLabel: '소스 웹앱 폴더 선택 (예: src/main/webapp)'
        });
        if (overlayUris && overlayUris.length > 0) {
          sourceOverlayPath = overlayUris[0].fsPath;
        }
      }
    }

    let reloadable: boolean | undefined;
    if (sourceOverlayPath) {
      const reloadPick = await vscode.window.showQuickPick(
        [
          {
            label: '$(circle-slash) 자동 컨텍스트 리로드 끄기 (권장 - 디버거로 실행 중일 때)',
            detail: '메서드 본문 변경은 디버거 핫스왑으로 조용히·즉시 반영됩니다. 필드/메서드/클래스 추가 같은 구조적 변경은 "Reload Context Now" 로 수동 반영합니다.',
            value: false
          },
          {
            label: '$(sync) 자동 컨텍스트 리로드 켜기 (디버거 없이 실행할 때)',
            detail: '클래스가 바뀔 때마다 Tomcat 이 앱 컨텍스트 전체를 자동으로 다시 로드합니다(세션 등 상태 초기화됨). 디버거 없이도 모든 변경이 자동 반영되지만, 매번 다소 무겁습니다.',
            value: true
          }
        ],
        { placeHolder: '이 앱을 보통 디버그 모드(JPDA)로 실행하시나요, 아니면 일반 Start 로 실행하시나요?' }
      );
      reloadable = reloadPick?.value ?? false;
    }

    await manager.deployExploded(
      item.server.id,
      folderPath,
      contextPath,
      useDetected ? detected?.attributes : undefined,
      useDetected ? detected?.innerXml : undefined,
      sourceOverlayPath,
      reloadable
    );
    const running = manager.getStatus(item.server.id) !== 'stopped';
    vscode.window.showInformationMessage(
      `"${contextPath}" 가 exploded 배포로 등록되었습니다${useDetected ? ' (META-INF/context.xml 설정 적용됨)' : ''}` +
        `${sourceOverlayPath ? ` (라이브 소스 오버레이: ${sourceOverlayPath})` : ''}. ` +
        (running
          ? 'Tomcat 이 자동으로(보통 수 초 내) 감지해 배포합니다. 전체 서버 재시작은 필요 없습니다.'
          : '서버를 시작하면 반영됩니다.') +
        (sourceOverlayPath
          ? ` JSP/정적 파일은 이후 저장 즉시 반영되고, target/classes(또는 build/classes 등)에 컴파일된 클래스/리소스도 변경 즉시 WEB-INF/classes 로 자동 동기화됩니다(컴파일 자체는 VSCode의 Java 자동 빌드 등 기존 빌드 도구가 담당). ` +
            (reloadable
              ? '자동 컨텍스트 리로드가 켜져 있어 클래스 변경 시 Tomcat 이 컨텍스트를 자동으로 다시 로드합니다.'
              : '자동 컨텍스트 리로드는 꺼져있어(reloadable=false) 메서드 본문 변경은 디버거 핫스왑으로, 필드/메서드/클래스 추가 같은 구조적 변경은 "Reload Context Now" 로 반영하세요.')
          : ' IntelliJ 처럼 이후 재빌드 시에는 서버 재시작 없이 즉시 반영됩니다.')
    );
  });

  reg('tomcat.addSourceOverlay', async (item: AppTreeItem) => {
    if (!item || item.app.type !== 'exploded') return;

    const webappSourceDir = manager.getWebappSourceDir();
    const autoOverlay = detectWebappSource(item.app.sourcePath, webappSourceDir);
    const choices: { label: string; description?: string; value: 'auto' | 'browse' | 'clear' }[] = [];
    if (autoOverlay) {
      choices.push({ label: '$(check) 자동 감지된 경로 사용', description: autoOverlay, value: 'auto' });
    }
    choices.push({ label: '$(folder-opened) 다른 소스 폴더 선택...', value: 'browse' });
    if (item.app.sourceOverlayPath) {
      choices.push({ label: '$(discard) 오버레이 해제', value: 'clear' });
    }

    const pick = await vscode.window.showQuickPick(choices, {
      placeHolder: item.app.sourceOverlayPath
        ? `현재 오버레이: ${item.app.sourceOverlayPath}`
        : `JSP/정적 파일을 즉시 반영할 소스 폴더(예: ${webappSourceDir})를 선택하세요`
    });
    if (!pick) return;

    let overlayPath: string | undefined;
    if (pick.value === 'auto') {
      overlayPath = autoOverlay;
    } else if (pick.value === 'browse') {
      const uris = await vscode.window.showOpenDialog({
        canSelectFiles: false,
        canSelectFolders: true,
        canSelectMany: false,
        openLabel: `소스 웹앱 폴더 선택 (예: ${webappSourceDir})`
      });
      if (!uris || uris.length === 0) return;
      overlayPath = uris[0].fsPath;
    } else if (pick.value === 'clear') {
      overlayPath = undefined;
    }

    let reloadable: boolean | undefined;
    if (overlayPath) {
      const reloadPick = await vscode.window.showQuickPick(
        [
          {
            label: '$(circle-slash) 자동 컨텍스트 리로드 끄기 (권장 - 디버거로 실행 중일 때)',
            detail: '메서드 본문 변경은 디버거 핫스왑으로 조용히·즉시 반영됩니다. 필드/메서드/클래스 추가 같은 구조적 변경은 "Reload Context Now" 로 수동 반영합니다.',
            value: false
          },
          {
            label: '$(sync) 자동 컨텍스트 리로드 켜기 (디버거 없이 실행할 때)',
            detail: '클래스가 바뀔 때마다 Tomcat 이 앱 컨텍스트 전체를 자동으로 다시 로드합니다(세션 등 상태 초기화됨). 디버거 없이도 모든 변경이 자동 반영되지만, 매번 다소 무겁습니다.',
            value: true
          }
        ],
        {
          placeHolder: '이 앱을 보통 디버그 모드(JPDA)로 실행하시나요, 아니면 일반 Start 로 실행하시나요?'
        }
      );
      if (!reloadPick) return;
      reloadable = reloadPick.value;
    }

    await manager.setSourceOverlay(item.server.id, item.app.contextPath, overlayPath, reloadable);
    vscode.window.showInformationMessage(
      overlayPath
        ? `"${item.app.contextPath}" 에 라이브 소스 오버레이가 적용되었습니다 (${overlayPath}). 서버 재시작 없이 바로 동작합니다 — JSP/정적 파일은 저장 즉시 반영되고, 컴파일된 클래스/리소스도 WEB-INF/classes 로 즉시 동기화됩니다. ` +
          (reloadable
            ? '자동 컨텍스트 리로드가 켜져 있어 클래스 변경 시 Tomcat 이 컨텍스트를 자동으로 다시 로드합니다.'
            : '자동 컨텍스트 리로드는 꺼져 있어(reloadable=false) 메서드 본문 변경은 디버거 핫스왑으로, 구조적 변경은 "Reload Context Now" 로 반영하세요. (앱 우클릭 → "Toggle Auto Context Reload" 로 언제든 전환 가능)')
        : `"${item.app.contextPath}" 의 라이브 오버레이를 해제했습니다.`
    );
    // context.xml just changed (docBase/reloadable/etc) - force an already-running server to
    // actually pick that up now, rather than leaving it to Tomcat's own autoDeploy scan.
    await ensureContextReloaded(item.server, item.app.contextPath, { quiet: true });
  });

  reg('tomcat.toggleAutoReload', async (item: AppTreeItem) => {
    if (!item || item.app.type !== 'exploded' || !item.app.sourceOverlayPath) return;
    const next = !item.app.reloadable;
    await manager.setSourceOverlay(item.server.id, item.app.contextPath, item.app.sourceOverlayPath, next);
    vscode.window.showInformationMessage(
      next
        ? `"${item.app.contextPath}" 의 자동 컨텍스트 리로드를 켰습니다. 클래스 변경 시 Tomcat 이 컨텍스트를 자동으로 다시 로드합니다(디버거 없이도 반영, 다소 무거움).`
        : `"${item.app.contextPath}" 의 자동 컨텍스트 리로드를 껐습니다. 메서드 본문 변경은 디버거 핫스왑으로, 구조적 변경은 "Reload Context Now" 로 반영하세요.`
    );
    // Same as above - reloadable is only read when the context (re)loads, so force that now.
    await ensureContextReloaded(item.server, item.app.contextPath, { quiet: true });
  });

  reg('tomcat.undeploy', async (item: AppTreeItem) => {
    if (!item) return;
    const confirm = await vscode.window.showWarningMessage(
      `"${item.app.contextPath}" 애플리케이션을 undeploy 할까요?`,
      { modal: true },
      'Undeploy'
    );
    if (confirm !== 'Undeploy') return;
    await manager.undeploy(item.server.id, item.app.contextPath);
    const running = manager.getStatus(item.server.id) !== 'stopped';
    if (running) {
      vscode.window.showInformationMessage(
        `"${item.app.contextPath}" 를 undeploy 했습니다. Tomcat 이 자동으로 감지해 서비스에서 내립니다 (전체 서버 재시작 없음).`
      );
    }
  });

  reg('tomcat.openBrowser', async (item: AppTreeItem) => {
    if (!item) return;
    const url = manager.getAppUrl(item.server, item.app);
    vscode.env.openExternal(vscode.Uri.parse(url));
  });

  reg('tomcat.reloadContext', async (item: AppTreeItem) => {
    if (!item) return;
    const status = manager.getStatus(item.server.id);
    if (status !== 'running' && status !== 'debugging') {
      vscode.window.showInformationMessage('서버가 실행 중이 아닙니다. 먼저 시작하세요.');
      return;
    }
    await ensureContextReloaded(item.server, item.app.contextPath);
  });

  reg('tomcat.resetManagerCredentials', async (item: ServerTreeItem) => {
    if (!item) return;
    const confirm = await vscode.window.showWarningMessage(
      `${item.server.name} 의 Tomcat Manager 계정을 새로 만들까요? 적용하려면 서버 재시작이 필요합니다.`,
      { modal: true },
      '초기화'
    );
    if (confirm !== '초기화') return;

    await resetManagerUser(item.server, context.secrets);
    const status = manager.getStatus(item.server.id);
    if (status === 'running' || status === 'debugging') {
      const choice = await vscode.window.showInformationMessage(
        '새 계정이 생성되었습니다. 지금 재시작해서 적용할까요?',
        '지금 재시작',
        '나중에'
      );
      if (choice === '지금 재시작') {
        await manager.restart(item.server.id, status === 'debugging');
      }
    } else {
      vscode.window.showInformationMessage('새 계정이 생성되었습니다. 다음 서버 시작 시 적용됩니다.');
    }
  });

  reg('tomcat.forceResyncClasses', async (item: AppTreeItem) => {
    if (!item || item.app.type !== 'exploded') return;
    const channel = manager.getOutputChannel(item.server.id);
    channel?.show(true);
    channel?.appendLine(`[classes-sync] Force Resync Classes Now 실행: ${item.app.contextPath || '/'}`);

    const result = await manager.forceResyncClasses(item.server.id, item.app.contextPath);
    if (result.reason) {
      vscode.window.showWarningMessage(`동기화를 실행할 수 없습니다: ${result.reason}`);
      return;
    }
    vscode.window.showInformationMessage(
      `"${item.app.contextPath}" 의 target/classes(또는 build/classes, build/resources) 를 WEB-INF/classes 로 동기화했습니다.`
    );
  });
}

export async function deactivate(): Promise<void> {
  // Best-effort: stop any Tomcat servers we started so they don't linger as orphan processes
  // after VSCode closes. Not guaranteed on an abrupt force-quit of the whole application, but
  // covers normal window/app close and extension host shutdown.
  if (activeManager) {
    await activeManager.stopAllForShutdown();
  }
}
