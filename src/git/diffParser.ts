import { DiffFile, DiffHunk, DiffLine } from '../types';

/**
 * Parse unified diff output from `git diff` into structured DiffFile objects.
 * Custom parser to preserve rawLines per hunk (needed for git apply -R).
 */
export function parseDiff(diffText: string): DiffFile[] {
  const files: DiffFile[] = [];
  const lines = diffText.split('\n');
  let i = 0;

  while (i < lines.length) {
    // Look for "diff --git a/... b/..."
    if (!lines[i].startsWith('diff --git ')) {
      i++;
      continue;
    }

    const file: DiffFile = {
      oldPath: '',
      newPath: '',
      hunks: [],
      isBinary: false,
      diffHeader: [],
    };

    // Skip diff --git line
    i++;

    // Skip optional extended headers (old mode, new mode, index, similarity, rename, etc.)
    while (
      i < lines.length &&
      !lines[i].startsWith('diff --git ') &&
      !lines[i].startsWith('---') &&
      !lines[i].startsWith('@@') &&
      !lines[i].startsWith('Binary')
    ) {
      i++;
    }

    // Check for binary file
    if (i < lines.length && lines[i].startsWith('Binary')) {
      file.isBinary = true;
      file.oldPath = extractPath(lines[i - 1] || '', 'a/');
      file.newPath = extractPath(lines[i - 1] || '', 'b/');
      files.push(file);
      i++;
      continue;
    }

    // Parse --- and +++ lines
    if (i < lines.length && lines[i].startsWith('---')) {
      const oldLine = lines[i];
      file.diffHeader.push(oldLine);
      file.oldPath = oldLine.startsWith('--- a/') ? oldLine.slice(6) : oldLine.slice(4);
      i++;
    }
    if (i < lines.length && lines[i].startsWith('+++')) {
      const newLine = lines[i];
      file.diffHeader.push(newLine);
      file.newPath = newLine.startsWith('+++ b/') ? newLine.slice(6) : newLine.slice(4);
      i++;
    }

    // Parse hunks
    while (i < lines.length && !lines[i].startsWith('diff --git ')) {
      if (lines[i].startsWith('@@')) {
        const hunk = parseHunk(lines, i);
        file.hunks.push(hunk.hunk);
        i = hunk.nextIndex;
      } else {
        i++;
      }
    }

    files.push(file);
  }

  return files;
}

function parseHunk(lines: string[], startIndex: number): { hunk: DiffHunk; nextIndex: number } {
  const headerLine = lines[startIndex];
  const match = headerLine.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)/);

  if (!match) {
    // Skip malformed hunk header
    return {
      hunk: {
        oldStart: 0,
        oldCount: 0,
        newStart: 0,
        newCount: 0,
        header: headerLine,
        lines: [],
        rawLines: [headerLine],
      },
      nextIndex: startIndex + 1,
    };
  }

  const hunk: DiffHunk = {
    oldStart: parseInt(match[1], 10),
    oldCount: match[2] !== undefined ? parseInt(match[2], 10) : 1,
    newStart: parseInt(match[3], 10),
    newCount: match[4] !== undefined ? parseInt(match[4], 10) : 1,
    header: headerLine,
    lines: [],
    rawLines: [headerLine],
  };

  let i = startIndex + 1;

  while (i < lines.length) {
    const line = lines[i];

    if (line.startsWith('@@') || line.startsWith('diff --git ')) {
      break;
    }

    // Handle "\ No newline at end of file"
    if (line.startsWith('\\ ')) {
      hunk.rawLines.push(line);
      i++;
      continue;
    }

    if (line.startsWith('+')) {
      hunk.lines.push({ type: 'add', content: line.slice(1) });
      hunk.rawLines.push(line);
    } else if (line.startsWith('-')) {
      hunk.lines.push({ type: 'remove', content: line.slice(1) });
      hunk.rawLines.push(line);
    } else if (line.startsWith(' ') || line === '') {
      // Context line (space prefix) or empty line at end of diff
      if (line === '' && i === lines.length - 1) {
        // Trailing empty line of the diff output, skip
        break;
      }
      hunk.lines.push({ type: 'context', content: line.slice(1) });
      hunk.rawLines.push(line);
    } else {
      // Unknown line format — likely next section
      break;
    }

    i++;
  }

  return { hunk, nextIndex: i };
}

/**
 * Split each hunk into granular sub-hunks — one per contiguous group of
 * changed lines. Context lines between changes become boundaries.
 */
export function splitHunks(hunks: DiffHunk[]): DiffHunk[] {
  const result: DiffHunk[] = [];

  for (const hunk of hunks) {
    let oldLine = hunk.oldStart;
    let newLine = hunk.newStart;
    let i = 0;

    while (i < hunk.lines.length) {
      // Skip context lines
      if (hunk.lines[i].type === 'context') {
        oldLine++;
        newLine++;
        i++;
        continue;
      }

      // Collect a contiguous group of changed lines (add/remove with no context gap)
      const groupOldStart = oldLine;
      const groupNewStart = newLine;
      let groupOldCount = 0;
      let groupNewCount = 0;
      const groupLines: DiffLine[] = [];
      const groupRawLines: string[] = [];

      while (i < hunk.lines.length && hunk.lines[i].type !== 'context') {
        const line = hunk.lines[i];
        groupLines.push(line);

        if (line.type === 'remove') {
          groupRawLines.push('-' + line.content);
          groupOldCount++;
          oldLine++;
        } else if (line.type === 'add') {
          groupRawLines.push('+' + line.content);
          groupNewCount++;
          newLine++;
        }
        i++;
      }

      // For the @@ header used by git apply --unidiff-zero:
      // When count=0, start refers to the line BEFORE the change point
      const patchOldStart = groupOldCount === 0 ? groupOldStart - 1 : groupOldStart;
      const patchNewStart = groupNewCount === 0 ? groupNewStart - 1 : groupNewStart;
      const header = `@@ -${patchOldStart},${groupOldCount} +${patchNewStart},${groupNewCount} @@`;

      result.push({
        oldStart: groupOldStart,
        oldCount: groupOldCount,
        // newStart/newCount are used for rendering position in the file
        newStart: groupNewStart,
        newCount: groupNewCount,
        header,
        lines: groupLines,
        rawLines: [header, ...groupRawLines],
      });
    }
  }

  return result;
}

/**
 * FNV-1a hash producing an 8-char hex string.
 */
function fnv1a(str: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

/**
 * Compute a content-based ID for a hunk by hashing only the changed lines
 * (add/remove content, not context or line numbers).
 */
export function computeHunkId(filePath: string, hunk: DiffHunk): string {
  const changedContent = hunk.lines
    .filter((l) => l.type === 'add' || l.type === 'remove')
    .map((l) => `${l.type}:${l.content}`)
    .join('\n');
  return fnv1a(`${filePath}\0${changedContent}`);
}

/**
 * Compute IDs for all hunks in a file, appending `-2`, `-3` etc. for duplicates.
 */
export function computeHunkIds(filePath: string, hunks: DiffHunk[]): string[] {
  const ids: string[] = [];
  const seen = new Map<string, number>();

  for (const hunk of hunks) {
    const baseId = computeHunkId(filePath, hunk);
    const count = (seen.get(baseId) || 0) + 1;
    seen.set(baseId, count);
    ids.push(count === 1 ? baseId : `${baseId}-${count}`);
  }

  // Retroactively fix first occurrence if there were duplicates
  for (let i = 0; i < ids.length; i++) {
    const baseId = ids[i];
    if (seen.get(baseId)! > 1) {
      ids[i] = `${baseId}-1`;
    }
  }

  return ids;
}

function extractPath(line: string, prefix: string): string {
  const idx = line.indexOf(prefix);
  return idx >= 0 ? line.slice(idx + prefix.length) : '';
}
