# 📚 Tab Bookmark

**English** · [中文](./README.zh-CN.md)

> Turn your browser bookmarks and history into a time machine.

🍴 Forked from [zarazhangrui/tab-out](https://github.com/zarazhangrui/tab-out) — adds a full **bookmarks organizer** + **recent history footprint** workflow on top of the original Tab Out.

---

## What is this

Tab Bookmark is a Chrome extension that turns your new-tab page into three entry points:

1. **🗂 Open Tabs** — All open tabs grouped by domain in real time
2. **📚 Organize Bookmarks** — Rediscover and clean up the hundreds of legacy bookmarks
3. **👣 Recent Footprint** — A 7×24 weekly heatmap of where you actually spent your time

100% local. No server, no external API calls, no account.

---

## ✨ Features

### 🗂 Open Tabs

All open tabs grouped by domain into cards in real time. Homepages (Gmail / X / LinkedIn / YouTube / GitHub) get pulled into their own group. Closing tabs comes with a swoosh sound + confetti. Duplicate-tab detection, save-for-later checklist, localhost port labels for vibe-coding projects.

### 📚 Organize Bookmarks

Two modes: **Time Machine** buckets your bookmarks into 3 / 6 / 12 month period cards — click the CTA on any card to drop into cleanup scoped to that period. **Browse** mode is a horizontal-lane view with multi-select, bulk delete / move-to, sticky folder TOC, and three age tiers (1 / 2 / 3 years+). Built-in duplicate detection, dead-link checking, and empty-folder cleanup.

### 👣 Recent Footprint

A 7×24 weekly heatmap shows which days × hours you were most active. **Click any cell** to drill down into the actual pages visited at that slot. Pair with top-domain / top-page lists — every chart is clickable as a filter, with a chip bar at the top showing active filters. Time window: 24h / 3d / 7d / 30d / 90d.

### 🎨 Three themes (top-right switcher)

- **TypeSys** (default) — cool sage paper + warm beige cards + deep teal accent
- **Roughcut Warm** — neutral cream + warm amber + brick red
- **Dark** — near-black warm bg + lighter teal accent

Choice persists across sessions.

---

## Install

### Option 1: hand it to a coding agent

Send this repo URL to Claude Code / Codex / similar:

```
https://github.com/KarenChuang/tab-bookmark
```

Tell it "install this". Takes about a minute.

### Option 2: manual

```bash
git clone https://github.com/KarenChuang/tab-bookmark.git
```

1. Open `chrome://extensions`
2. Toggle **Developer mode** (top-right)
3. Click **Load unpacked** and pick the `extension/` folder
4. On first load Chrome will prompt for **"Read and change your bookmarks / browsing history"** — click **Enable**

Open a new tab — that's it.

### Updating

```bash
cd tab-bookmark && git pull
```

Then go to `chrome://extensions` and click the ↻ icon on the extension card.

---

## Permissions

| Permission | Used for |
|---|---|
| `tabs` / `activeTab` | Read and focus open tabs |
| `storage` | Store the "save for later" checklist + theme preference |
| `bookmarks` | Read / move / delete in the bookmarks organizer |
| `history` | Read browsing history for the footprint view |

**All data stays on-device.** This extension does not connect to any server, call any external API, or transmit any data. Source is fully open and auditable.

---

## Tech stack

| What | How |
|---|---|
| Extension | Chrome Manifest V3 |
| Storage | `chrome.storage.local` + `chrome.bookmarks.*` |
| History | `chrome.history.search` + `chrome.history.getVisits` |
| Dead-link check | `fetch HEAD/GET (no-cors)` + 6s timeout + 16-way concurrency |
| Sticky nav | `position: sticky` + IntersectionObserver |
| Sound | Web Audio API (synthesized, no audio files) |
| Animation | CSS transitions + JS confetti particles |

---

## License

MIT — see [LICENSE](./LICENSE)

- Original project: MIT © 2026 Zara Zhang
- Fork additions: MIT © 2026 饼饼几 / Karen Chuang

You're free to use, modify, and redistribute under MIT. Please retain the original copyright notice.

---

## Credits

Original project [Tab Out by Zara](https://github.com/zarazhangrui/tab-out) provided the open-tabs dashboard and the warm-color foundation this fork iterates on.

---

Built by [饼饼几](https://www.xiaohongshu.com/user/profile/654a536a000000000400a77e) on top of [Tab Out](https://github.com/zarazhangrui/tab-out).
