import * as vscode from 'vscode';
import { GitAdapter } from './git/gitAdapter';
import { FileTreeProvider } from './sidebar/fileTreeProvider';
import { DiffPanelProvider } from './webview/diffPanelProvider';
import { StateManager } from './state/stateManager';
import { DiffFile, HunkStatus, WebviewToExtMessage } from './types';
import { highlightFileContent } from './highlighter';

let git: GitAdapter;
let fileTreeProvider: FileTreeProvider;
let diffPanelProvider: DiffPanelProvider;
let stateManager: StateManager;

/** Read file content + highlight, then send to webview. */
async function getFileData(
  filePath: string,
): Promise<{ fileContent: string[]; highlightedLines: string[] }> {
  const fileContent = await git.getFileContent(filePath);
  const highlightedLines = highlightFileContent(filePath, fileContent);
  return { fileContent, highlightedLines };
}

export function activate(context: vscode.ExtensionContext) {
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
  if (!workspaceFolder) {
    vscode.window.showErrorMessage('Diff Reviewer: No workspace folder open.');
    return;
  }

  git = new GitAdapter(workspaceFolder.uri.fsPath);
  stateManager = new StateManager(git, context.workspaceState);
  fileTreeProvider = new FileTreeProvider(git, stateManager);

  // Sidebar tree view
  context.subscriptions.push(
    vscode.window.registerTreeDataProvider('diffReviewer.fileTree', fileTreeProvider),
  );

  // Webview panel provider
  diffPanelProvider = new DiffPanelProvider(
    context.extensionUri,
    handleWebviewMessage,
    handlePanelFocus,
  );
  context.subscriptions.push({ dispose: () => diffPanelProvider.dispose() });

  // Commands
  context.subscriptions.push(
    vscode.commands.registerCommand('diffReviewer.refresh', async () => {
      stateManager.clear();
      await fileTreeProvider.refresh();
    }),

    vscode.commands.registerCommand('diffReviewer.openFile', async (file: DiffFile) => {
      const filePath = file.newPath || file.oldPath;
      const statuses = stateManager.syncStatuses(file);
      const { fileContent, highlightedLines } = await getFileData(filePath);
      diffPanelProvider.showFile(file, statuses, fileContent, highlightedLines);
    }),

    vscode.commands.registerCommand('diffReviewer.approveFile', async (file: DiffFile) => {
      const filePath = file.newPath || file.oldPath;
      stateManager.syncStatuses(file);
      stateManager.approveAll(filePath, file);
      fileTreeProvider.refresh();
      const statuses = stateManager.getStatusArray(file);
      const { fileContent, highlightedLines } = await getFileData(filePath);
      diffPanelProvider.refreshFile(file, statuses, fileContent, highlightedLines);
    }),

    vscode.commands.registerCommand('diffReviewer.rejectFile', async (file: DiffFile) => {
      const filePath = file.newPath || file.oldPath;
      stateManager.syncStatuses(file);
      try {
        const updatedFile = await stateManager.rejectAll(filePath, file);
        if (updatedFile) {
          await sendRefresh(filePath, updatedFile);
        } else {
          diffPanelProvider.closeFile(filePath);
        }
        await fileTreeProvider.refresh();
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        vscode.window.showErrorMessage(`Reject all failed: ${message}`);
      }
    }),

    vscode.commands.registerCommand('diffReviewer.undo', async () => {
      const result = await stateManager.undo();
      if (!result) {
        vscode.window.showInformationMessage('Nothing to undo.');
        return;
      }

      if (result.undoneType === 'reject') {
        await refreshFilePanel(result.filePath);
      }

      await fileTreeProvider.refresh();

      if (result.undoneType === 'approve') {
        const files = fileTreeProvider.getFiles();
        const file = files.find((f) => (f.newPath || f.oldPath) === result.filePath);
        if (file) {
          await sendRefresh(result.filePath, file);
        }
      }
    }),
  );

  // File system watcher with debounce for auto-refresh
  let refreshTimer: ReturnType<typeof setTimeout> | undefined;
  const watcher = vscode.workspace.createFileSystemWatcher('**/*');

  const debouncedRefresh = () => {
    if (refreshTimer) {
      clearTimeout(refreshTimer);
    }
    refreshTimer = setTimeout(async () => {
      await fileTreeProvider.refresh();
      stateManager.pruneCommittedFiles(fileTreeProvider.getFiles());
    }, 500);
  };

  watcher.onDidChange(debouncedRefresh);
  watcher.onDidCreate(debouncedRefresh);
  watcher.onDidDelete(debouncedRefresh);
  context.subscriptions.push(watcher);

  // Initial load
  fileTreeProvider.refresh();
}

async function handlePanelFocus(filePath: string): Promise<void> {
  await fileTreeProvider.refresh();
  const files = fileTreeProvider.getFiles();
  const file = files.find((f) => (f.newPath || f.oldPath) === filePath);
  if (file) {
    const statuses = stateManager.syncStatuses(file);
    await sendRefresh(filePath, file, statuses);
  }
}

async function sendRefresh(
  filePath: string,
  file: DiffFile,
  statuses?: HunkStatus[],
): Promise<void> {
  const s = statuses || stateManager.getStatusArray(file);
  const { fileContent, highlightedLines } = await getFileData(filePath);
  diffPanelProvider.refreshFile(file, s, fileContent, highlightedLines);
}

async function handleWebviewMessage(msg: WebviewToExtMessage): Promise<void> {
  if (msg.command === 'ready') {
    return;
  }

  if (msg.command === 'openInEditor') {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (workspaceFolder) {
      const fileUri = vscode.Uri.joinPath(workspaceFolder.uri, msg.filePath);
      await vscode.window.showTextDocument(fileUri, { preview: false });
    }
    return;
  }

  if (msg.command === 'approve') {
    const files = fileTreeProvider.getFiles();
    const file = files.find((f) => (f.newPath || f.oldPath) === msg.filePath);
    const hunkId = file?.hunks[msg.hunkIndex]?.id;
    if (!hunkId) {
      return;
    }
    stateManager.approve(msg.filePath, hunkId);
    diffPanelProvider.updateHunk(msg.filePath, msg.hunkIndex, 'approved');
    fileTreeProvider.refresh();
    return;
  }

  if (msg.command === 'reject') {
    try {
      const files = fileTreeProvider.getFiles();
      const file = files.find((f) => (f.newPath || f.oldPath) === msg.filePath);
      if (!file) {
        vscode.window.showErrorMessage(`File not found in diff: ${msg.filePath}`);
        return;
      }

      const hunkId = file.hunks[msg.hunkIndex]?.id;
      if (!hunkId) {
        vscode.window.showErrorMessage(`Hunk not found at index ${msg.hunkIndex}`);
        return;
      }
      const updatedFile = await stateManager.reject(msg.filePath, hunkId, file);

      if (updatedFile) {
        await sendRefresh(msg.filePath, updatedFile);
      } else {
        diffPanelProvider.closeFile(msg.filePath);
      }

      await fileTreeProvider.refresh();
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      vscode.window.showErrorMessage(`Reject failed: ${message}`);
    }
    return;
  }

  if (msg.command === 'approveAll') {
    const files = fileTreeProvider.getFiles();
    const file = files.find((f) => (f.newPath || f.oldPath) === msg.filePath);
    if (!file) {
      return;
    }

    stateManager.approveAll(msg.filePath, file);
    await sendRefresh(msg.filePath, file);
    fileTreeProvider.refresh();
    return;
  }

  if (msg.command === 'undo') {
    const files = fileTreeProvider.getFiles();
    const file = files.find((f) => (f.newPath || f.oldPath) === msg.filePath);
    const hunkId = file?.hunks[msg.hunkIndex]?.id;
    if (!hunkId) {
      return;
    }
    stateManager.undoApprove(msg.filePath, hunkId);
    diffPanelProvider.updateHunk(msg.filePath, msg.hunkIndex, 'pending');
    fileTreeProvider.refresh();
    return;
  }

  if (msg.command === 'rejectAll') {
    const files = fileTreeProvider.getFiles();
    const file = files.find((f) => (f.newPath || f.oldPath) === msg.filePath);
    if (!file) {
      return;
    }

    try {
      const updatedFile = await stateManager.rejectAll(msg.filePath, file);
      if (updatedFile) {
        await sendRefresh(msg.filePath, updatedFile);
      } else {
        diffPanelProvider.closeFile(msg.filePath);
      }
      await fileTreeProvider.refresh();
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      vscode.window.showErrorMessage(`Reject all failed: ${message}`);
    }
  }
}

async function refreshFilePanel(filePath: string): Promise<void> {
  await fileTreeProvider.refresh();
  const files = fileTreeProvider.getFiles();
  const file = files.find((f) => (f.newPath || f.oldPath) === filePath);
  if (file) {
    const statuses = stateManager.syncStatuses(file);
    await sendRefresh(filePath, file, statuses);
  } else {
    diffPanelProvider.closeFile(filePath);
  }
}

export function deactivate() {
  // Cleanup handled by disposables
}
