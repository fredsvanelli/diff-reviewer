// @ts-check

/** @type {ReturnType<typeof acquireVsCodeApi>} */
const vscode = acquireVsCodeApi();

/** @type {string} */
let currentFilePath = '';

/** @type {string[]} */
let currentHighlightedLines = [];

const container = document.getElementById('container');

// Signal to the extension that we're ready to receive data
vscode.postMessage({ command: 'ready' });

// Restore persisted state on reopen
const savedState = vscode.getState();
if (savedState && savedState.file) {
  renderFile(savedState.file, savedState.hunkStatuses || [], savedState.fileContent || [], savedState.highlightedLines || []);
}

// Listen for messages from the extension
window.addEventListener('message', (event) => {
  const msg = event.data;

  switch (msg.command) {
    case 'showFile':
      currentFilePath = msg.file.newPath || msg.file.oldPath;
      currentHighlightedLines = msg.highlightedLines || [];
      renderFile(msg.file, msg.hunkStatuses, msg.fileContent || [], currentHighlightedLines);
      vscode.setState({ file: msg.file, hunkStatuses: msg.hunkStatuses, fileContent: msg.fileContent || [], highlightedLines: currentHighlightedLines });
      break;

    case 'updateHunk':
      updateHunkStatus(msg.hunkIndex, msg.status);
      break;

    case 'clear':
      if (container) {
        container.innerHTML = '<div class="empty-notice">No diff data.</div>';
      }
      vscode.setState(undefined);
      break;
  }
});

/**
 * Render the full file content with hunks inline.
 * @param {any} file - DiffFile
 * @param {string[]} hunkStatuses - Array of HunkStatus
 * @param {string[]} fileContent - Lines of the current file on disk
 * @param {string[]} highlightedLines - Pre-highlighted HTML per line
 */
function renderFile(file, hunkStatuses, fileContent, highlightedLines) {
  if (!container) return;
  container.innerHTML = '';

  const filePath = file.newPath || file.oldPath;

  // Top bar with Approve All / Reject All
  const topBar = document.createElement('div');
  topBar.className = 'top-bar';

  const titleGroup = document.createElement('div');
  titleGroup.className = 'top-bar-title-group';

  const title = document.createElement('span');
  title.className = 'top-bar-title';
  title.textContent = filePath;
  titleGroup.appendChild(title);

  const editLink = document.createElement('a');
  editLink.className = 'top-bar-edit-link';
  editLink.textContent = 'Edit file';
  editLink.href = '#';
  editLink.addEventListener('click', (e) => {
    e.preventDefault();
    vscode.postMessage({ command: 'openInEditor', filePath });
  });
  titleGroup.appendChild(editLink);

  topBar.appendChild(titleGroup);

  const hasPending = hunkStatuses.some((/** @type {string} */ s) => s === 'pending');
  if (hasPending) {
    const actions = document.createElement('div');
    actions.className = 'top-bar-actions';

    const approveAllBtn = document.createElement('button');
    approveAllBtn.className = 'btn-approve';
    approveAllBtn.textContent = 'Approve All';
    approveAllBtn.addEventListener('click', () => {
      vscode.postMessage({ command: 'approveAll', filePath });
    });

    const rejectAllBtn = document.createElement('button');
    rejectAllBtn.className = 'btn-reject';
    rejectAllBtn.textContent = 'Reject All';
    makeRejectWithConfirm(rejectAllBtn, 'Reject All', () => {
      vscode.postMessage({ command: 'rejectAll', filePath });
    });

    actions.appendChild(approveAllBtn);
    actions.appendChild(rejectAllBtn);
    topBar.appendChild(actions);
  }
  container.appendChild(topBar);

  if (file.isBinary) {
    const notice = document.createElement('div');
    notice.className = 'binary-notice';
    notice.textContent = 'Binary file — no hunk-level review available.';
    container.appendChild(notice);
    return;
  }

  if (file.hunks.length === 0) {
    const notice = document.createElement('div');
    notice.className = 'empty-notice';
    notice.textContent = 'No changes in this file.';
    container.appendChild(notice);
    return;
  }

  const contentArea = document.createElement('div');
  contentArea.className = 'file-content';

  /** @type {{ hunk: any, index: number, status: string }[]} */
  const hunkEntries = file.hunks.map((/** @type {any} */ h, /** @type {number} */ i) => ({
    hunk: h,
    index: i,
    status: hunkStatuses[i] || 'pending',
  }));

  hunkEntries.sort((a, b) => a.hunk.newStart - b.hunk.newStart);

  let fileLineIndex = 0;
  let hunkPtr = 0;

  while (fileLineIndex < fileContent.length || hunkPtr < hunkEntries.length) {
    const currentLine = fileLineIndex + 1;

    if (hunkPtr < hunkEntries.length && currentLine === hunkEntries[hunkPtr].hunk.newStart) {
      const entry = hunkEntries[hunkPtr];
      const hunkEl = createInlineHunk(entry.hunk, entry.index, entry.status, filePath, highlightedLines);
      contentArea.appendChild(hunkEl);
      fileLineIndex += entry.hunk.newCount;
      hunkPtr++;
      continue;
    }

    if (fileLineIndex < fileContent.length) {
      const nextHunkStart = hunkPtr < hunkEntries.length ? hunkEntries[hunkPtr].hunk.newStart : Infinity;
      if (currentLine < nextHunkStart) {
        const hlLine = highlightedLines[fileLineIndex] || escapeHtml(fileContent[fileLineIndex]);
        const lineEl = createFileLine(currentLine, hlLine);
        contentArea.appendChild(lineEl);
        fileLineIndex++;
      } else {
        fileLineIndex++;
      }
    } else {
      if (hunkPtr < hunkEntries.length) {
        const entry = hunkEntries[hunkPtr];
        const hunkEl = createInlineHunk(entry.hunk, entry.index, entry.status, filePath, highlightedLines);
        contentArea.appendChild(hunkEl);
        hunkPtr++;
      } else {
        break;
      }
    }
  }

  container.appendChild(contentArea);

  // Build scroll map after layout is ready
  requestAnimationFrame(() => buildScrollMap());
}

/**
 * Create a plain file line (unchanged) with syntax highlighting.
 * @param {number} lineNum - 1-based line number
 * @param {string} highlightedHtml - Pre-highlighted HTML
 * @returns {HTMLElement}
 */
function createFileLine(lineNum, highlightedHtml) {
  const el = document.createElement('div');
  el.className = 'file-line unchanged';

  const numEl = document.createElement('span');
  numEl.className = 'line-number';
  numEl.textContent = String(lineNum);

  const contentEl = document.createElement('span');
  contentEl.className = 'line-content';
  contentEl.innerHTML = highlightedHtml;

  el.appendChild(numEl);
  el.appendChild(contentEl);
  return el;
}

/**
 * Create an inline hunk element with syntax-highlighted diff lines.
 * @param {any} hunk
 * @param {number} index
 * @param {string} status
 * @param {string} filePath
 * @param {string[]} highlightedLines - Full file highlighted lines
 * @returns {HTMLElement}
 */
function createInlineHunk(hunk, index, status, filePath, highlightedLines) {
  const el = document.createElement('div');
  el.className = `inline-hunk ${status}`;
  el.dataset.hunkIndex = String(index);

  let lastChangeIdx = -1;
  for (let i = hunk.lines.length - 1; i >= 0; i--) {
    if (hunk.lines[i].type === 'add' || hunk.lines[i].type === 'remove') {
      lastChangeIdx = i;
      break;
    }
  }

  let oldLine = hunk.oldStart;
  let newLine = hunk.newStart;

  for (let i = 0; i < hunk.lines.length; i++) {
    const line = hunk.lines[i];
    const lineEl = document.createElement('div');
    lineEl.className = `diff-line ${line.type}`;

    const numEl = document.createElement('span');
    numEl.className = 'line-number';

    const contentEl = document.createElement('span');
    contentEl.className = 'line-content';

    if (line.type === 'remove') {
      numEl.textContent = '';
      // Removed lines aren't in the new file — use escaped plain text with prefix
      contentEl.innerHTML = '<span class="diff-prefix">-</span>' + escapeHtml(line.content);
      oldLine++;
    } else if (line.type === 'add') {
      numEl.textContent = String(newLine);
      // Added lines are in the new file — use highlighted version
      const hlLine = highlightedLines[newLine - 1] || escapeHtml(line.content);
      contentEl.innerHTML = '<span class="diff-prefix">+</span>' + hlLine;
      newLine++;
    } else {
      numEl.textContent = String(newLine);
      const hlLine = highlightedLines[newLine - 1] || escapeHtml(line.content);
      contentEl.innerHTML = '<span class="diff-prefix"> </span>' + hlLine;
      oldLine++;
      newLine++;
    }

    lineEl.appendChild(numEl);
    lineEl.appendChild(contentEl);
    el.appendChild(lineEl);

    if (i === lastChangeIdx) {
      if (status === 'pending') {
        el.appendChild(createHunkActions(filePath, index));
      } else if (status === 'approved') {
        el.appendChild(createUndoBadge(filePath, index));
      } else {
        const badge = document.createElement('span');
        badge.className = `hunk-status-badge ${status}`;
        badge.textContent = status;
        el.appendChild(badge);
      }
    }
  }

  if (lastChangeIdx === -1) {
    if (status === 'pending') {
      el.appendChild(createHunkActions(filePath, index));
    }
  }

  return el;
}

/**
 * Create an "APPROVED" badge that turns into "UNDO" on hover.
 * @param {string} filePath
 * @param {number} index
 * @returns {HTMLElement}
 */
function createUndoBadge(filePath, index) {
  const badge = document.createElement('span');
  badge.className = 'hunk-status-badge approved undoable';
  badge.textContent = 'approved';
  badge.addEventListener('mouseenter', () => {
    badge.textContent = 'undo';
    badge.classList.add('undo-hover');
  });
  badge.addEventListener('mouseleave', () => {
    badge.textContent = 'approved';
    badge.classList.remove('undo-hover');
  });
  badge.addEventListener('click', () => {
    vscode.postMessage({ command: 'undo', filePath, hunkIndex: index });
  });
  return badge;
}

/**
 * Wrap a button with two-step confirm behavior.
 * First click changes label to "Confirm" for 3 seconds.
 * Second click (while showing "Confirm") executes the action.
 * @param {HTMLButtonElement} btn
 * @param {string} originalLabel
 * @param {() => void} onConfirm
 */
function makeRejectWithConfirm(btn, originalLabel, onConfirm) {
  let timerId = /** @type {number|undefined} */ (undefined);
  btn.addEventListener('click', () => {
    if (btn.textContent === 'Confirm') {
      clearTimeout(timerId);
      onConfirm();
    } else {
      btn.textContent = 'Confirm';
      timerId = setTimeout(() => {
        btn.textContent = originalLabel;
      }, 3000);
    }
  });
}

/**
 * @param {string} filePath
 * @param {number} index
 * @returns {HTMLElement}
 */
function createHunkActions(filePath, index) {
  const actionsEl = document.createElement('div');
  actionsEl.className = 'hunk-inline-actions';

  const approveBtn = document.createElement('button');
  approveBtn.className = 'btn-approve';
  approveBtn.textContent = 'Approve';
  approveBtn.addEventListener('click', () => {
    vscode.postMessage({ command: 'approve', filePath, hunkIndex: index });
  });

  const rejectBtn = document.createElement('button');
  rejectBtn.className = 'btn-reject';
  rejectBtn.textContent = 'Reject';
  makeRejectWithConfirm(rejectBtn, 'Reject', () => {
    vscode.postMessage({ command: 'reject', filePath, hunkIndex: index });
  });

  actionsEl.appendChild(approveBtn);
  actionsEl.appendChild(rejectBtn);
  return actionsEl;
}

/**
 * @param {number} hunkIndex
 * @param {string} status
 */
function updateHunkStatus(hunkIndex, status) {
  const hunkEl = container?.querySelector(`.inline-hunk[data-hunk-index="${hunkIndex}"]`);
  if (!hunkEl) return;

  hunkEl.className = `inline-hunk ${status}`;

  const oldActions = hunkEl.querySelector('.hunk-inline-actions');
  if (oldActions) oldActions.remove();
  const oldBadge = hunkEl.querySelector('.hunk-status-badge');
  if (oldBadge) oldBadge.remove();

  const diffLines = hunkEl.querySelectorAll('.diff-line');
  let insertAfter = null;
  for (let i = diffLines.length - 1; i >= 0; i--) {
    if (diffLines[i].classList.contains('add') || diffLines[i].classList.contains('remove')) {
      insertAfter = diffLines[i];
      break;
    }
  }

  if (status === 'pending') {
    const actionsEl = createHunkActions(currentFilePath, hunkIndex);
    if (insertAfter && insertAfter.nextSibling) {
      hunkEl.insertBefore(actionsEl, insertAfter.nextSibling);
    } else {
      hunkEl.appendChild(actionsEl);
    }
  } else if (status === 'approved') {
    const badge = createUndoBadge(currentFilePath, hunkIndex);
    if (insertAfter && insertAfter.nextSibling) {
      hunkEl.insertBefore(badge, insertAfter.nextSibling);
    } else {
      hunkEl.appendChild(badge);
    }
  } else {
    const badge = document.createElement('span');
    badge.className = `hunk-status-badge ${status}`;
    badge.textContent = status;
    if (insertAfter && insertAfter.nextSibling) {
      hunkEl.insertBefore(badge, insertAfter.nextSibling);
    } else {
      hunkEl.appendChild(badge);
    }
  }

  const state = vscode.getState();
  if (state && state.hunkStatuses) {
    state.hunkStatuses[hunkIndex] = status;
    vscode.setState(state);
  }

  // Hide/show top-bar actions based on pending hunks
  if (container) {
    const hasPending = container.querySelector('.inline-hunk.pending');
    const topBar = container.querySelector('.top-bar');
    const existingActions = container.querySelector('.top-bar-actions');
    if (!hasPending && existingActions) {
      existingActions.remove();
    } else if (hasPending && !existingActions && topBar) {
      const actions = document.createElement('div');
      actions.className = 'top-bar-actions';

      const approveAllBtn = document.createElement('button');
      approveAllBtn.className = 'btn-approve';
      approveAllBtn.textContent = 'Approve All';
      approveAllBtn.addEventListener('click', () => {
        vscode.postMessage({ command: 'approveAll', filePath: currentFilePath });
      });

      const rejectAllBtn = document.createElement('button');
      rejectAllBtn.className = 'btn-reject';
      rejectAllBtn.textContent = 'Reject All';
      makeRejectWithConfirm(rejectAllBtn, 'Reject All', () => {
        vscode.postMessage({ command: 'rejectAll', filePath: currentFilePath });
      });

      actions.appendChild(approveAllBtn);
      actions.appendChild(rejectAllBtn);
      topBar.appendChild(actions);
    }
  }

  // Refresh scroll map after status change
  requestAnimationFrame(() => buildScrollMap());
}

/**
 * Build (or rebuild) the scroll map showing colored markers for pending hunks.
 */
function buildScrollMap() {
  // Remove existing scroll map
  const existing = document.getElementById('scroll-map');
  if (existing) existing.remove();

  if (!container) return;

  const pendingHunks = container.querySelectorAll('.inline-hunk.pending');
  if (pendingHunks.length === 0) return;

  const totalHeight = document.documentElement.scrollHeight;
  if (totalHeight <= window.innerHeight) return; // no scrollbar visible

  const mapEl = document.createElement('div');
  mapEl.className = 'scroll-map';
  mapEl.id = 'scroll-map';

  for (const hunkEl of pendingHunks) {
    const rect = hunkEl.getBoundingClientRect();
    const scrollTop = window.scrollY || document.documentElement.scrollTop;
    const absTop = rect.top + scrollTop;
    const absHeight = rect.height;

    // Determine marker type based on diff line types present
    const hasAdd = hunkEl.querySelector('.diff-line.add') !== null;
    const hasRemove = hunkEl.querySelector('.diff-line.remove') !== null;
    let markerClass = 'mixed';
    if (hasAdd && !hasRemove) markerClass = 'add';
    else if (hasRemove && !hasAdd) markerClass = 'remove';

    const marker = document.createElement('div');
    marker.className = `scroll-map-marker ${markerClass}`;
    // Position proportionally within viewport height
    const topPercent = (absTop / totalHeight) * 100;
    const heightPercent = Math.max(0.3, (absHeight / totalHeight) * 100);
    marker.style.top = `${topPercent}%`;
    marker.style.height = `${heightPercent}%`;

    // Click to scroll to the hunk
    marker.addEventListener('click', () => {
      hunkEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
    });

    mapEl.appendChild(marker);
  }

  document.body.appendChild(mapEl);
}

// Rebuild scroll map on resize
window.addEventListener('resize', () => {
  requestAnimationFrame(() => buildScrollMap());
});

/**
 * @param {string} text
 * @returns {string}
 */
function escapeHtml(text) {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
