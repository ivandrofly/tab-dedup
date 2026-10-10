import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeUrl, toItems, groupDuplicates, countExtra, pickDefaultKeep, matchClosedSessions, MODES,
} from '../lib/normalize.js';

const same = (a, b) => assert.equal(normalizeUrl(a), normalizeUrl(b), `${a} vs ${b}`);
const differ = (a, b) => assert.notEqual(normalizeUrl(a), normalizeUrl(b), `${a} vs ${b}`);

// ---------- normalizeUrl ----------

test('trailing slash is ignored', () => {
  same('https://example.com/docs/', 'https://example.com/docs');
  same('https://example.com/', 'https://example.com');
  same('https://example.com/a//', 'https://example.com/a');
});

test('http and https are the same', () => {
  same('http://example.com/a', 'https://example.com/a');
});

test('www. prefix and host case are ignored', () => {
  same('https://www.Example.COM/a', 'https://example.com/a');
});

test('fragment is ignored', () => {
  same('https://example.com/a#section', 'https://example.com/a');
});

test('default ports are ignored, other ports are not', () => {
  same('http://example.com:80/a', 'https://example.com:443/a');
  differ('https://example.com:8080/a', 'https://example.com/a');
});

test('query string is kept', () => {
  differ('https://example.com/a?x=1', 'https://example.com/a?x=2');
  same('https://example.com/a/?x=1#top', 'https://example.com/a?x=1');
});

test('non-http schemes are compared verbatim', () => {
  same('chrome://newtab/', 'chrome://newtab/');
  differ('chrome://settings/', 'chrome://settings');
});

test('malformed URL falls back to the raw string; exact mode is verbatim', () => {
  assert.equal(normalizeUrl('not a url'), 'not a url');
  const url = 'https://www.Example.com/a/#x';
  assert.equal(normalizeUrl(url, MODES.EXACT), url);
});

// ---------- toItems ----------

test('toItems labels windows, uses pendingUrl, skips own extension pages', () => {
  const tabs = [
    { id: 1, windowId: 900, index: 0, url: 'https://a.com', title: 'A', active: true },
    { id: 2, windowId: 100, index: 0, url: '', pendingUrl: 'https://b.com' },
    { id: 3, windowId: 100, index: 1, url: 'chrome-extension://abc/popup.html' },
    { id: 4, windowId: 100, index: 2, url: '' },
  ];
  const items = toItems(tabs, { currentWindowId: 900, ignorePrefix: 'chrome-extension://abc/' });
  assert.deepEqual(items.map((i) => [i.id, i.url, i.windowLabel]), [
    [1, 'https://a.com', 'Window 2 (this window)'],
    [2, 'https://b.com', 'Window 1'],
  ]);
  assert.equal(items[1].title, '');
  assert.equal(items[1].lastAccessed, 0);
});

// ---------- groupDuplicates ----------

test('groupDuplicates keeps only duplicates, sorted by size then window/tab order', () => {
  const items = [
    { id: 1, windowId: 2, index: 5, url: 'https://example.com/' },
    { id: 2, windowId: 1, index: 3, url: 'http://www.example.com' },
    { id: 3, windowId: 1, index: 1, url: 'https://example.com/#x' },
    { id: 4, windowId: 1, index: 0, url: 'https://b.com/x' },
    { id: 5, windowId: 1, index: 9, url: 'https://b.com/x/' },
    { id: 6, windowId: 1, index: 2, url: 'https://unique.com' },
  ];
  const groups = groupDuplicates(items);
  assert.deepEqual(groups.map((g) => g.items.map((i) => i.id)), [[3, 2, 1], [4, 5]]);
  assert.equal(countExtra(groups), 3);
  assert.equal(groupDuplicates(items, MODES.EXACT).length, 0);
});

// ---------- pickDefaultKeep ----------

test('pickDefaultKeep prefers active-in-current-window, then pinned, then active, then recent', () => {
  const base = { pinned: false, active: false, lastAccessed: 0, windowId: 1 };
  const recent = { ...base, id: 'recent', lastAccessed: 50 };
  const old = { ...base, id: 'old', lastAccessed: 10 };
  const activeOther = { ...base, id: 'activeOther', active: true, windowId: 2 };
  const pinned = { ...base, id: 'pinned', pinned: true };
  const activeHere = { ...base, id: 'activeHere', active: true, windowId: 1 };

  assert.equal(pickDefaultKeep([old, recent], 1).id, 'recent');
  assert.equal(pickDefaultKeep([recent, activeOther], 1).id, 'activeOther');
  assert.equal(pickDefaultKeep([activeOther, pinned], 1).id, 'pinned');
  assert.equal(pickDefaultKeep([pinned, activeHere, recent], 1).id, 'activeHere');
});

// ---------- matchClosedSessions ----------

test('matchClosedSessions pairs each closed tab with a distinct session entry', () => {
  const closed = [
    { url: 'https://a.com', windowId: 1 },
    { url: 'https://a.com', windowId: 2 },
    { url: 'https://gone.com', windowId: 1 },
  ];
  const sessions = [
    { tab: { url: 'https://a.com', sessionId: 's2' } },
    { window: { sessionId: 'w1', tabs: [] } },
    { tab: { url: 'https://a.com', sessionId: 's1' } },
    { tab: { url: 'https://other.com', sessionId: 's0' } },
  ];
  assert.deepEqual(matchClosedSessions(closed, sessions).map((r) => r.sessionId), ['s2', 's1', null]);
});
