export interface DiffLine {
  type: 'add' | 'remove' | 'context';
  content: string;
}

export interface DiffHunk {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  header: string;
  lines: DiffLine[];
  /** Raw diff lines including the @@ header, for reconstructing patches */
  rawLines: string[];
  /** Content-based ID for stable tracking across re-parses */
  id?: string;
}

export interface DiffFile {
  oldPath: string;
  newPath: string;
  hunks: DiffHunk[];
  isBinary: boolean;
  /** Raw diff header lines (--- and +++ lines) */
  diffHeader: string[];
}

export type HunkStatus = 'pending' | 'approved' | 'rejected';

export interface HunkState {
  filePath: string;
  hunkIndex: number;
  status: HunkStatus;
}

export interface UndoEntry {
  type: 'approve' | 'reject';
  filePath: string;
  hunkId: string;
  /** For reject undo: the forward patch to re-apply */
  forwardPatch?: string;
}

// Extension → Webview messages
export type ExtToWebviewMessage =
  | {
      command: 'showFile';
      file: DiffFile;
      hunkStatuses: HunkStatus[];
      fileContent: string[];
      highlightedLines: string[];
    }
  | { command: 'updateHunk'; hunkIndex: number; status: HunkStatus }
  | { command: 'clear' };

// Webview → Extension messages
export type WebviewToExtMessage =
  | { command: 'ready' }
  | { command: 'approve'; filePath: string; hunkIndex: number }
  | { command: 'reject'; filePath: string; hunkIndex: number }
  | { command: 'approveAll'; filePath: string }
  | { command: 'rejectAll'; filePath: string }
  | { command: 'undo'; filePath: string; hunkIndex: number }
  | { command: 'openInEditor'; filePath: string };
