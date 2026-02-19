import hljs from 'highlight.js';
import { extname } from 'path';

const extToLang: Record<string, string> = {
  '.ts': 'typescript',
  '.tsx': 'typescript',
  '.js': 'javascript',
  '.jsx': 'javascript',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.py': 'python',
  '.rb': 'ruby',
  '.rs': 'rust',
  '.go': 'go',
  '.java': 'java',
  '.kt': 'kotlin',
  '.kts': 'kotlin',
  '.cs': 'csharp',
  '.cpp': 'cpp',
  '.cc': 'cpp',
  '.cxx': 'cpp',
  '.hpp': 'cpp',
  '.h': 'cpp',
  '.c': 'c',
  '.php': 'php',
  '.swift': 'swift',
  '.scala': 'scala',
  '.sh': 'bash',
  '.bash': 'bash',
  '.zsh': 'bash',
  '.sql': 'sql',
  '.html': 'xml',
  '.htm': 'xml',
  '.xml': 'xml',
  '.svg': 'xml',
  '.css': 'css',
  '.scss': 'scss',
  '.less': 'less',
  '.json': 'json',
  '.yaml': 'yaml',
  '.yml': 'yaml',
  '.md': 'markdown',
  '.lua': 'lua',
  '.r': 'r',
  '.dart': 'dart',
  '.ex': 'elixir',
  '.exs': 'elixir',
  '.erl': 'erlang',
  '.hs': 'haskell',
  '.ml': 'ocaml',
  '.vim': 'vim',
  '.dockerfile': 'dockerfile',
  '.tf': 'hcl',
  '.toml': 'ini',
  '.ini': 'ini',
  '.graphql': 'graphql',
  '.gql': 'graphql',
};

/**
 * Highlight a file's content and return an array of HTML strings (one per line).
 * Each line contains `<span class="hljs-*">` tokens for syntax coloring.
 */
export function highlightFileContent(filePath: string, lines: string[]): string[] {
  const ext = extname(filePath).toLowerCase();
  const lang = extToLang[ext];

  const code = lines.join('\n');
  let highlighted: string;

  try {
    if (lang && hljs.getLanguage(lang)) {
      highlighted = hljs.highlight(code, { language: lang }).value;
    } else {
      const result = hljs.highlightAuto(code);
      highlighted = result.value;
    }
  } catch {
    // Fallback: escape HTML and return plain
    return lines.map(escapeHtml);
  }

  // hljs output is a single HTML string with \n for line breaks.
  // Split by newline, but we must handle spans that cross line boundaries.
  return splitHighlightedLines(highlighted, lines.length);
}

/**
 * Highlight individual lines (for removed lines not in the current file).
 */
export function highlightSingleLine(filePath: string, content: string): string {
  const ext = extname(filePath).toLowerCase();
  const lang = extToLang[ext];

  try {
    if (lang && hljs.getLanguage(lang)) {
      return hljs.highlight(content, { language: lang }).value;
    }
    return hljs.highlightAuto(content).value;
  } catch {
    return escapeHtml(content);
  }
}

/**
 * Split highlighted HTML into lines, properly closing and reopening
 * spans that cross line boundaries.
 */
function splitHighlightedLines(html: string, expectedCount: number): string[] {
  const rawLines = html.split('\n');
  const result: string[] = [];
  const openSpans: string[] = []; // stack of open <span ...> tags

  for (const rawLine of rawLines) {
    // Prepend any spans that were open from the previous line
    let line = openSpans.join('') + rawLine;

    // Track span opens/closes in this raw line to update the stack
    const openPattern = /<span[^>]*>/g;
    const closePattern = /<\/span>/g;

    let match;
    // Process opens
    while ((match = openPattern.exec(rawLine)) !== null) {
      openSpans.push(match[0]);
    }
    // Process closes
    while (closePattern.exec(rawLine) !== null) {
      openSpans.pop();
    }

    // Close any still-open spans at the end of this line
    for (let i = 0; i < openSpans.length; i++) {
      line += '</span>';
    }

    result.push(line);
  }

  // Pad or trim to match expected line count
  while (result.length < expectedCount) {
    result.push('');
  }

  return result.slice(0, expectedCount);
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
