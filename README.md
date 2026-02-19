# Diff Reviewer

A VS Code extension for interactive diff review. It shows your uncommitted changes (staged + unstaged vs HEAD) in a sidebar file tree and opens per-file webview panels where you can approve or reject individual hunks. Rejecting a hunk reverse-applies it on disk; approving marks it as reviewed. All actions are undoable.

## Features

- **Sidebar file tree** — Lists all files with uncommitted changes
- **Per-hunk review** — Approve or reject individual change groups within a file
- **Inline diff view** — Full file content with hunks rendered at their line positions (not side-by-side)
- **Undo support** — Every approve/reject action can be undone
- **Stable hunk tracking** — Hunk identity is content-based, so approvals survive when hunks shift after edits
- **Syntax highlighting** — Server-side highlighting via highlight.js
- **Theme-aware** — Integrates with VS Code light/dark themes

## Prerequisites

- [Node.js](https://nodejs.org/) v22 (see `.nvmrc`)
- [Git](https://git-scm.com/)
- [Visual Studio Code](https://code.visualstudio.com/) v1.85 or later

## Getting Started

### 1. Clone the repository

```sh
gh repo clone fredsvanelli/diff-reviewer
# or
git clone https://github.com/fredsvanelli/diff-reviewer.git
```

### 2. Install dependencies

```sh
npm install
```

### 3. Build the extension

```sh
npm run build
```

This bundles both the extension (Node/CommonJS) and the webview (browser/IIFE) into the `out/` directory.

### 4. Run in VS Code

1. Open the `diff-reviewer` folder in VS Code.
2. Press **F5** (or go to **Run → Start Debugging**).
3. A new VS Code window (the Extension Development Host) will open with the extension loaded.
4. In the Extension Development Host window, open any Git repository that has uncommitted changes.
5. Click the **Diff Reviewer** icon in the Activity Bar (left sidebar) to see the list of modified files.
6. Click a file to open the inline diff view and start approving or rejecting hunks.

### Development Workflow

For a faster feedback loop, use watch mode so the extension rebuilds automatically on changes:

```sh
npm run watch
```

Then press **F5** in VS Code. After making code changes, reload the Extension Development Host window (**Ctrl+Shift+P** / **Cmd+Shift+P** → "Developer: Reload Window") to pick up the new build.

## Available Commands

| Command | Description |
|---|---|
| `Diff Reviewer: Refresh Diff` | Re-read the diff from Git and update the file tree |
| `Diff Reviewer: Open Diff View` | Open the inline diff panel for a file |
| `Diff Reviewer: Undo Last Action` | Undo the last approve/reject action |
| `Diff Reviewer: Approve File` | Mark all hunks in a file as approved |
| `Diff Reviewer: Reject File` | Reject all hunks in a file (reverse-applies them on disk) |

## Scripts

| Script | Description |
|---|---|
| `npm run build` | Bundle extension + webview with esbuild |
| `npm run watch` | Watch mode for development |
| `npm test` | Run tests (Node.js built-in test runner with tsx) |
| `npm run lint` | ESLint + TypeScript type check |
| `npm run lint:fix` | Auto-fix ESLint issues |
| `npm run ts:check` | Type check only |

Run a single test file:

```sh
node --import tsx --test test/diffParser.test.ts
```

## Project Structure

```
diff-reviewer/
├── src/
│   ├── extension.ts              # Activation, commands, message routing
│   ├── highlighter.ts            # Syntax highlighting via highlight.js
│   ├── git/
│   │   ├── gitAdapter.ts         # Git CLI wrapper (diff, apply, file content)
│   │   └── diffParser.ts         # Unified diff parser, hunk splitting, hunk IDs
│   ├── state/
│   │   └── stateManager.ts       # Hunk status tracking, undo stack, persistence
│   ├── sidebar/
│   │   └── fileTreeProvider.ts   # TreeDataProvider for the sidebar file list
│   └── webview/
│       └── diffPanelProvider.ts  # Webview panel creation and message handling
├── media/
│   ├── webview.js                # Webview UI (inline diff rendering, interactions)
│   └── webview.css               # Webview styles (VS Code theme integration)
├── test/                         # Tests (node:test + tsx)
│   └── fixtures/                 # Test fixtures
├── out/                          # Build output (gitignored)
├── esbuild.mjs                   # Build configuration
├── tsconfig.json
└── package.json
```

## License

See [LICENSE](LICENSE) for details.
