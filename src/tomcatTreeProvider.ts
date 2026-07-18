import * as vscode from 'vscode';
import { ServerManager } from './serverManager';
import { TomcatServerConfig, DeployedApp, ServerStatus } from './model';

export class ServerTreeItem extends vscode.TreeItem {
  constructor(public readonly server: TomcatServerConfig, status: ServerStatus) {
    super(server.name, vscode.TreeItemCollapsibleState.Expanded);
    this.description = `${status} : ${server.httpPort}`;
    this.contextValue = `tomcatServer-${status}`;
    this.iconPath = new vscode.ThemeIcon(iconForStatus(status), colorForStatus(status));
    this.tooltip = `${server.homePath}\nHTTP: ${server.httpPort}  Debug: ${server.debugPort}\nJAVA_HOME: ${server.javaHome ?? '(system default)'}\nLog level: ${server.logLevel ?? '(default)'}\nVM options: ${server.vmOptions ?? '(none)'}`;
  }
}

export class AppTreeItem extends vscode.TreeItem {
  constructor(public readonly server: TomcatServerConfig, public readonly app: DeployedApp) {
    super(app.contextPath || '/', vscode.TreeItemCollapsibleState.None);
    const overlay = app.sourceOverlayPath ? ` · live sync · reload:${app.reloadable ? 'auto' : 'manual'}` : '';
    this.description = (app.type === 'war' ? 'WAR' : 'exploded') + overlay;
    this.contextValue = `tomcatApp-${app.type}`;
    this.iconPath = new vscode.ThemeIcon(app.type === 'war' ? 'file-zip' : 'folder');
    this.tooltip = app.sourceOverlayPath
      ? `${app.sourcePath}\nLive source sync from: ${app.sourceOverlayPath}\nAuto context reload: ${app.reloadable ? 'on' : 'off (debugger hot-swap + manual Reload Context Now)'}`
      : app.sourcePath;
  }
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
      return element.server.deployedApps.map(app => new AppTreeItem(element.server, app));
    }
    return [];
  }
}
