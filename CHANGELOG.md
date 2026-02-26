# Changelog

All notable changes to **Diff Reviewer** are documented in this file.

## [1.1.0] — 2026-02-25

### Added
- Untracked files (never staged) now appear in the pending list and can be reviewed hunk-by-hunk
- Binary and non-text files (images, PDFs, archives, videos, fonts, compiled binaries, etc.) are automatically excluded from the diff tree
- Undo support extended to cover reject actions on untracked files

## [1.0.1-rc] — 2026-02-25

### Fixed
- Floating action bar now hides correctly when all hunks in a file have been reviewed

## [1.0.0-rc] — 2026-02-25

### Added
- Floating action bar with hunk navigation, approve-all / reject-all, and settings controls
- Scroll map markers indicating positions of pending and approved hunks in the file
- Modified file count badge on the sidebar tree view

### Fixed
- Auto-scroll toggle is now correctly respected when a file is first rendered

## [0.0.2-beta] — 2026-02-25

### Added
- Git repository root discovery for monorepo support
- File count badge on the sidebar tree view
- `.vscodeignore` to exclude dev files from the packaged extension
- MIT `LICENSE` file
- `vscode:prepublish` script to auto-build before packaging

### Fixed
- File tree badge rendering improvements
- More reliable git root resolution in nested workspaces

## [0.0.1-beta] — 2026-02-19

### Added
- Initial release with full interactive diff review workflow
- Sidebar file tree listing all files with uncommitted changes
- Per-file webview panel rendering the full file with hunks inline
- Approve and reject actions on individual hunks (granular sub-hunk splitting)
- Rejecting a hunk reverse-applies it on disk via `git apply -R`
- Content-based hunk IDs (FNV-1a) for stable tracking across re-parses
- Undo stack for all approve/reject actions
- Approve-file and reject-file shortcuts from the sidebar context menu
- Server-side syntax highlighting via highlight.js
- Light/dark theme support via VS Code CSS variables
- Approved hunk status persisted across sessions via `vscode.Memento`
- CI workflow with GitHub Actions
