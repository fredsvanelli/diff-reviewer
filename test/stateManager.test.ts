import * as assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import type * as vscode from 'vscode';
import { GitAdapter } from '../src/git/gitAdapter';
import { StateManager } from '../src/state/stateManager';
import { DiffFile, DiffHunk } from '../src/types';

// Minimal mock of GitAdapter
class MockGitAdapter {
  appliedReverse: string[] = [];
  appliedForward: string[] = [];
  nextFileDiff: DiffFile[] = [];

  async applyReverse(patch: string) {
    this.appliedReverse.push(patch);
  }

  async applyForward(patch: string) {
    this.appliedForward.push(patch);
  }

  async getFileDiff(_filePath: string): Promise<DiffFile[]> {
    return this.nextFileDiff;
  }

  async getDiff(): Promise<DiffFile[]> {
    return this.nextFileDiff;
  }
}

// Mock vscode.Memento for persistence tests
class MockMemento {
  private store = new Map<string, unknown>();
  get<T>(key: string): T | undefined {
    return this.store.get(key) as T | undefined;
  }
  async update(key: string, value: unknown): Promise<void> {
    this.store.set(key, value);
  }
}

let hunkCounter = 0;

function makeHunk(overrides: Partial<DiffHunk> = {}): DiffHunk {
  const id = `hunk-${++hunkCounter}`;
  return {
    oldStart: 1,
    oldCount: 3,
    newStart: 1,
    newCount: 4,
    header: '@@ -1,3 +1,4 @@',
    lines: [
      { type: 'context', content: 'hello' },
      { type: 'remove', content: 'world' },
      { type: 'add', content: 'beautiful world' },
      { type: 'add', content: 'today' },
      { type: 'context', content: 'end' },
    ],
    rawLines: ['@@ -1,3 +1,4 @@', ' hello', '-world', '+beautiful world', '+today', ' end'],
    id,
    ...overrides,
  };
}

function makeFile(hunks: DiffHunk[] = [makeHunk()]): DiffFile {
  return {
    oldPath: 'test.txt',
    newPath: 'test.txt',
    hunks,
    isBinary: false,
    diffHeader: ['--- a/test.txt', '+++ b/test.txt'],
  };
}

describe('StateManager', () => {
  let git: MockGitAdapter;
  let state: StateManager;

  beforeEach(() => {
    git = new MockGitAdapter();
    hunkCounter = 0;
    state = new StateManager(git as unknown as GitAdapter);
  });

  describe('syncStatuses', () => {
    it('initializes all hunks as pending', () => {
      const file = makeFile([makeHunk(), makeHunk()]);
      const statuses = state.syncStatuses(file);
      assert.deepEqual(statuses, ['pending', 'pending']);
    });

    it('preserves existing statuses on re-sync by hunk ID', () => {
      const hunk1 = makeHunk({ id: 'aaa' });
      const hunk2 = makeHunk({ id: 'bbb' });
      const file = makeFile([hunk1, hunk2]);
      state.syncStatuses(file);
      state.approve('test.txt', 'aaa');

      const statuses = state.syncStatuses(file);
      assert.equal(statuses[0], 'approved');
      assert.equal(statuses[1], 'pending');
    });

    it('drops stale IDs not in current diff', () => {
      const hunk1 = makeHunk({ id: 'aaa' });
      const hunk2 = makeHunk({ id: 'bbb' });
      const file = makeFile([hunk1, hunk2]);
      state.syncStatuses(file);
      state.approve('test.txt', 'aaa');
      state.approve('test.txt', 'bbb');

      // Re-sync with only hunk2 remaining
      const newFile = makeFile([hunk2]);
      const statuses = state.syncStatuses(newFile);
      assert.deepEqual(statuses, ['approved']);
    });
  });

  describe('approve', () => {
    it('marks hunk as approved by ID', () => {
      const hunk = makeHunk({ id: 'test-id' });
      const file = makeFile([hunk]);
      state.syncStatuses(file);
      state.approve('test.txt', 'test-id');

      const statuses = state.getStatusArray(file);
      assert.equal(statuses[0], 'approved');
    });

    it('ignores unknown hunk ID', () => {
      const file = makeFile();
      state.syncStatuses(file);
      state.approve('test.txt', 'nonexistent'); // Should not throw
    });
  });

  describe('reject', () => {
    it('calls git applyReverse with a valid patch', async () => {
      const hunk = makeHunk({ id: 'reject-me' });
      const file = makeFile([hunk]);
      state.syncStatuses(file);

      git.nextFileDiff = [];

      await state.reject('test.txt', 'reject-me', file);

      assert.equal(git.appliedReverse.length, 1);
      const patch = git.appliedReverse[0];
      assert.ok(patch.includes('--- a/test.txt'));
      assert.ok(patch.includes('+++ b/test.txt'));
      assert.ok(patch.includes('@@ -1,3 +1,4 @@'));
    });

    it('returns null when no more hunks remain', async () => {
      const hunk = makeHunk({ id: 'only-one' });
      const file = makeFile([hunk]);
      state.syncStatuses(file);
      git.nextFileDiff = [];

      const result = await state.reject('test.txt', 'only-one', file);
      assert.equal(result, null);
    });

    it('returns updated file when hunks remain', async () => {
      const hunk1 = makeHunk({ id: 'h1' });
      const hunk2 = makeHunk({ id: 'h2' });
      const file = makeFile([hunk1, hunk2]);
      state.syncStatuses(file);

      const remainingFile = makeFile([makeHunk({ id: 'h2-fresh' })]);
      git.nextFileDiff = [remainingFile];

      const result = await state.reject('test.txt', 'h1', file);
      assert.ok(result);
      assert.equal(result!.hunks.length, 1);
    });
  });

  describe('undo', () => {
    it('returns null when stack is empty', async () => {
      const result = await state.undo();
      assert.equal(result, null);
    });

    it('undoes an approve by resetting to pending', async () => {
      const hunk = makeHunk({ id: 'undo-me' });
      const file = makeFile([hunk]);
      state.syncStatuses(file);
      state.approve('test.txt', 'undo-me');

      const result = await state.undo();
      assert.ok(result);
      assert.equal(result!.undoneType, 'approve');
      assert.equal(state.getStatusArray(file)[0], 'pending');
    });

    it('undoes a reject by calling applyForward', async () => {
      const hunk = makeHunk({ id: 'reject-then-undo' });
      const file = makeFile([hunk]);
      state.syncStatuses(file);
      git.nextFileDiff = [];

      await state.reject('test.txt', 'reject-then-undo', file);

      const result = await state.undo();
      assert.ok(result);
      assert.equal(result!.undoneType, 'reject');
      assert.equal(git.appliedForward.length, 1);
    });
  });

  describe('isFileResolved', () => {
    it('returns false when hunks are pending', () => {
      const file = makeFile([makeHunk({ id: 'a' }), makeHunk({ id: 'b' })]);
      state.syncStatuses(file);
      assert.equal(state.isFileResolved('test.txt'), false);
    });

    it('returns true when all hunks are approved', () => {
      const file = makeFile([makeHunk({ id: 'a' }), makeHunk({ id: 'b' })]);
      state.syncStatuses(file);
      state.approve('test.txt', 'a');
      state.approve('test.txt', 'b');
      assert.equal(state.isFileResolved('test.txt'), true);
    });

    it('returns false for unknown file', () => {
      assert.equal(state.isFileResolved('unknown.txt'), false);
    });
  });

  describe('approveAll', () => {
    it('approves all pending hunks', () => {
      const hunks = [makeHunk({ id: 'x' }), makeHunk({ id: 'y' }), makeHunk({ id: 'z' })];
      const file = makeFile(hunks);
      state.syncStatuses(file);
      state.approveAll('test.txt', file);

      const statuses = state.getStatusArray(file);
      assert.deepEqual(statuses, ['approved', 'approved', 'approved']);
      assert.equal(state.isFileResolved('test.txt'), true);
    });

    it('skips already approved hunks', () => {
      const hunks = [makeHunk({ id: 'x' }), makeHunk({ id: 'y' })];
      const file = makeFile(hunks);
      state.syncStatuses(file);
      state.approve('test.txt', 'x');
      state.approveAll('test.txt', file);

      const statuses = state.getStatusArray(file);
      assert.deepEqual(statuses, ['approved', 'approved']);
    });
  });

  describe('rejectAll', () => {
    it('rejects all pending hunks', async () => {
      const hunks = [makeHunk({ id: 'r1' }), makeHunk({ id: 'r2' })];
      const file = makeFile(hunks);
      state.syncStatuses(file);

      const oneHunkFile = makeFile([makeHunk({ id: 'r2-fresh' })]);

      let rejectCount = 0;
      git.getFileDiff = async (_filePath: string) => {
        rejectCount++;
        if (rejectCount >= 2) {
          return [];
        }
        return [oneHunkFile];
      };

      const result = await state.rejectAll('test.txt', file);
      assert.equal(result, null);
      assert.equal(git.appliedReverse.length, 2);
    });
  });

  describe('clear', () => {
    it('resets all state', async () => {
      const hunk = makeHunk({ id: 'c1' });
      const file = makeFile([hunk]);
      state.syncStatuses(file);
      state.approve('test.txt', 'c1');

      state.clear();
      assert.deepEqual(state.getStatusArray(file), ['pending']);
      const undoResult = await state.undo();
      assert.equal(undoResult, null);
    });
  });

  describe('approved status survives hunk index shift', () => {
    it('preserves approval when hunk moves to different index after new edits', () => {
      // Initially: two hunks at index 0 and 1
      const hunkA = makeHunk({ id: 'hunk-A' });
      const hunkB = makeHunk({ id: 'hunk-B' });
      const file1 = makeFile([hunkA, hunkB]);
      state.syncStatuses(file1);

      // Approve hunk B (index 1)
      state.approve('test.txt', 'hunk-B');

      // After new edits, a new hunk appears at index 0, pushing hunk-B to index 2
      const newHunk = makeHunk({ id: 'hunk-NEW' });
      const file2 = makeFile([newHunk, hunkA, hunkB]);
      const statuses = state.syncStatuses(file2);

      // hunk-B should still be approved even though it's now at index 2
      assert.equal(statuses[0], 'pending'); // hunk-NEW
      assert.equal(statuses[1], 'pending'); // hunk-A
      assert.equal(statuses[2], 'approved'); // hunk-B preserved!
    });
  });

  describe('persistence', () => {
    it('persists and restores approved statuses', () => {
      const memento = new MockMemento();
      const state1 = new StateManager(
        git as unknown as GitAdapter,
        memento as unknown as vscode.Memento,
      );

      const hunk = makeHunk({ id: 'persist-me' });
      const file = makeFile([hunk]);
      state1.syncStatuses(file);
      state1.approve('test.txt', 'persist-me');

      // Create a new StateManager reading from the same memento (simulates restart)
      const state2 = new StateManager(
        git as unknown as GitAdapter,
        memento as unknown as vscode.Memento,
      );
      const statuses = state2.getStatusArray(file);
      assert.equal(statuses[0], 'approved');
    });

    it('does not persist pending statuses', () => {
      const memento = new MockMemento();
      const state1 = new StateManager(
        git as unknown as GitAdapter,
        memento as unknown as vscode.Memento,
      );

      const hunk = makeHunk({ id: 'pending-hunk' });
      const file = makeFile([hunk]);
      state1.syncStatuses(file);

      // New StateManager should have no data for this file
      const state2 = new StateManager(
        git as unknown as GitAdapter,
        memento as unknown as vscode.Memento,
      );
      assert.deepEqual(state2.getStatuses('test.txt'), []);
    });
  });

  describe('pruneCommittedFiles', () => {
    it('removes files no longer in diff', () => {
      const hunk = makeHunk({ id: 'prune-test' });
      const file = makeFile([hunk]);
      state.syncStatuses(file);
      state.approve('test.txt', 'prune-test');

      // After commit, file is gone from diff
      state.pruneCommittedFiles([]);
      assert.equal(state.isFileResolved('test.txt'), false);
      assert.deepEqual(state.getStatuses('test.txt'), []);
    });

    it('keeps files still in diff', () => {
      const hunk = makeHunk({ id: 'keep-test' });
      const file = makeFile([hunk]);
      state.syncStatuses(file);
      state.approve('test.txt', 'keep-test');

      state.pruneCommittedFiles([file]);
      assert.equal(state.isFileResolved('test.txt'), true);
    });
  });
});
