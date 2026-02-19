# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

A VS Code extension for interactive diff review. It shows uncommitted changes (staged + unstaged vs HEAD) in a sidebar file tree and opens per-file webview panels where users can approve or reject individual hunks. Rejecting a hunk reverse-applies it on disk via `git apply -R`; approving marks it as reviewed. All actions are undoable.

## Commands

- `npm run build` — Bundle extension + webview with esbuild (output in `out/`)
- `npm run watch` — Watch mode for development
- `npm test` — Run tests (uses Node.js built-in test runner with tsx)
- `npm run lint` — ESLint + TypeScript type check (`tsc --noEmit`)
- `npm run lint:fix` — Auto-fix ESLint issues
- `npm run ts:check` — Type check only
- Run a single test file: `node --import tsx --test test/diffParser.test.ts`

Pre-commit hook runs `npm run lint:fix && npm run ts:check`.

## Architecture

**Two build targets** (see `esbuild.mjs`):
1. **Extension** (`src/extension.ts` → `out/extension.js`): Node/CommonJS, externals `vscode`
2. **Webview** (`media/webview.js` → `out/webview.js`): Browser/IIFE

**Extension-side modules** (`src/`):
- `extension.ts` — Activation, command registration, message routing between webview and state
- `git/gitAdapter.ts` — Shells out to `git` CLI for diffs, file content, and `git apply` (forward/reverse)
- `git/diffParser.ts` — Parses unified diff text into `DiffFile`/`DiffHunk` structures, then `splitHunks()` breaks each hunk into granular sub-hunks (one per contiguous change group) for per-change-group review. Computes content-based hunk IDs (FNV-1a hash) for stable tracking across re-parses
- `state/stateManager.ts` — Tracks hunk statuses (`pending`/`approved`/`rejected`) by content-based hunk ID (not index), manages undo stack, persists approved statuses to `vscode.Memento`
- `sidebar/fileTreeProvider.ts` — VS Code TreeDataProvider for the sidebar file list
- `webview/diffPanelProvider.ts` — Creates/manages webview panels, handles message passing
- `highlighter.ts` — Server-side syntax highlighting via highlight.js, splits highlighted HTML across line boundaries

**Webview-side** (`media/`):
- `webview.js` — Renders full file content with hunks inline (not a side-by-side diff), handles approve/reject/undo interactions via `postMessage` protocol
- `webview.css` — Styling with VS Code CSS variable integration, light/dark theme support

**Key design decisions:**
- Hunk identity is content-based (FNV-1a hash of changed lines + file path), not index-based. This means approvals survive when hunks shift position after edits
- Rejecting a hunk modifies the working tree immediately via `git apply -R --unidiff-zero`, then re-parses the diff to update line numbers
- The webview displays the full file with hunks rendered inline at their line positions, not just isolated diffs

## Testing

Tests use `node:test` and `node:assert/strict` (not Jest/Mocha). Test files are in `test/` with `.test.ts` extension, run via tsx loader. Fixtures are in `test/fixtures/`.

## Code Style

- Prettier: single quotes, trailing commas, 100 char width, 2-space indent
- ESLint with typescript-eslint, unused vars prefixed with `_`
- Node 22 (see `.nvmrc`)
