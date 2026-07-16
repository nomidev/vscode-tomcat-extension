import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { ServerManager } from './serverManager';
import { TomcatTreeProvider, ServerTreeItem, AppTreeItem } from './tomcatTreeProvider';
import { findMetaInfContext, parseMetaInfContext } from './contextXml';
import { LOG_LEVELS } from './model';
import { detectWebappSource } from './sourceOverlay';
import { hasManagerApp, ensureManagerUser, resetManagerUser, reloadContext } from './tomcatManager';

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

  const reg = (cmd: string, handler: (...args: any[]) => any) =>
    context.subscriptions.push(vscode.commands.registerCommand(cmd, handler));

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

  reg('tomcat.refresh', () => treeProvider.refresh());

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
      vscode.window.showInformationMessage(`${item.server.name} 이(가) 시스템 기본 JAVA_HOME 을 사용하도록 설정되었습니다.`);
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
    vscode.window.showInformationMessage(`${item.server.name} 의 JAVA_HOME 이 "${javaHome}" 으로 설정되었습니다.`);
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

    await manager.deployExploded(
      item.server.id,
      folderPath,
      contextPath,
      useDetected ? detected?.attributes : undefined,
      useDetected ? detected?.innerXml : undefined,
      sourceOverlayPath
    );
    const running = manager.getStatus(item.server.id) !== 'stopped';
    vscode.window.showInformationMessage(
      `"${contextPath}" 가 exploded 배포로 등록되었습니다${useDetected ? ' (META-INF/context.xml 설정 적용됨)' : ''}` +
        `${sourceOverlayPath ? ` (라이브 소스 오버레이: ${sourceOverlayPath})` : ''}. ` +
        (running
          ? 'Tomcat 이 자동으로(보통 수 초 내) 감지해 배포합니다. 전체 서버 재시작은 필요 없습니다.'
          : '서버를 시작하면 반영됩니다.') +
        (sourceOverlayPath
          ? ' JSP/정적 파일은 이후 저장 즉시 반영되고, Java/리소스 변경 시에도 자동 컴파일 후 WEB-INF/classes 에 반영됩니다.'
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

    await manager.setSourceOverlay(item.server.id, item.app.contextPath, overlayPath);
    vscode.window.showInformationMessage(
      overlayPath
        ? `"${item.app.contextPath}" 에 라이브 소스 오버레이가 적용되었습니다 (${overlayPath}). 서버 재시작 없이 바로 동작합니다 — 이후 JSP/정적 파일 저장 시 즉시 반영되고, Java/리소스 변경 시에도 자동 컴파일 후 WEB-INF/classes 에 반영됩니다.`
        : `"${item.app.contextPath}" 의 라이브 오버레이를 해제했습니다.`
    );
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
    if (!hasManagerApp(item.server.homePath)) {
      vscode.window.showWarningMessage(
        '이 Tomcat 설치에는 Manager 웹앱(webapps/manager)이 포함되어 있지 않아 즉시 리로드를 사용할 수 없습니다. ' +
          '전체 배포판(full/core zip)에는 기본 포함되어 있으니 설치본을 확인해주세요.'
      );
      return;
    }

    const creds = await ensureManagerUser(item.server, context.secrets);
    if (creds.justProvisioned) {
      const choice = await vscode.window.showInformationMessage(
        '즉시 리로드에 필요한 Tomcat Manager 계정을 새로 만들었습니다 (conf/tomcat-users.xml). ' +
          '최초 1회는 서버를 재시작해야 활성화됩니다. 지금 재시작할까요? (이후부터는 재시작 없이 즉시 리로드할 수 있습니다)',
        '지금 재시작',
        '나중에'
      );
      if (choice === '지금 재시작') {
        await manager.restart(item.server.id, status === 'debugging');
        vscode.window.showInformationMessage('재시작 완료. 이제 "Reload Context Now" 로 전체 재시작 없이 즉시 반영할 수 있습니다.');
      }
      return;
    }

    const result = await reloadContext(item.server, creds, item.app.contextPath);
    const channel = manager.getOutputChannel(item.server.id);
    channel?.appendLine(`[manager] reload ${item.app.contextPath || '/'}: ${result.message}`);

    if (result.ok) {
      vscode.window.showInformationMessage(`"${item.app.contextPath}" 를 즉시 리로드했습니다 (전체 서버 재시작 없음).`);
      return;
    }

    if (result.statusCode === 401) {
      const choice = await vscode.window.showErrorMessage(
        'Tomcat Manager 인증에 실패했습니다 (401 Unauthorized). 저장된 계정 정보가 서버의 tomcat-users.xml 과 어긋난 것 같습니다.',
        '자격 증명 초기화 후 재시작',
        '취소'
      );
      if (choice === '자격 증명 초기화 후 재시작') {
        await resetManagerUser(item.server, context.secrets);
        await manager.restart(item.server.id, status === 'debugging');
        vscode.window.showInformationMessage(
          'Manager 계정을 새로 만들고 서버를 재시작했습니다. 잠시 후(서버가 완전히 기동되면) "Reload Context Now" 를 다시 시도해주세요.'
        );
      }
      return;
    }

    vscode.window.showErrorMessage(`리로드 실패: ${result.message}`);
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

  reg('tomcat.forceRebuild', async (item: AppTreeItem) => {
    if (!item || item.app.type !== 'exploded') return;
    const channel = manager.getOutputChannel(item.server.id);
    channel?.show(true);
    channel?.appendLine(`[build] Force Rebuild Now 실행: ${item.app.contextPath || '/'}`);

    const result = await manager.forceRebuild(item.server.id, item.app.contextPath);
    if (result.reason) {
      vscode.window.showWarningMessage(`빌드를 실행할 수 없습니다: ${result.reason}`);
      return;
    }
    if (result.ok) {
      vscode.window.showInformationMessage(
        `"${item.app.contextPath}" 컴파일 및 WEB-INF/classes 동기화가 완료되었습니다.`
      );
    } else {
      vscode.window.showErrorMessage(
        `빌드가 실패했습니다. 출력 채널("Tomcat: ${item.server.name}")에서 자세한 로그를 확인하세요 ` +
          `(mvn/gradle이 PATH에 없는 경우가 흔한 원인입니다).`
      );
    }
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
