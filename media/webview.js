// @ts-check

/** @type {ReturnType<typeof acquireVsCodeApi>} */
const vscode = acquireVsCodeApi();

/** @type {string} */
let currentFilePath = '';

/** @type {string[]} */
let currentHighlightedLines = [];

let autoScroll = true;
let pendingAutoScroll = false;

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
      if (pendingAutoScroll && autoScroll) {
        pendingAutoScroll = false;
        requestAnimationFrame(() => scrollToFirstPendingHunk());
      }
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

  container.appendChild(topBar);

  const pendingCount = hunkStatuses.filter((/** @type {string} */ s) => s === 'pending').length;
  if (pendingCount > 0) {
    createFloatingBar(filePath, pendingCount);
  }

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

  // Build scroll map after layout is ready, then auto-scroll to first hunk
  requestAnimationFrame(() => {
    buildScrollMap();
    if (autoScroll) {
      scrollToFirstPendingHunk();
    }
  });
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
  let timerId = /** @type {NodeJS.Timeout|undefined} */ (undefined);

  btn.addEventListener('click', () => {
    if (btn.textContent === 'Confirm?') {
      clearTimeout(timerId);
      onConfirm();
    } else {
      btn.textContent = 'Confirm?';
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
    pendingAutoScroll = true;
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

  // Update floating bar based on pending hunks
  if (container) {
    const pendingHunks = container.querySelectorAll('.inline-hunk.pending');
    createFloatingBar(currentFilePath, pendingHunks.length);
  }

  // Auto-scroll to next pending hunk after approve
  if (autoScroll && status !== 'pending') {
    scrollToNextPendingHunk(hunkIndex);
  }

  // Refresh scroll map after status change
  requestAnimationFrame(() => buildScrollMap());
}

/**
 * Create (or recreate) the floating action bar at the bottom-center.
 * @param {string} filePath
 * @param {number} pendingCount
 */
function createFloatingBar(filePath, pendingCount) {
  const existing = document.getElementById('floating-bar');
  if (existing) existing.remove();

  if (pendingCount <= 0) return;

  const bar = document.createElement('div');
  bar.className = 'floating-bar';
  bar.id = 'floating-bar';

  const countEl = document.createElement('span');
  countEl.className = 'pending-count';
  countEl.textContent = `${pendingCount} left`;
  bar.appendChild(countEl);

  const sep2 = document.createElement('span');
  sep2.className = 'bar-separator';
  bar.appendChild(sep2);

  const acceptBtn = document.createElement('button');
  acceptBtn.className = 'btn-approve';
  acceptBtn.textContent = 'Accept file';
  makeRejectWithConfirm(acceptBtn, 'Accept file', () => {
    pendingAutoScroll = true;
    vscode.postMessage({ command: 'approveAll', filePath });
  });
  bar.appendChild(acceptBtn);

  const rejectBtn = document.createElement('button');
  rejectBtn.className = 'btn-reject';
  rejectBtn.textContent = 'Reject file';
  makeRejectWithConfirm(rejectBtn, 'Reject file', () => {
    pendingAutoScroll = true;
    vscode.postMessage({ command: 'rejectAll', filePath });
  });
  bar.appendChild(rejectBtn);

  const sep3 = document.createElement('span');
  sep3.className = 'bar-separator';
  bar.appendChild(sep3);

  const upBtn = document.createElement('button');
  upBtn.className = 'btn-nav btn-up';
  upBtn.title = 'Previous hunk';
  upBtn.innerHTML = '<svg viewBox="0 0 640 640"><path d="M342.6 73.4C330.1 60.9 309.8 60.9 297.3 73.4L137.3 233.4C124.8 245.9 124.8 266.2 137.3 278.7C149.8 291.2 170.1 291.2 182.6 278.7L288 173.3L288 544C288 561.7 302.3 576 320 576C337.7 576 352 561.7 352 544L352 173.3L457.4 278.7C469.9 291.2 490.2 291.2 502.7 278.7C515.2 266.2 515.2 245.9 502.7 233.4L342.7 73.4z"/></svg>';
  upBtn.addEventListener('click', () => navigateHunk('prev'));
  bar.appendChild(upBtn);

  const downBtn = document.createElement('button');
  downBtn.className = 'btn-nav btn-down';
  downBtn.title = 'Next hunk';
  downBtn.innerHTML = '<svg viewBox="0 0 640 640"><path d="M297.4 566.6C309.9 579.1 330.2 579.1 342.7 566.6L502.7 406.6C515.2 394.1 515.2 373.8 502.7 361.3C490.2 348.8 469.9 348.8 457.4 361.3L352 466.7L352 96C352 78.3 337.7 64 320 64C302.3 64 288 78.3 288 96L288 466.7L182.6 361.3C170.1 348.8 149.8 348.8 137.3 361.3C124.8 373.8 124.8 394.1 137.3 406.6L297.3 566.6z"/></svg>';
  downBtn.addEventListener('click', () => navigateHunk('next'));
  bar.appendChild(downBtn);

  const sep4 = document.createElement('span');
  sep4.className = 'bar-separator';
  bar.appendChild(sep4);

  const settingsWrap = document.createElement('div');
  settingsWrap.className = 'settings-wrap';

  const settingsBtn = document.createElement('button');
  settingsBtn.className = 'btn-nav btn-settings';
  settingsBtn.title = 'Options';
  settingsBtn.innerHTML = '<svg viewBox="0 0 640 640"><path d="M320 208C289.1 208 264 182.9 264 152C264 121.1 289.1 96 320 96C350.9 96 376 121.1 376 152C376 182.9 350.9 208 320 208zM320 432C350.9 432 376 457.1 376 488C376 518.9 350.9 544 320 544C289.1 544 264 518.9 264 488C264 457.1 289.1 432 320 432zM376 320C376 350.9 350.9 376 320 376C289.1 376 264 350.9 264 320C264 289.1 289.1 264 320 264C350.9 264 376 289.1 376 320z"/></svg>';

  const dropUp = document.createElement('div');
  dropUp.className = 'drop-up';
  dropUp.appendChild(createAutoScrollCheckbox());

  settingsBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    dropUp.classList.toggle('open');
  });

  settingsWrap.appendChild(dropUp);
  settingsWrap.appendChild(settingsBtn);
  bar.appendChild(settingsWrap);

  document.addEventListener('click', (e) => {
    if (!settingsWrap.contains(/** @type {Node} */ (e.target))) {
      dropUp.classList.remove('open');
    }
  });

  document.body.appendChild(bar);
}

/**
 * Navigate to the previous or next pending hunk relative to the current scroll position.
 * @param {'prev' | 'next'} direction
 */
function navigateHunk(direction) {
  if (!container) return;
  const hunks = /** @type {HTMLElement[]} */ (Array.from(container.querySelectorAll('.inline-hunk.pending')));
  if (hunks.length === 0) return;

  const viewportCenter = window.scrollY + window.innerHeight / 2;

  if (direction === 'next') {
    for (const hunk of hunks) {
      const rect = hunk.getBoundingClientRect();
      const mid = rect.top + rect.height / 2 + window.scrollY;
      if (mid > viewportCenter + 10) {
        hunk.scrollIntoView({ behavior: 'smooth', block: 'center' });
        return;
      }
    }
    // Wrap to first
    hunks[0].scrollIntoView({ behavior: 'smooth', block: 'center' });
  } else {
    for (let i = hunks.length - 1; i >= 0; i--) {
      const rect = hunks[i].getBoundingClientRect();
      const mid = rect.top + rect.height / 2 + window.scrollY;
      if (mid < viewportCenter - 10) {
        hunks[i].scrollIntoView({ behavior: 'smooth', block: 'center' });
        return;
      }
    }
    // Wrap to last
    hunks[hunks.length - 1].scrollIntoView({ behavior: 'smooth', block: 'center' });
  }
}

/**
 * Create the auto-scroll checkbox element.
 * @returns {HTMLElement}
 */
function createAutoScrollCheckbox() {
  const label = document.createElement('label');
  label.className = 'auto-scroll-label';

  const checkbox = document.createElement('input');
  checkbox.type = 'checkbox';
  checkbox.checked = autoScroll;
  checkbox.addEventListener('change', () => {
    autoScroll = checkbox.checked;
  });

  const text = document.createElement('span');
  text.textContent = 'Auto scroll';

  label.appendChild(checkbox);
  label.appendChild(text);
  return label;
}

/**
 * Scroll to the next pending hunk after the given hunk index (DOM order).
 * Wraps around to the first pending hunk if none found after current.
 * @param {number} currentHunkIndex
 */
function scrollToNextPendingHunk(currentHunkIndex) {
  if (!container) return;

  const allHunks = container.querySelectorAll('.inline-hunk');
  let foundCurrent = false;

  for (const hunk of allHunks) {
    if (Number(hunk.dataset.hunkIndex) === currentHunkIndex) {
      foundCurrent = true;
      continue;
    }
    if (foundCurrent && hunk.classList.contains('pending')) {
      hunk.scrollIntoView({ behavior: 'smooth', block: 'center' });
      return;
    }
  }

  // Wrap around to first pending
  const firstPending = container.querySelector('.inline-hunk.pending');
  if (firstPending) {
    firstPending.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }
}

/**
 * Scroll to the first pending hunk in the file.
 */
function scrollToFirstPendingHunk() {
  if (!container) return;
  const firstPending = container.querySelector('.inline-hunk.pending');
  if (firstPending) {
    firstPending.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }
}

/**
 * Build (or rebuild) the scroll map showing colored markers for pending hunks.
 */
function buildScrollMap() {
  // Remove existing scroll map
  const existing = document.getElementById('scroll-map');
  if (existing) existing.remove();

  if (!container) return;

  const visibleHunks = container.querySelectorAll('.inline-hunk.pending, .inline-hunk.approved');
  if (visibleHunks.length === 0) return;

  const totalHeight = document.documentElement.scrollHeight;
  if (totalHeight <= window.innerHeight) return; // no scrollbar visible

  const mapEl = document.createElement('div');
  mapEl.className = 'scroll-map';
  mapEl.id = 'scroll-map';

  for (const hunkEl of visibleHunks) {
    const rect = hunkEl.getBoundingClientRect();
    const scrollTop = window.scrollY || document.documentElement.scrollTop;
    const absTop = rect.top + scrollTop;
    const absHeight = rect.height;

    const isApproved = hunkEl.classList.contains('approved');

    // Determine marker type based on diff line types present
    const hasAdd = hunkEl.querySelector('.diff-line.add') !== null;
    const hasRemove = hunkEl.querySelector('.diff-line.remove') !== null;
    let markerClass = 'mixed';
    if (hasAdd && !hasRemove) markerClass = 'add';
    else if (hasRemove && !hasAdd) markerClass = 'remove';

    if (isApproved) markerClass += ' approved';

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
