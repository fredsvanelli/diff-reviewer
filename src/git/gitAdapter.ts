import { execFile } from 'child_process';
import { readFile, unlink, writeFile } from 'fs/promises';
import { join } from 'path';
import { DiffFile, DiffHunk } from '../types';
import { parseDiff, splitHunks, computeHunkIds } from './diffParser';
import { isReviewable } from './fileFilter';

export class GitAdapter {
  private repoRoot: string | undefined;

  constructor(private workspaceRoot: string) {}

  /**
   * Discover the git repository root. Must be called before other methods
   * when the workspace folder may differ from the git root (e.g. monorepos).
   */
  async init(): Promise<void> {
    const toplevel = await this.exec(['rev-parse', '--show-toplevel']);
    this.repoRoot = toplevel.trim();
  }

  /** Return the resolved git repo root (falls back to workspaceRoot). */
  getRepoRoot(): string {
    return this.repoRoot ?? this.workspaceRoot;
  }

  /**
   * Get the parsed diff of all uncommitted changes (staged + unstaged vs HEAD),
   * including untracked files as synthetic add-only diffs.
   */
  async getDiff(): Promise<DiffFile[]> {
    const [raw, untrackedFiles] = await Promise.all([
      this.exec(['diff', 'HEAD']),
      this.exec(['ls-files', '--others', '--exclude-standard']),
    ]);

    const tracked = raw.trim()
      ? parseDiff(raw)
          .filter((f) => !f.isBinary && isReviewable(f.newPath || f.oldPath))
          .map((f) => {
            const hunks = splitHunks(f.hunks);
            const filePath = f.newPath || f.oldPath;
            const ids = computeHunkIds(filePath, hunks);
            hunks.forEach((h, i) => {
              h.id = ids[i];
            });
            return { ...f, hunks };
          })
      : [];

    const untracked = await Promise.all(
      untrackedFiles
        .split('\n')
        .map((p) => p.trim())
        .filter((p) => p.length > 0 && isReviewable(p))
        .map((p) => this.buildUntrackedDiffFile(p)),
    );

    return [...tracked, ...untracked.filter((f): f is DiffFile => f !== null)];
  }

  /**
   * Synthesise a DiffFile for an untracked file by reading its content and
   * treating every line as an addition — mirroring what `git diff --no-index
   * /dev/null <file>` would produce.
   */
  private async buildUntrackedDiffFile(filePath: string): Promise<DiffFile | null> {
    try {
      const absPath = join(this.getRepoRoot(), filePath);
      const raw = await readFile(absPath, 'utf-8');
      const lines = raw.split('\n');

      // Drop the trailing empty string that results from a final newline
      if (lines.length > 0 && lines[lines.length - 1] === '') {
        lines.pop();
      }

      const header = `@@ -0,0 +1,${lines.length} @@`;
      const rawLines = [header, ...lines.map((l) => `+${l}`)];

      const hunk: import('../types').DiffHunk = {
        // oldStart must be 1 (not 0) so splitHunks computes patchOldStart = 1-1 = 0,
        // producing the correct "@@ -0,0 +1,N @@" header for a new file.
        oldStart: 1,
        oldCount: 0,
        newStart: 1,
        newCount: lines.length,
        header,
        lines: lines.map((l) => ({ type: 'add' as const, content: l })),
        rawLines,
      };

      const hunks = splitHunks([hunk]);
      const ids = computeHunkIds(filePath, hunks);
      hunks.forEach((h, i) => {
        h.id = ids[i];
      });

      return {
        oldPath: '/dev/null',
        newPath: filePath,
        hunks,
        isBinary: false,
        isUntracked: true,
        diffHeader: ['--- /dev/null', `+++ b/${filePath}`],
      };
    } catch {
      // File may have been deleted between ls-files and read — skip silently
      return null;
    }
  }

  /**
   * Get raw diff for a single file.
   * Falls back to buildUntrackedDiffFile when the file is untracked (not in HEAD).
   */
  async getFileDiff(filePath: string): Promise<DiffFile[]> {
    const raw = await this.exec(['diff', 'HEAD', '--', filePath]);
    if (!raw.trim()) {
      // Not a tracked change — re-build as untracked if the file still exists
      const untracked = await this.buildUntrackedDiffFile(filePath);
      return untracked ? [untracked] : [];
    }
    return parseDiff(raw).map((f) => {
      const hunks = splitHunks(f.hunks);
      const fp = f.newPath || f.oldPath;
      const ids = computeHunkIds(fp, hunks);
      hunks.forEach((h, i) => {
        h.id = ids[i];
      });
      return { ...f, hunks };
    });
  }

  /**
   * Reject a hunk from an untracked file by directly removing those lines from disk.
   * Deletes the file if it becomes empty.
   */
  async rejectUntrackedHunk(filePath: string, hunk: DiffHunk): Promise<void> {
    const absPath = join(this.getRepoRoot(), filePath);
    const raw = await readFile(absPath, 'utf-8');

    const hasTrailingNewline = raw.endsWith('\n');
    const fileLines = raw.split('\n');
    if (hasTrailingNewline && fileLines[fileLines.length - 1] === '') {
      fileLines.pop();
    }

    // hunk.newStart is 1-indexed; remove exactly newCount lines from that position
    fileLines.splice(hunk.newStart - 1, hunk.newCount);

    if (fileLines.length === 0) {
      await unlink(absPath);
    } else {
      await writeFile(absPath, fileLines.join('\n') + '\n', 'utf-8');
    }
  }

  /**
   * Re-insert lines into an untracked file at the given 0-indexed position.
   * Used to undo a previous rejectUntrackedHunk call.
   * Re-creates the file if it was deleted.
   */
  async reInsertUntrackedLines(
    filePath: string,
    lineIndex: number,
    lines: string[],
  ): Promise<void> {
    const absPath = join(this.getRepoRoot(), filePath);

    let fileLines: string[] = [];
    try {
      const raw = await readFile(absPath, 'utf-8');
      const hasTrailingNewline = raw.endsWith('\n');
      fileLines = raw.split('\n');
      if (hasTrailingNewline && fileLines[fileLines.length - 1] === '') {
        fileLines.pop();
      }
    } catch {
      // File was fully deleted — start from scratch
    }

    fileLines.splice(lineIndex, 0, ...lines);
    await writeFile(absPath, fileLines.join('\n') + '\n', 'utf-8');
  }

  /**
   * Reverse-apply a patch (reject a hunk). Patch is provided as a string
   * representing a valid unified diff for a single hunk.
   */
  async applyReverse(patch: string): Promise<void> {
    await this.execStdin(['apply', '-R', '--unidiff-zero', '-'], patch);
  }

  /**
   * Read the current working-tree content of a file, split into lines.
   */
  async getFileContent(filePath: string): Promise<string[]> {
    const absPath = join(this.getRepoRoot(), filePath);
    const content = await readFile(absPath, 'utf-8');
    return content.split('\n');
  }

  /**
   * Forward-apply a patch (undo a rejection). Patch is the same format
   * that was passed to applyReverse.
   */
  async applyForward(patch: string): Promise<void> {
    await this.execStdin(['apply', '--unidiff-zero', '-'], patch);
  }

  private exec(args: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
      execFile(
        'git',
        args,
        { cwd: this.getRepoRoot(), maxBuffer: 10 * 1024 * 1024 },
        (err, stdout, stderr) => {
          if (err) {
            reject(new Error(`git ${args[0]} failed: ${stderr || err.message}`));
            return;
          }
          resolve(stdout);
        },
      );
    });
  }

  private execStdin(args: string[], stdin: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const proc = execFile('git', args, { cwd: this.getRepoRoot() }, (err, stdout, stderr) => {
        if (err) {
          reject(new Error(`git ${args[0]} failed: ${stderr || err.message}`));
          return;
        }
        resolve(stdout);
      });
      proc.stdin!.write(stdin);
      proc.stdin!.end();
    });
  }
}
