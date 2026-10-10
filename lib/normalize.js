// Pure helpers (no chrome.* calls) so they can be unit-tested in Node.
// normalizeUrl/groupDuplicates are shared in spirit with bookmark-dedup.

export const MODES = Object.freeze({ NORMALIZED: 'normalized', EXACT: 'exact' });

/**
 * Returns the key used to decide whether two tab URLs are duplicates.
 *
 * In normalized mode, for http(s) URLs only:
 *  - scheme is ignored (http == https)
 *  - host is lowercased and a leading "www." is dropped
 *  - default ports (80, 443) are dropped
 *  - the #fragment is dropped
 *  - trailing slashes on the path are dropped (root stays "/")
 *  - the query string is kept as-is
 * Any other scheme, or a URL that cannot be parsed, is compared verbatim.
 */
export function normalizeUrl(url, mode = MODES.NORMALIZED) {
  if (mode === MODES.EXACT) return url;

  let u;
  try {
    u = new URL(url);
  } catch {
    return url;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return url;

  let host = u.hostname.toLowerCase();
  if (host.startsWith('www.')) host = host.slice(4);

  const port = u.port && u.port !== '80' && u.port !== '443' ? `:${u.port}` : '';

  let path = u.pathname;
  if (path.length > 1) path = path.replace(/\/+$/, '') || '/';

  return `${host}${port}${path}${u.search}`;
}

/**
 * Converts chrome.tabs.Tab objects into plain items with a human window label.
 * Tabs whose URL starts with `ignorePrefix` (the extension's own pages) are skipped.
 */
export function toItems(tabs, { currentWindowId, ignorePrefix } = {}) {
  const windowIds = [...new Set(tabs.map((t) => t.windowId))].sort((a, b) => a - b);
  const labelOf = new Map(windowIds.map((id, i) => [
    id,
    `Window ${i + 1}${id === currentWindowId ? ' (this window)' : ''}`,
  ]));

  const items = [];
  for (const tab of tabs) {
    const url = tab.url || tab.pendingUrl || '';
    if (!url || (ignorePrefix && url.startsWith(ignorePrefix))) continue;
    items.push({
      id: tab.id,
      windowId: tab.windowId,
      windowLabel: labelOf.get(tab.windowId),
      index: tab.index,
      title: tab.title || '',
      url,
      pinned: !!tab.pinned,
      active: !!tab.active,
      audible: !!tab.audible,
      lastAccessed: tab.lastAccessed ?? 0,
    });
  }
  return items;
}

/**
 * Groups items by normalized URL and returns only groups with 2+ entries.
 * Groups are sorted largest first (then by key); entries keep window/tab order.
 */
export function groupDuplicates(items, mode = MODES.NORMALIZED) {
  const byKey = new Map();
  for (const item of items) {
    const key = normalizeUrl(item.url, mode);
    let list = byKey.get(key);
    if (!list) byKey.set(key, (list = []));
    list.push(item);
  }

  const groups = [];
  for (const [key, list] of byKey) {
    if (list.length < 2) continue;
    list.sort((a, b) => a.windowId - b.windowId || a.index - b.index);
    groups.push({ key, items: list });
  }
  groups.sort((a, b) => b.items.length - a.items.length || a.key.localeCompare(b.key));
  return groups;
}

/** Number of tabs that would be closed if one tab per group were kept. */
export function countExtra(groups) {
  return groups.reduce((n, g) => n + g.items.length - 1, 0);
}

/**
 * Picks the tab to keep by default. Preference order:
 * active in the current window → pinned → active in any window → most recently used.
 */
export function pickDefaultKeep(items, currentWindowId) {
  const rank = (t) => [
    t.active && t.windowId === currentWindowId ? 1 : 0,
    t.pinned ? 1 : 0,
    t.active ? 1 : 0,
    t.lastAccessed,
  ];
  let best = items[0];
  for (const item of items.slice(1)) {
    const a = rank(item), b = rank(best);
    for (let i = 0; i < a.length; i++) {
      if (a[i] !== b[i]) {
        if (a[i] > b[i]) best = item;
        break;
      }
    }
  }
  return best;
}

/**
 * Matches closed tabs to chrome.sessions.getRecentlyClosed() entries so they can
 * be restored later. Each entry is used at most once. Returns one record per
 * closed tab: { url, windowId, sessionId | null }.
 */
export function matchClosedSessions(closed, sessions) {
  const used = new Set();
  return closed.map(({ url, windowId }) => {
    for (const s of sessions) {
      const sid = s.tab?.sessionId;
      if (sid && !used.has(sid) && s.tab.url === url) {
        used.add(sid);
        return { url, windowId, sessionId: sid };
      }
    }
    return { url, windowId, sessionId: null };
  });
}
