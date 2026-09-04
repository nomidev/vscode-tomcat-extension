import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { ServerManager } from './serverManager';
import { TomcatTreeProvider, ServerTreeItem, AppTreeItem } from './tomcatTreeProvider';
import { findMetaInfContext, parseMetaInfContext } from './contextXml';
import { LOG_LEVELS, TomcatServerConfig } from './model';
import { detectWebappSource, isExplodedWebappFolder, resolveProjectRoot, detectBuildInfo } from './sourceOverlay';
import { buildExplodedWebapp, findExistingExplodedOutput } from './explodedBuild';
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

  // --- Hot-swap failure notifications & auto-fallback ---------------------------------
  // The Java debugger ("Debugger for Java") does its own Hot Code Replace when you save a
  // .java file while attached, entirely outside this extension's control. Its exact custom
  // Debug Adapter Protocol event schema for reporting hot-swap failures isn't something we
  // can rely on with full certainty, so this listens broadly: every custom event from a
  // debug session we recognize as one we started (name matches "Attach to <server>") gets
  // logged to that server's output channel for visibility, and anything that looks like a
  // hot-swap-related failure (event name or body mentioning both "hotcodereplace"/"hotswap"
  // and "error"/"fail") triggers a fallback.
  //
  // JDWP hot-swap is fundamentally unreliable on large/complex projects (heavy class
  // hierarchies, lots of proxying, etc.) - that's a JVM-level limitation, not specific to
  // this extension. So rather than just notifying and leaving it to the person to manually
  // click "Reload Context Now" every time it happens, `tomcat.autoReloadOnHotSwapFailure`
  // (on by default) automatically calls it for every live-reload-enabled app on that server:
  // when hot-swap works, it's the fast silent path; when it doesn't, changes still always
  // end up reflected without needing to notice the failure and intervene by hand.
  context.subscriptions.push(
    vscode.window.onDidChangeWindowState(state => {
      if (!state.focused) {
        // A short grace period, not an immediate flush: if the person saves and instantly
        // alt-tabs, the write that save triggered (or, for a .java file, the compile it
        // kicks off) may not have landed on disk yet, so flushing this very instant could
        // find nothing new to copy. A single fixed delay is a guess, though - a plain-text
        // save (e.g. a .jsp) can be near-instant, so someone who reflexively alt-tabs right
        // after Ctrl+S can still beat one delay; a .class file's compile can also just take
        // longer than expected. Flushing a few times at increasing delays instead of once
        // closes that race far more reliably - each flush is a cheap no-op once nothing new
        // has arrived since the last one, so this costs essentially nothing extra.
        for (const delayMs of [300, 800, 2000]) {
          setTimeout(() => manager.flushAllPendingSyncs(), delayMs);
        }
      }
    })
  );

  const debugSessionServers = new Map<string, TomcatServerConfig>();
  const hotSwapFallbackTimers = new Map<string, ReturnType<typeof setTimeout>>();
  // Only used when tomcat.hotSwapFallbackTrigger is 'onResume': the set of contextPaths queued
  // up to reload for a server, accumulated from every hot-swap failure seen since the last
  // flush, and flushed the next time that server's debug session resumes (DAP 'continued'
  // event - fires on Continue/Step Over/Step Into/Step Out). Snapshotting each app's "recently
  // changed" set right when the failure happens (not at resume time, which could be much
  // later) is what makes this reliable even if the person stays paused for a while.
  const pendingHotSwapApps = new Map<string, Set<string>>();

  async function flushHotSwapFallback(server: TomcatServerConfig, channel: vscode.OutputChannel | undefined) {
    const current = manager.getServer(server.id);
    const contextPaths = pendingHotSwapApps.get(server.id);
    pendingHotSwapApps.delete(server.id);
    if (!current || !contextPaths || contextPaths.size === 0) return;

    channel?.appendLine(`[debug] hot-swap 실패로 보여 자동으로 컨텍스트를 리로드합니다 (${contextPaths.size}개 앱).`);
    for (const contextPath of contextPaths) {
      await ensureContextReloaded(current, contextPath, { quiet: true });
    }
    vscode.window.showInformationMessage(
      `"${server.name}": 핫스왑이 실패한 것 같아 자동으로 컨텍스트를 리로드해 변경사항을 반영했습니다.`
    );
  }

  const warnedHotCodeReplaceServers = new Set<string>();

  context.subscriptions.push(
    vscode.debug.onDidStartDebugSession(session => {
      const server = manager.getServers().find(s => session.name === `Attach to ${s.name}`);
      if (server) {
        debugSessionServers.set(session.id, server);

        // Everything in this file about hot-swap failures/fallback only ever fires in
        // response to an *attempted* hot-swap - and vscode-java-debug only actually attempts
        // one (its own BUILD_COMPLETE handler calls the 'redefineClasses' request) when
        // java.debug.settings.hotCodeReplace is 'auto'. It defaults to 'manual', in which
        // case saves compile but nothing ever gets pushed to the JVM until the person
        // manually triggers it from the Debug toolbar - so with the default setting, none of
        // this extension's hot-swap-aware features (the failure notification, the
        // auto-reload fallback) ever have anything to react to, which looks exactly like
        // "nothing happens when I save" with no obvious cause. Nag about it once per
        // VSCode session (not every debug start) rather than silently doing nothing.
        const hotCodeReplace = vscode.workspace.getConfiguration('java.debug.settings').get<string>('hotCodeReplace');
        if (hotCodeReplace !== 'auto' && !warnedHotCodeReplaceServers.has(server.id)) {
          warnedHotCodeReplaceServers.add(server.id);
          vscode.window
            .showWarningMessage(
              `"${server.name}": java.debug.settings.hotCodeReplace 가 "${hotCodeReplace ?? 'manual'}" 로 되어 있어, ` +
                '저장해도 핫스왑(코드 교체)이 자동으로 시도되지 않습니다. 이 상태에서는 핫스왑 실패 감지·자동 리로드 등 ' +
                '이 확장의 관련 기능도 반응할 일이 없습니다. "auto"로 바꾸는 걸 권장합니다.',
              '설정 열기'
            )
            .then(choice => {
              if (choice === '설정 열기') {
                vscode.commands.executeCommand('workbench.action.openSettings', 'java.debug.settings.hotCodeReplace');
              }
            });
        }
      }
    })
  );

  context.subscriptions.push(
    vscode.debug.onDidTerminateDebugSession(session => {
      debugSessionServers.delete(session.id);
    })
  );

  // Standard DAP events (as opposed to the custom hotcodereplace ones above) don't come
  // through onDidReceiveDebugSessionCustomEvent - a DebugAdapterTracker is the only way to
  // observe them. This exists solely to detect 'continued' (execution resuming after being
  // stopped, i.e. Continue/Step Over/Step Into/Step Out - "leaving the current frame") for
  // the 'onResume' hotSwapFallbackTrigger mode.
  context.subscriptions.push(
    vscode.debug.registerDebugAdapterTrackerFactory('java', {
      createDebugAdapterTracker(session) {
        return {
          onDidSendMessage(message: any) {
            if (message?.type !== 'event' || message.event !== 'continued') return;
            const server = debugSessionServers.get(session.id);
            if (!server || !pendingHotSwapApps.has(server.id)) return;
            void flushHotSwapFallback(server, manager.getOutputChannel(server.id));
          }
        };
      }
    })
  );

  context.subscriptions.push(
    vscode.debug.onDidReceiveDebugSessionCustomEvent(e => {
      const server = debugSessionServers.get(e.session.id);
      if (!server) return;

      const channel = manager.getOutputChannel(server.id);
      channel?.appendLine(`[debug] custom event: ${e.event} ${JSON.stringify(e.body ?? {})}`);

      const eventName = (e.event ?? '').toLowerCase();
      const mentionsHotSwap = eventName.includes('hotcodereplace') || eventName.includes('hotswap');
      // Match vscode-java-debug's own logic exactly (see its hotCodeReplace.ts,
      // handleHotCodeReplaceCustomEvent): it treats changeType ERROR *and* WARNING as failure
      // - both trigger its own "Would you like to restart the debug session?" prompt. Our
      // earlier regex over JSON.stringify(body) only ever matched "error"/"fail", so a
      // WARNING event (a real, actively-used value - not just one we were being defensive
      // about) would trigger that VSCode-side prompt while our fallback stayed silent.
      // Checking the actual field is also just more correct than pattern-matching stringified
      // JSON.
      const changeType = String((e.body as { changeType?: string } | undefined)?.changeType ?? '').toUpperCase();
      const mentionsFailure = changeType === 'ERROR' || changeType === 'WARNING';
      if (!mentionsHotSwap || !mentionsFailure) return;

      const autoReload = vscode.workspace
        .getConfiguration('tomcat')
        .get<boolean>('autoReloadOnHotSwapFailure', true);

      if (!autoReload) {
        vscode.window.showWarningMessage(
          `"${server.name}" 에서 핫스왑(코드 교체)이 실패한 것 같습니다. 필드/메서드/클래스 추가 같은 구조적 변경이라면 정상적인 제약이니, 배포된 앱을 우클릭해 "Reload Context Now" 로 반영해보세요.`
        );
        return;
      }

      const current = manager.getServer(server.id);
      if (!current) return;
      const liveApps = current.deployedApps.filter(a => a.type === 'exploded' && a.sourceOverlayPath);
      if (liveApps.length === 0) return;

      // A save only ever recompiles the project(s) you actually edited, so narrow down to the
      // app(s) whose WEB-INF/classes really changed recently instead of reloading every
      // live-synced app on the server (which used to happen here - unnecessarily
      // killing/restarting Spring/Quartz/etc. in completely unrelated apps on every hot-swap
      // failure). Snapshotting this now (not later, at execution time) matters most for
      // 'onResume' mode below, where execution could happen minutes after this event; 10s is
      // generous slack for a slow compile right after the save that triggered this failure.
      // If nothing qualifies (e.g. javaAutoBuild is off, or timing was unlucky) we fall back
      // to "reload everything live" so a real failure is never silently missed.
      const recentlyChangedPaths = new Set(manager.getRecentlyChangedApps(server.id, 10_000));
      const targets = (recentlyChangedPaths.size > 0 ? liveApps.filter(a => recentlyChangedPaths.has(a.contextPath)) : liveApps).map(
        a => a.contextPath
      );

      const trigger = vscode.workspace
        .getConfiguration('tomcat')
        .get<'immediate' | 'onResume'>('hotSwapFallbackTrigger', 'immediate');

      if (trigger === 'onResume') {
        // Just queue it - flushHotSwapFallback() runs the next time this session's debug
        // adapter reports a 'continued' event (see registerDebugAdapterTrackerFactory above).
        // Accumulate rather than overwrite, since more than one app/file can fail to hot-swap
        // while the person stays paused before resuming.
        const pending = pendingHotSwapApps.get(server.id) ?? new Set<string>();
        for (const contextPath of targets) pending.add(contextPath);
        pendingHotSwapApps.set(server.id, pending);
        channel?.appendLine(
          `[debug] hot-swap 실패로 보여 컨텍스트 리로드를 대기열에 넣었습니다 (${pending.size}개 앱, 실행 재개 시 반영).`
        );
        return;
      }

      // 'immediate' mode (default): debounce per server, since a single failed hot-swap
      // attempt can emit more than one custom event in quick succession, and we only want to
      // reload once per actual save, not once per event.
      const pending = pendingHotSwapApps.get(server.id) ?? new Set<string>();
      for (const contextPath of targets) pending.add(contextPath);
      pendingHotSwapApps.set(server.id, pending);

      const existingTimer = hotSwapFallbackTimers.get(server.id);
      if (existingTimer) clearTimeout(existingTimer);
      hotSwapFallbackTimers.set(
        server.id,
        setTimeout(() => {
          hotSwapFallbackTimers.delete(server.id);
          void flushHotSwapFallback(server, channel);
        }, 500)
      );
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

    // Reload Context Now just re-reads whatever bytes are currently sitting in
    // WEB-INF/classes/docBase - if tomcat.syncTrigger is 'onWindowBlur', a very recent edit's
    // compile/write might not have landed yet even though nothing after it changed focus.
    // A short grace period (not a full-tree re-scan - see flushNow()'s doc comment) gives
    // that time to catch up before we force the flush, so the reload never picks up stale
    // files. Skipped in the default 'onChange' mode, which doesn't need it (its own 250ms
    // debounce already keeps things current) and where adding a delay to every single reload
    // would be pure overhead.
    if (manager.getSyncTrigger() === 'onWindowBlur') {
      await new Promise(resolve => setTimeout(resolve, 600));
    }
    manager.flushPendingSyncsForServer(server.id);

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
      openLabel: '배포할 웹앱 폴더 선택 (WEB-INF 포함 폴더, 또는 아직 빌드 전인 Maven/Gradle 프로젝트 폴더)'
    });
    if (!uris || uris.length === 0) return;
    let folderPath = uris[0].fsPath;

    // If the selected folder isn't already a built exploded webapp (no WEB-INF), see if it's
    // - or sits inside - a Maven/Gradle project we can build for them instead of just failing.
    // Lets people point this command straight at their project folder before ever running a
    // build themselves, instead of requiring an already-built target/<name> folder to exist.
    let builtFromProjectRoot: string | undefined;
    if (!isExplodedWebappFolder(folderPath)) {
      const projectRoot = resolveProjectRoot(folderPath);
      const buildInfo = projectRoot ? detectBuildInfo(projectRoot) : undefined;
      if (!buildInfo || !projectRoot) {
        vscode.window.showErrorMessage(
          `선택한 폴더는 아직 빌드되지 않은 것 같고(WEB-INF 없음), Maven/Gradle 프로젝트도 찾지 못했습니다. ` +
            `이미 빌드된 exploded 폴더(WEB-INF 포함)를 선택하거나, 프로젝트를 먼저 빌드한 뒤 다시 시도해주세요.`
        );
        return;
      }

      const toolLabel = buildInfo.tool === 'maven' ? 'Maven' : 'Gradle';

      // The user may have picked the project root of an app that's *already* built (a common
      // habit, especially now that this command also accepts unbuilt project folders) rather
      // than the build output folder itself - don't tell them it isn't built when it is.
      const existing = findExistingExplodedOutput(buildInfo);
      if (existing) {
        const choice = await vscode.window.showQuickPick(
          [
            { label: '$(check) 기존 빌드 사용', description: existing, value: 'use' as const },
            { label: '$(sync) 다시 빌드', description: `${toolLabel} 빌드를 새로 실행합니다`, value: 'rebuild' as const }
          ],
          { placeHolder: `이미 빌드된 폴더를 찾았습니다: ${existing}` }
        );
        if (!choice) return;
        if (choice.value === 'use') {
          folderPath = existing;
          builtFromProjectRoot = projectRoot;
        }
      }

      // Either nothing existing was found, or the user asked to rebuild.
      if (folderPath === uris[0].fsPath) {
        const proceed = await vscode.window.showInformationMessage(
          `"${folderPath}" 는 아직 빌드된 웹앱이 아닙니다. 감지된 ${toolLabel} 프로젝트(${projectRoot})를 지금 빌드해서 자동으로 exploded 배포로 등록할까요?`,
          { modal: true },
          '빌드 후 배포'
        );
        if (proceed !== '빌드 후 배포') return;

        const buildChannel = vscode.window.createOutputChannel(`Tomcat: Build (${path.basename(projectRoot)})`);
        buildChannel.clear();
        buildChannel.show(true);

        const result = await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: `${toolLabel} 빌드로 exploded 웹앱 생성 중...`,
            cancellable: false
          },
          () =>
            buildExplodedWebapp(buildInfo, {
              mavenCommand: manager.getMavenCommand(),
              gradleCommand: manager.getGradleCommand(),
              javaHome: item.server.javaHome,
              log: msg => buildChannel.appendLine(msg)
            })
        );

        if (!result.ok || !result.explodedPath) {
          vscode.window.showErrorMessage(
            `자동 빌드에 실패했습니다${result.message ? `: ${result.message}` : ''}. 자세한 내용은 "${buildChannel.name}" 출력 채널을 확인하세요.`
          );
          return;
        }

        folderPath = result.explodedPath;
        builtFromProjectRoot = projectRoot;
      }
    }

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

    // When we had to auto-build the app, prefer the project root's own folder name over the
    // build output folder's name (e.g. Maven's finalName, often something like
    // "myapp-1.0-SNAPSHOT") as the default context path - it reads much more naturally.
    const defaultName =
      (useDetected && detected?.path !== undefined
        ? detected.path.replace(/^\/+/, '') || 'ROOT'
        : undefined) ?? path.basename(builtFromProjectRoot ?? folderPath);

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
        `${builtFromProjectRoot ? ` (자동 빌드된 폴더 사용: ${folderPath})` : ''}` +
        `${sourceOverlayPath ? ` (라이브 소스 오버레이: ${sourceOverlayPath})` : ''}. ` +
        (running
          ? 'Tomcat 이 자동으로(보통 수 초 내) 감지해 배포합니다. 전체 서버 재시작은 필요 없습니다.'
          : '서버를 시작하면 반영됩니다.') +
        (sourceOverlayPath
          ? ` JSP/정적 파일은 이후 저장 즉시 반영되고, target/classes(또는 build/classes 등)에 컴파일된 클래스/리소스도 변경 즉시 WEB-INF/classes 로 자동 동기화됩니다(컴파일 자체는 VSCode의 Java 자동 빌드 등 기존 빌드 도구가 담당). ` +
            (reloadable
              ? '자동 컨텍스트 리로드가 켜져 있어 클래스 변경 시 Tomcat 이 컨텍스트를 자동으로 다시 로드합니다.'
              : '자동 컨텍스트 리로드는 꺼져있어(reloadable=false) 메서드 본문 변경은 디버거 핫스왑으로, 필드/메서드/클래스 추가 같은 구조적 변경은 "Reload Context Now" 로 반영하세요.')
          : ' 이후 재빌드 시에는 서버 재시작 없이 즉시 반영됩니다.')
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

  reg('tomcat.buildNow', async (item: AppTreeItem) => {
    if (!item || item.app.type !== 'exploded') return;
    const channel = manager.getOutputChannel(item.server.id);
    channel?.show(true);
    channel?.appendLine(`[build] Build Now 실행: ${item.app.contextPath || '/'}`);

    const result = await manager.buildNow(item.server.id, item.app.contextPath);
    if (!result.ok) {
      vscode.window.showErrorMessage(
        `빌드에 실패했습니다${result.reason ? `: ${result.reason}` : ''}. 출력 채널("Tomcat: ${item.server.name}")에서 자세한 로그를 확인하세요.`
      );
      return;
    }

    vscode.window.showInformationMessage(
      `"${item.app.contextPath}" 빌드 및 WEB-INF/classes 동기화가 완료되었습니다.`
    );

    // Classes just changed on disk. If this app's context isn't set to auto-reload, nothing
    // will pick that up on its own - offer the one-click way to actually apply it now.
    if (!item.app.reloadable) {
      const status = manager.getStatus(item.server.id);
      if (status === 'running' || status === 'debugging') {
        const choice = await vscode.window.showInformationMessage(
          '자동 컨텍스트 리로드가 꺼져 있어(reloadable=false), 방금 빌드한 클래스는 디버거 핫스왑이나 수동 리로드가 있어야 반영됩니다. 지금 리로드할까요?',
          '지금 리로드',
          '나중에'
        );
        if (choice === '지금 리로드') {
          await ensureContextReloaded(item.server, item.app.contextPath);
        }
      }
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
