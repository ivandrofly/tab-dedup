import { MODES, toItems, groupDuplicates, countExtra, pickDefaultKeep } from './lib/normalize.js';

const MODE_STORAGE_KEY = 'tab-dedup.mode';
const UNDO_KEY = 'undoStack';
const TOAST_MS = 6000;
const OWN_PREFIX = chrome.runtime.getURL('');

const $ = (sel) => document.querySelector(sel);
const els = {
  summary: $('#summary'),
  groups: $('#groups'),
  empty: $('#empty'),
  search: $('#search'),
  closeAll: $('#close-all'),
  undo: $('#undo'),
  toast: $('#toast'),
  toastText: $('#toast-text'),
  toastUndo: $('#toast-undo'),
  groupTpl: $('#group-tpl'),
  rowTpl: $('#row-tpl'),
};

const state = {
  mode: loadMode(),
  query: '',
  currentWindowId: undefined,
  total: 0,
  groups: [],
  keep: new Map(), // group key -> tab id to keep
  busy: false,
};

// ---------- scanning ----------

async function scan() {
  try {
    const [tabs, win] = await Promise.all([chrome.tabs.query({}), chrome.windows.getCurrent()]);
    state.currentWindowId = win.id;
    const items = toItems(tabs, { currentWindowId: win.id, ignorePrefix: OWN_PREFIX });
    state.total = items.length;
    state.groups = groupDuplicates(items, state.mode);
    render();
  } catch (err) {
    console.error(err);
    els.summary.textContent = `Could not read tabs: ${err.message}`;
  }
}

let rescanTimer;
function scheduleScan() {
  clearTimeout(rescanTimer);
  rescanTimer = setTimeout(scan, 150);
}

chrome.tabs.onCreated.addListener(scheduleScan);
chrome.tabs.onRemoved.addListener(scheduleScan);
chrome.tabs.onMoved.addListener(scheduleScan);
chrome.tabs.onAttached.addListener(scheduleScan);
chrome.tabs.onReplaced.addListener(scheduleScan);
chrome.tabs.onUpdated.addListener((_id, change) => {
  if ('url' in change || 'title' in change || 'pinned' in change || 'audible' in change) scheduleScan();
});

// ---------- rendering ----------

function keepIdFor(group) {
  let id = state.keep.get(group.key);
  if (!group.items.some((t) => t.id === id)) {
    id = pickDefaultKeep(group.items, state.currentWindowId).id;
    state.keep.set(group.key, id);
  }
  return id;
}

function render() {
  const { groups } = state;
  const extra = countExtra(groups);

  els.summary.replaceChildren(
    strong(extra), ` duplicate tab${extra === 1 ? '' : 's'} in `,
    strong(groups.length), ` group${groups.length === 1 ? '' : 's'} · ${state.total} open`,
  );
  els.closeAll.disabled = state.busy || extra === 0;
  els.closeAll.textContent = extra ? `Close all ${extra} duplicates` : 'Close all duplicates';

  const q = state.query.trim().toLowerCase();
  const visible = q ? groups.filter((g) => matches(g, q)) : groups;
  els.groups.replaceChildren(...visible.map(renderGroup));

  els.empty.hidden = visible.length > 0;
  els.empty.textContent = groups.length === 0 ? 'No duplicate tabs 🎉' : 'No duplicate groups match your filter.';
}

function matches(group, q) {
  if (group.key.toLowerCase().includes(q)) return true;
  return group.items.some((t) =>
    t.title.toLowerCase().includes(q) ||
    t.url.toLowerCase().includes(q) ||
    t.windowLabel.toLowerCase().includes(q));
}

function renderGroup(group, idx) {
  const node = els.groupTpl.content.firstElementChild.cloneNode(true);
  const key = node.querySelector('.group-key');
  key.textContent = group.key;
  key.title = group.key;
  node.querySelector('.badge').textContent = `${group.items.length}×`;

  const keepId = keepIdFor(group);
  const rows = node.querySelector('.rows');
  for (const tab of group.items) rows.append(renderRow(group, tab, `keep-${idx}`, tab.id === keepId));

  const others = group.items.length - 1;
  const closeOthers = node.querySelector('.close-others');
  closeOthers.textContent = `Close ${others} other${others === 1 ? '' : 's'}`;
  closeOthers.disabled = state.busy;
  closeOthers.addEventListener('click', () => {
    const keep = keepIdFor(group);
    closeTabs(group.items.filter((t) => t.id !== keep));
  });
  return node;
}

function renderRow(group, tab, radioName, kept) {
  const row = els.rowTpl.content.firstElementChild.cloneNode(true);
  row.classList.toggle('kept', kept);

  const radio = row.querySelector('.keep input');
  radio.name = radioName;
  radio.checked = kept;
  radio.addEventListener('change', () => {
    state.keep.set(group.key, tab.id);
    render();
  });

  row.querySelector('.favicon').src = faviconUrl(tab.url);

  const title = row.querySelector('.title');
  title.textContent = tab.title || '(untitled)';
  title.classList.toggle('untitled', !tab.title);
  title.addEventListener('click', () => switchTo(tab));

  const url = row.querySelector('.url');
  url.textContent = tab.url;
  url.title = tab.url;

  row.querySelector('.window').textContent = tab.windowLabel;
  const flags = [];
  if (tab.active) flags.push('● active');
  if (tab.pinned) flags.push('📌 pinned');
  if (tab.audible) flags.push('🔊 playing');
  row.querySelector('.flags').textContent = flags.join('  ');

  const close = row.querySelector('.close');
  close.disabled = state.busy;
  close.addEventListener('click', () => closeTabs([tab]));
  return row;
}

function strong(text) {
  const el = document.createElement('strong');
  el.textContent = String(text);
  return el;
}

function faviconUrl(pageUrl) {
  const url = new URL(chrome.runtime.getURL('/_favicon/'));
  url.searchParams.set('pageUrl', pageUrl);
  url.searchParams.set('size', '32');
  return url.toString();
}

async function switchTo(tab) {
  await chrome.tabs.update(tab.id, { active: true });
  await chrome.windows.update(tab.windowId, { focused: true });
  window.close();
}

// ---------- close / undo (executed by the service worker) ----------

async function send(msg) {
  const res = await chrome.runtime.sendMessage(msg);
  if (res?.error) throw new Error(res.error);
  return res;
}

async function closeTabs(tabs) {
  if (state.busy || tabs.length === 0) return;
  setBusy(true);
  try {
    const { closed, failed } = await send({
      type: 'close',
      tabs: tabs.map(({ id, url, windowId, active }) => ({ id, url, windowId, active })),
    });
    let msg = `Closed ${closed} tab${closed === 1 ? '' : 's'}.`;
    if (failed) msg += ` ${failed} could not be closed.`;
    showToast(msg, closed > 0);
  } catch (err) {
    showToast(`Close failed: ${err.message}`, false);
  } finally {
    setBusy(false);
    scan();
  }
}

async function closeAllDuplicates() {
  const toClose = state.groups.flatMap((g) => {
    const keep = keepIdFor(g);
    return g.items.filter((t) => t.id !== keep);
  });
  await closeTabs(toClose);
}

async function undoLast() {
  if (state.busy) return;
  setBusy(true);
  try {
    const { restored, reopened, total } = await send({ type: 'undo' });
    if (!total) {
      showToast('Nothing to undo.', false);
    } else {
      let msg = `Restored ${restored + reopened} of ${total} tab${total === 1 ? '' : 's'}.`;
      if (reopened) msg += ` ${reopened} reopened without history.`;
      showToast(msg, false);
    }
  } catch (err) {
    showToast(`Undo failed: ${err.message}`, false);
  } finally {
    setBusy(false);
    scan();
  }
}

async function refreshUndoButton() {
  const { [UNDO_KEY]: stack = [] } = await chrome.storage.session.get(UNDO_KEY);
  const last = stack.at(-1);
  els.undo.hidden = !last;
  if (last) els.undo.textContent = `Undo (${last.tabs.length})`;
}

chrome.storage.session.onChanged.addListener((changes) => {
  if (UNDO_KEY in changes) refreshUndoButton();
});

let toastTimer;
function showToast(message, canUndo) {
  els.toastText.textContent = message;
  els.toastUndo.hidden = !canUndo;
  els.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { els.toast.hidden = true; }, TOAST_MS);
}

function setBusy(busy) {
  state.busy = busy;
  document.body.toggleAttribute('aria-busy', busy);
  for (const btn of document.querySelectorAll('.close, .close-others, #close-all, #undo, #toast-undo')) {
    btn.disabled = busy;
  }
}

// ---------- controls ----------

function loadMode() {
  try {
    const saved = localStorage.getItem(MODE_STORAGE_KEY);
    if (saved === MODES.EXACT || saved === MODES.NORMALIZED) return saved;
  } catch { /* storage unavailable */ }
  return MODES.NORMALIZED;
}

for (const radio of document.querySelectorAll('input[name="mode"]')) {
  radio.checked = radio.value === state.mode;
  radio.addEventListener('change', () => {
    state.mode = radio.value;
    try { localStorage.setItem(MODE_STORAGE_KEY, state.mode); } catch { /* ignore */ }
    scan();
  });
}

els.search.addEventListener('input', () => {
  state.query = els.search.value;
  render();
});

els.closeAll.addEventListener('click', closeAllDuplicates);
els.undo.addEventListener('click', undoLast);
els.toastUndo.addEventListener('click', undoLast);

document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === 'z' && e.target !== els.search) {
    e.preventDefault();
    undoLast();
  }
});

refreshUndoButton();
scan();
els.search.focus();
