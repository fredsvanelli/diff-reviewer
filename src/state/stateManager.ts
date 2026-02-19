import * as vscode from 'vscode';
import { DiffFile, DiffHunk, HunkStatus, UndoEntry } from '../types';
import { GitAdapter } from '../git/gitAdapter';

const STORAGE_KEY = 'diffReviewer.hunkStatuses';

export class StateManager {
  /** filePath → Map<hunkId, HunkStatus> */
  private statuses = new Map<string, Map<string, HunkStatus>>();
  private undoStack: UndoEntry[] = [];

  constructor(
    private git: GitAdapter,
    private storage?: vscode.Memento,
  ) {
    if (this.storage) {
      this.restoreFromStorage();
    }
  }

  /**
   * Sync statuses for a file: look up each hunk's ID in the map.
   * Returns ordered HunkStatus[] matching file.hunks order for the webview.
   * Stale IDs (hunks no longer in diff) are dropped.
   */
  syncStatuses(file: DiffFile): HunkStatus[] {
    const path = file.newPath || file.oldPath;
    const existing = this.statuses.get(path);

    if (!existing || existing.size === 0) {
      const map = new Map<string, HunkStatus>();
      for (const hunk of file.hunks) {
        if (hunk.id) {
          map.set(hunk.id, 'pending');
        }
      }
      this.statuses.set(path, map);
      this.persist();
      return file.hunks.map(() => 'pending');
    }

    // Build new map with only hunks present in the current diff
    const newMap = new Map<string, HunkStatus>();
    for (const hunk of file.hunks) {
      if (hunk.id) {
        newMap.set(hunk.id, existing.get(hunk.id) || 'pending');
      }
    }
    this.statuses.set(path, newMap);
    this.persist();

    return file.hunks.map((h) => (h.id ? newMap.get(h.id) || 'pending' : 'pending'));
  }

  /**
   * Get statuses as an ordered array matching file.hunks order.
   */
  getStatusArray(file: DiffFile): HunkStatus[] {
    const path = file.newPath || file.oldPath;
    const map = this.statuses.get(path);
    if (!map) {
      return file.hunks.map(() => 'pending');
    }
    return file.hunks.map((h) => (h.id ? map.get(h.id) || 'pending' : 'pending'));
  }

  /**
   * @deprecated Use getStatusArray(file) instead. Kept for undo flow where file may not be available.
   */
  getStatuses(filePath: string): HunkStatus[] {
    const map = this.statuses.get(filePath);
    if (!map) {
      return [];
    }
    return Array.from(map.values());
  }

  /**
   * Check if all hunks in a file are resolved (all approved).
   */
  isFileResolved(filePath: string): boolean {
    const map = this.statuses.get(filePath);
    if (!map || map.size === 0) {
      return false;
    }
    for (const status of map.values()) {
      if (status !== 'approved') {
        return false;
      }
    }
    return true;
  }

  /**
   * Mark a hunk as approved by hunkId.
   */
  approve(filePath: string, hunkId: string): void {
    const map = this.statuses.get(filePath);
    if (!map || !map.has(hunkId)) {
      return;
    }
    map.set(hunkId, 'approved');
    this.undoStack.push({ type: 'approve', filePath, hunkId });
    this.persist();
  }

  /**
   * Approve all pending hunks in a file.
   */
  approveAll(filePath: string, file: DiffFile): void {
    const map = this.statuses.get(filePath);
    if (!map) {
      return;
    }
    for (const hunk of file.hunks) {
      if (hunk.id && map.get(hunk.id) === 'pending') {
        map.set(hunk.id, 'approved');
        this.undoStack.push({ type: 'approve', filePath, hunkId: hunk.id });
      }
    }
    this.persist();
  }

  /**
   * Reject all pending hunks in a file, one at a time (re-parsing after each).
   */
  async rejectAll(filePath: string, file: DiffFile): Promise<DiffFile | null> {
    let currentFile: DiffFile | null = file;

    while (currentFile) {
      const map = this.statuses.get(filePath);
      if (!map) {
        break;
      }

      // Find first pending hunk
      let pendingHunkId: string | undefined;
      for (const hunk of currentFile.hunks) {
        if (hunk.id && map.get(hunk.id) === 'pending') {
          pendingHunkId = hunk.id;
          break;
        }
      }
      if (!pendingHunkId) {
        break;
      }

      currentFile = await this.reject(filePath, pendingHunkId, currentFile);
    }

    return currentFile;
  }

  /**
   * Reject a hunk: reverse-apply it on disk via git apply -R.
   * Returns the updated DiffFile after re-parsing.
   */
  async reject(filePath: string, hunkId: string, file: DiffFile): Promise<DiffFile | null> {
    const hunk = file.hunks.find((h) => h.id === hunkId);
    if (!hunk) {
      return null;
    }

    const patch = buildPatch(file, hunk);
    const forwardPatch = patch;

    await this.git.applyReverse(patch);

    this.undoStack.push({ type: 'reject', filePath, hunkId, forwardPatch });

    const map = this.statuses.get(filePath);
    if (map) {
      map.delete(hunkId);
    }

    // Re-parse the file diff to get updated line numbers
    const freshFiles = await this.git.getFileDiff(filePath);
    if (freshFiles.length === 0) {
      this.statuses.delete(filePath);
      this.persist();
      return null;
    }

    const freshFile = freshFiles[0];
    this.syncStatuses(freshFile);
    return freshFile;
  }

  /**
   * Undo a specific approval (reset to pending).
   */
  undoApprove(filePath: string, hunkId: string): void {
    const map = this.statuses.get(filePath);
    if (map && map.get(hunkId) === 'approved') {
      map.set(hunkId, 'pending');
      // Remove matching undo entry from the stack
      for (let i = this.undoStack.length - 1; i >= 0; i--) {
        const e = this.undoStack[i];
        if (e.type === 'approve' && e.filePath === filePath && e.hunkId === hunkId) {
          this.undoStack.splice(i, 1);
          break;
        }
      }
      this.persist();
    }
  }

  /**
   * Undo the last action. Returns the affected filePath or null if stack is empty.
   */
  async undo(): Promise<{ filePath: string; undoneType: 'approve' | 'reject' } | null> {
    const entry = this.undoStack.pop();
    if (!entry) {
      return null;
    }

    if (entry.type === 'approve') {
      const map = this.statuses.get(entry.filePath);
      if (map && map.has(entry.hunkId)) {
        map.set(entry.hunkId, 'pending');
      }
    } else if (entry.type === 'reject' && entry.forwardPatch) {
      await this.git.applyForward(entry.forwardPatch);
    }

    this.persist();
    return { filePath: entry.filePath, undoneType: entry.type };
  }

  /**
   * Clear all state (e.g., on full refresh).
   */
  clear(): void {
    this.statuses.clear();
    this.undoStack = [];
    this.persist();
  }

  /**
   * Remove files that are no longer in the diff (e.g., after a commit).
   */
  pruneCommittedFiles(currentDiffFiles: DiffFile[]): void {
    const currentPaths = new Set(currentDiffFiles.map((f) => f.newPath || f.oldPath));
    let changed = false;
    for (const path of this.statuses.keys()) {
      if (!currentPaths.has(path)) {
        this.statuses.delete(path);
        changed = true;
      }
    }
    if (changed) {
      this.persist();
    }
  }

  private persist(): void {
    if (!this.storage) {
      return;
    }
    const data: Record<string, Record<string, HunkStatus>> = {};
    for (const [filePath, map] of this.statuses) {
      const obj: Record<string, HunkStatus> = {};
      for (const [id, status] of map) {
        // Only persist approved (pending is default, rejected hunks are gone)
        if (status === 'approved') {
          obj[id] = status;
        }
      }
      if (Object.keys(obj).length > 0) {
        data[filePath] = obj;
      }
    }
    this.storage.update(STORAGE_KEY, data);
  }

  private restoreFromStorage(): void {
    if (!this.storage) {
      return;
    }
    const data = this.storage.get<Record<string, Record<string, HunkStatus>>>(STORAGE_KEY);
    if (!data) {
      return;
    }
    for (const [filePath, obj] of Object.entries(data)) {
      const map = new Map<string, HunkStatus>();
      for (const [id, status] of Object.entries(obj)) {
        map.set(id, status);
      }
      this.statuses.set(filePath, map);
    }
  }
}

/**
 * Build a valid unified diff patch string for a single hunk,
 * suitable for piping to `git apply`.
 */
function buildPatch(file: DiffFile, hunk: DiffHunk): string {
  const lines: string[] = [];

  lines.push(`--- a/${file.oldPath || file.newPath}`);
  lines.push(`+++ b/${file.newPath || file.oldPath}`);

  for (const rawLine of hunk.rawLines) {
    lines.push(rawLine);
  }

  return lines.join('\n') + '\n';
}
