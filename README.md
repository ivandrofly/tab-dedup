# Tab Dedup

A Chrome extension (Manifest V3, plain JS, no build step) that finds open tabs pointing at the same URL in all your windows, shows them grouped together, and lets you choose which ones to close.

It's a sibling of [bookmark-dedup](https://github.com/ivandrofly/bookmark-dedup), which does the same for bookmarks.

## Install (unpacked)

1. Open `chrome://extensions`.
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked** and select this folder. You can also download `tab-dedup-<version>.zip` from [Releases](https://github.com/ivandrofly/tab-dedup/releases), extract it, and select the extracted folder.
4. Pin the extension. The badge on its icon shows how many duplicate tabs are open right now.

Open the popup by clicking the icon or with <kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>D</kbd>. You can change the shortcut at `chrome://extensions/shortcuts`.

## Using it

- Each card is one group of duplicate tabs. Every row shows the title, the URL, which window the tab is in, and whether it is active, pinned or playing audio.
- **Keep** (radio) marks the tab you want to keep. The default is: the active tab in the current window, then a pinned tab, then any active tab, then the most recently used tab.
- **Close N others** closes every other tab in that group. **Close all duplicates** does that for every group at once.
- **Close** on a row closes just that one tab. Clicking a title switches to that tab.
- **Undo** (in the toast, the header, or <kbd>Ctrl</kbd>+<kbd>Z</kbd>) restores the last closed batch through Chrome's session history, so tabs come back with their back/forward history. It keeps working after you close and reopen the popup, until the browser restarts.

### Matching modes

| Mode | Treated as duplicates |
| --- | --- |
| **Normalized** (default) | Ignores `http` vs `https`, a leading `www.`, host case, default ports (`:80`/`:443`), the `#fragment` and trailing slashes. The query string **does** count. Non-http(s) URLs such as `chrome://newtab/` are compared exactly. |
| **Exact** | Only URLs that are identical character for character. |

The toolbar badge always uses Normalized mode.

## Permissions

| Permission | Why |
| --- | --- |
| `tabs` | read tab URLs and titles, close tabs |
| `sessions` | restore closed tabs with their history (Undo) |
| `storage` | keep the undo stack in session storage, so it survives the popup closing |
| `favicon` | show site icons from Chrome's favicon cache |

There are no host permissions, and nothing leaves your browser.

## Project layout

```
manifest.json       extension manifest (MV3)
background.js       service worker: toolbar badge, and does the actual close and undo
popup.html/css/js   the UI
lib/normalize.js    pure logic: URL normalization, grouping, default keep, session matching
tests/              node:test unit tests for lib/
icons/              toolbar / store icons
```

## Tests

```
npm test
```

This needs only Node 18+ and has no dependencies. CI runs it on Node 22 and 24.

## Releasing

1. Bump `version` in `manifest.json` (and `package.json`), then commit and push.
2. Tag and push: `git tag -a vX.Y.Z -m vX.Y.Z && git push origin vX.Y.Z`

The [Release workflow](.github/workflows/release.yml) runs the tests, checks that the tag matches `manifest.json`, builds a zip of the extension files only, and publishes the GitHub release. 0.x versions are published as pre-releases.
