import * as path from 'path';
import * as vscode from 'vscode';
import { GitAdapter } from '../git/gitAdapter';
import { StateManager } from '../state/stateManager';
import { DiffFile } from '../types';

export class FileTreeProvider implements vscode.TreeDataProvider<DiffFile> {
  private _onDidChangeTreeData = new vscode.EventEmitter<DiffFile | undefined>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private files: DiffFile[] = [];

  constructor(
    private git: GitAdapter,
    private stateManager: StateManager,
  ) {
    // A
  }

  async refresh(): Promise<void> {
    this.files = await this.git.getDiff();
    this._onDidChangeTreeData.fire(undefined);
  }

  getFiles(): DiffFile[] {
    return this.files;
  }

  getTreeItem(element: DiffFile): vscode.TreeItem {
    const filePath = element.newPath || element.oldPath;
    const fileName = path.basename(filePath);
    const dirPath = path.dirname(filePath);
    const resolved = this.stateManager.isFileResolved(filePath);

    if (resolved) {
      const item = new vscode.TreeItem(fileName, vscode.TreeItemCollapsibleState.None);
      item.description = dirPath === '.' ? '' : dirPath + '/';
      item.iconPath = new vscode.ThemeIcon('check', new vscode.ThemeColor('testing.iconPassed'));
      item.contextValue = 'diffFileResolved';
      item.command = {
        command: 'diffReviewer.openFile',
        title: 'Open Diff View',
        arguments: [element],
      };
      return item;
    }

    const statuses = this.stateManager.syncStatuses(element);
    const pendingCount = statuses.filter((s) => s === 'pending').length;
    const badge = pendingCount > 99 ? '99+' : String(pendingCount);

    const label: vscode.TreeItemLabel = {
      label: ` (${badge})  ${fileName}`,
      highlights: [[0, badge.length + 4]],
    };
    const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None);
    item.description = dirPath === '.' ? '' : dirPath + '/';
    item.contextValue = 'diffFile';
    if (element.isUntracked) {
      item.iconPath = new vscode.ThemeIcon('new-file');
    }
    item.command = {
      command: 'diffReviewer.openFile',
      title: 'Open Diff View',
      arguments: [element],
    };
    return item;
  }

  getChildren(element?: DiffFile): DiffFile[] {
    if (element) {
      return []; // flat list, no children
    }
    return this.files;
  }
}
