import * as vscode from 'vscode';
import { ServerManager } from './serverManager';
import { TomcatServerConfig, DeployedApp, ServerStatus, AppStatus } from './model';

function statusLabel(status: ServerStatus): string {
  switch (status) {
    case 'running': return '● 실행 중';
    case 'debugging': return '● 디버그 중';
    case 'starting': return '◐ 시작 중...';
    case 'stopping': return '◐ 중지 중...';
    default: return '○ 중지됨';
  }
}

function isLive(status: ServerStatus): boolean {
  return status === 'running' || status === 'debugging';
}

function appStatusLabel(status: AppStatus): string {
  switch (status) {
    case 'running': return '● 실행 중';
    case 'deploying': return '◐ 배포 중...';
    case 'failed': return '✕ 배포 실패';
    default: return '○ 중지됨';
  }
}

function isAppLive(status: AppStatus): boolean {
  return status === 'running';
}

export class ServerTreeItem extends vscode.TreeItem {
  constructor(public readonly server: TomcatServerConfig, public readonly status: ServerStatus) {
    super(server.name, vscode.TreeItemCollapsibleState.Expanded);
    this.description = `${statusLabel(status)} · :${server.httpPort}`;
    this.contextValue = `tomcatServer-${status}`;
    this.iconPath = new vscode.ThemeIcon(iconForStatus(status), colorForStatus(status));
    this.tooltip = `${server.homePath}\n상태: ${statusLabel(status)}\nHTTP: ${server.httpPort}  Debug: ${server.debugPort}\nJAVA_HOME: ${server.javaHome ?? '(system default)'}\nLog level: ${server.logLevel ?? '(default)'}\nVM options: ${server.vmOptions ?? '(none)'}`;
  }
}

export class AppTreeItem extends vscode.TreeItem {
  constructor(public readonly server: TomcatServerConfig, public readonly app: DeployedApp, appStatus: AppStatus) {
    super(app.contextPath || '/', vscode.TreeItemCollapsibleState.None);
    const live = isAppLive(appStatus);
    const overlay = app.sourceOverlayPath ? ` · live sync · reload:${app.reloadable ? 'auto' : 'manual'}` : '';
    this.description = `${appStatusLabel(appStatus)} · ${app.type === 'war' ? 'WAR' : 'exploded'}${overlay}`;
    this.contextValue = `tomcatApp-${app.type}`;
    this.iconPath = new vscode.ThemeIcon(
      appIconForStatus(app.type, appStatus),
      live ? new vscode.ThemeColor('testing.iconPassed') : appStatus === 'failed' ? new vscode.ThemeColor('testing.iconFailed') : undefined
    );
    const liveNote =
      appStatus === 'running'
        ? '이 앱은 정상적으로 배포되어 서비스되고 있습니다.'
        : appStatus === 'deploying'
        ? '서버가 이 앱을 배포하는 중입니다. 앱이 크거나 초기화 로직이 무거우면 서버 자체는 떠도 이 앱만 잠시 더 걸릴 수 있습니다.'
        : appStatus === 'failed'
        ? '이 앱은 배포/기동 중 오류가 발생해 서비스되지 않고 있습니다. Output 채널의 로그를 확인하세요.'
        : '서버가 중지되어 있어 이 앱은 현재 서비스되고 있지 않습니다. 서버를 시작하면 반영됩니다.';
    this.tooltip = app.sourceOverlayPath
      ? `${app.sourcePath}\n${liveNote}\nLive source sync from: ${app.sourceOverlayPath}\nAuto context reload: ${app.reloadable ? 'on' : 'off (debugger hot-swap + manual Reload Context Now)'}`
      : `${app.sourcePath}\n${liveNote}`;
  }
}

function appIconForStatus(type: 'war' | 'exploded', status: AppStatus): string {
  if (status === 'deploying') return 'sync~spin';
  if (status === 'failed') return 'error';
  return type === 'war' ? 'file-zip' : 'folder';
}

function iconForStatus(status: ServerStatus): string {
  switch (status) {
    case 'running': return 'vm-active';
    case 'debugging': return 'debug-alt';
    case 'starting':
    case 'stopping': return 'sync~spin';
    default: return 'vm';
  }
}

function colorForStatus(status: ServerStatus): vscode.ThemeColor | undefined {
  if (status === 'running' || status === 'debugging') {
    return new vscode.ThemeColor('testing.iconPassed');
  }
  return undefined;
}

type Node = ServerTreeItem | AppTreeItem;

export class TomcatTreeProvider implements vscode.TreeDataProvider<Node> {
  private _onDidChangeTreeData = new vscode.EventEmitter<Node | undefined | void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  constructor(private manager: ServerManager) {
    manager.onDidChange(() => this.refresh());
  }

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element: Node): vscode.TreeItem {
    return element;
  }

  getChildren(element?: Node): Node[] {
    if (!element) {
      return this.manager.getServers().map(
        s => new ServerTreeItem(s, this.manager.getStatus(s.id))
      );
    }
    if (element instanceof ServerTreeItem) {
      return element.server.deployedApps.map(
        app => new AppTreeItem(element.server, app, this.manager.getAppStatus(element.server.id, app.contextPath))
      );
    }
    return [];
  }
}
