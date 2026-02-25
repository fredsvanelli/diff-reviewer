import { execFile } from 'child_process';
import { readFile } from 'fs/promises';
import { join } from 'path';
import { DiffFile } from '../types';
import { parseDiff, splitHunks, computeHunkIds } from './diffParser';

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
   * Get the parsed diff of all uncommitted changes (staged + unstaged vs HEAD).
   */
  async getDiff(): Promise<DiffFile[]> {
    const raw = await this.exec(['diff', 'HEAD']);
    if (!raw.trim()) {
      return [];
    }
    return parseDiff(raw).map((f) => {
      const hunks = splitHunks(f.hunks);
      const filePath = f.newPath || f.oldPath;
      const ids = computeHunkIds(filePath, hunks);
      hunks.forEach((h, i) => {
        h.id = ids[i];
      });
      return { ...f, hunks };
    });
  }

  /**
   * Get raw diff for a single file.
   */
  async getFileDiff(filePath: string): Promise<DiffFile[]> {
    const raw = await this.exec(['diff', 'HEAD', '--', filePath]);
    if (!raw.trim()) {
      return [];
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
