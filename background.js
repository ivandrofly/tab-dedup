import { toItems, groupDuplicates, countExtra, matchClosedSessions } from './lib/normalize.js';

// Closing and undo run here (not in the popup) so they finish even if the
// popup is dismissed half-way, e.g. when the active tab gets closed.

const UNDO_KEY = 'undoStack';
const UNDO_LIMIT = 20;
const OWN_PREFIX = chrome.runtime.getURL('');

// ---------- toolbar badge ----------

let badgeTimer;
function scheduleBadge() {
  clearTimeout(badgeTimer);
  badgeTimer = setTimeout(updateBadge, 250);
}

async function updateBadge() {
  const tabs = await chrome.tabs.query({});
  const extra = countExtra(groupDuplicates(toItems(tabs, { ignorePrefix: OWN_PREFIX })));
  await chrome.action.setBadgeText({ text: extra ? String(extra) : '' });
  await chrome.action.setBadgeBackgroundColor({ color: '#5f6368' });
  await chrome.action.setTitle({
    title: extra ? `Tab Dedup: ${extra} duplicate tab${extra === 1 ? '' : 's'}` : 'Tab Dedup: no duplicates',
  });
}

chrome.tabs.onCreated.addListener(scheduleBadge);
chrome.tabs.onRemoved.addListener(scheduleBadge);
chrome.tabs.onReplaced.addListener(scheduleBadge);
chrome.tabs.onUpdated.addListener((_id, change) => {
  if ('url' in change) scheduleBadge();
});
chrome.runtime.onStartup.addListener(scheduleBadge);
chrome.runtime.onInstalled.addListener(scheduleBadge);

// ---------- close / undo ----------

async function readUndo() {
  const { [UNDO_KEY]: stack = [] } = await chrome.storage.session.get(UNDO_KEY);
  return stack;
}

async function writeUndo(stack) {
  await chrome.storage.session.set({ [UNDO_KEY]: stack.slice(-UNDO_LIMIT) });
}

/** tabs: [{ id, url, windowId, active }] */
async function closeTabs(tabs) {
  // Active tabs last: closing one can dismiss the popup that asked for this.
  const ordered = [...tabs].sort((a, b) => Number(a.active) - Number(b.active));
  const closed = [];
  let failed = 0;
  for (const tab of ordered) {
    try {
      await chrome.tabs.remove(tab.id);
      closed.push(tab);
    } catch (err) {
      console.warn('close failed', tab, err);
      failed++;
    }
  }

  if (closed.length) {
    const sessions = await chrome.sessions.getRecentlyClosed({ maxResults: chrome.sessions.MAX_SESSION_RESULTS });
    const stack = await readUndo();
    stack.push({ at: Date.now(), tabs: matchClosedSessions(closed, sessions) });
    await writeUndo(stack);
  }
  return { closed: closed.length, failed };
}

async function undoLast() {
  const stack = await readUndo();
  const batch = stack.pop();
  if (!batch) return { restored: 0, reopened: 0, total: 0 };
  await writeUndo(stack);

  let restored = 0;
  let reopened = 0;
  for (const rec of batch.tabs) {
    if (rec.sessionId) {
      try {
        await chrome.sessions.restore(rec.sessionId);
        restored++;
        continue;
      } catch (err) {
        console.warn('session restore failed, reopening by URL', rec, err);
      }
    }
    // No session entry: reopen by URL (loses back/forward history).
    try {
      await chrome.tabs.create({ url: rec.url, windowId: rec.windowId, active: false });
      reopened++;
    } catch {
      try {
        await chrome.tabs.create({ url: rec.url, active: false });
        reopened++;
      } catch (err) {
        console.warn('reopen failed', rec, err);
      }
    }
  }
  return { restored, reopened, total: batch.tabs.length };
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id) return false;
  const handlers = {
    close: () => closeTabs(msg.tabs),
    undo: () => undoLast(),
  };
  const handler = handlers[msg?.type];
  if (!handler) return false;
  handler().then(sendResponse, (err) => sendResponse({ error: String(err?.message ?? err) }));
  return true; // async response
});
