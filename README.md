# 📚 Tab Bookmark

**English** · [中文](./README.zh-CN.md)

> Turn your browser bookmarks and history into a time machine — and bring your forgotten bookmarks back with active recall.

🍴 Builds on [kellycatz/tab-bookmark](https://github.com/kellycatz/tab-bookmark) (itself forked from [zarazhangrui/tab-out](https://github.com/zarazhangrui/tab-out)) and adds a **🎲 Random Recall** view on top of its bookmarks organizer + recent history footprint.

> ℹ️ **Language note:** the running UI is in **Simplified Chinese only** — English is not yet implemented (no `_locales` / i18n). This README is bilingual.

---

## What is this

Tab Bookmark is a Chrome extension that turns your new-tab page into four entry points:

1. **🗂 Open Tabs** — All open tabs grouped by domain in real time
2. **📚 Organize Bookmarks** — Rediscover and clean up the hundreds of legacy bookmarks
3. **👣 Recent Footprint** — A 7×24 weekly heatmap of where you actually spent your time
4. **🎲 Random Recall** — Surface weighted-random bookmarks as flashcards for active recall

100% local. No server, no external API calls, no account.

---

## ✨ Features

### 🗂 Open Tabs

All open tabs grouped by domain into cards in real time. Homepages (Gmail / X / LinkedIn / YouTube / GitHub) get pulled into their own group. Closing tabs comes with a swoosh sound + confetti. Duplicate-tab detection, save-for-later checklist, localhost port labels for vibe-coding projects.

### 📚 Organize Bookmarks

Two modes: **Time Machine** buckets your bookmarks into 3 / 6 / 12 month period cards — click the CTA on any card to drop into cleanup scoped to that period. **Browse** mode is a horizontal-lane view with multi-select, bulk delete / move-to, sticky folder TOC, and three age tiers (1 / 2 / 3 years+). Built-in duplicate detection, dead-link checking, and empty-folder cleanup.

### 👣 Recent Footprint

A 7×24 weekly heatmap shows which days × hours you were most active. **Click any cell** to drill down into the actual pages visited at that slot. Pair with top-domain / top-page lists — every chart is clickable as a filter, with a chip bar at the top showing active filters. Time window: 24h / 3d / 7d / 30d / 90d.

### 🎲 Random Recall

Surfaces your bookmarks **one at a time** as a big flashcard, picked by **weighted random** — 待回忆 (to-review) shows up most, 已掌握 (mastered) rarely resurfaces, so review effort goes where it matters. For each card you can:

- **Open** the page in a new tab
- **Move to folder** (reuses the bookmarks organizer's folder list)
- **Delete** the bookmark
- Mark **已掌握 (mastered)** or **待回忆 (to-review)**

Review state persists locally in `chrome.storage.local`, so your progress survives restarts, and orphaned state for deleted bookmarks is pruned automatically. Turns "bookmarked-and-forgotten" links into an active-recall habit.

### 🎨 Three themes (top-right switcher)

- **TypeSys** (default) — cool sage paper + warm beige cards + deep teal accent
- **Roughcut Warm** — neutral cream + warm amber + brick red
- **Dark** — near-black warm bg + lighter teal accent

Choice persists across sessions.

---

## Install

### Option 1: Download ZIP (easiest, no git required)

1. Click the green **Code** button at the top-right of this repo's home page → **Download ZIP**
2. **Unzip** the file anywhere (e.g. Desktop)
3. Open Chrome and go to `chrome://extensions/`
4. Toggle **Developer mode** (top-right)
5. Click **Load unpacked** (top-left) and pick the `extension/` folder inside the unzipped directory
6. Open a new tab — Chrome will prompt **"This page was changed by extension 'Tab Out'"** the first time → click **Keep changes**

Done.

### Option 2: hand it to a coding agent

Send this repo URL to Claude Code / Codex / similar:

```
https://github.com/Clifford0550/tab-bookmark-memory
```

Tell it "install this". Takes about a minute.

### Option 3: clone with git

```bash
git clone https://github.com/Clifford0550/tab-bookmark-memory.git
```

Then follow steps 3–6 of Option 1.

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
- Bookmarks organizer + history footprint: MIT © 2026 饼饼几
- Random Recall view: MIT © 2026 Clifford

You're free to use, modify, and redistribute under MIT. Please retain the original copyright notice.

---

## Credits

Original project [Tab Out by Zara](https://github.com/zarazhangrui/tab-out) provided the open-tabs dashboard and the warm-color foundation this fork iterates on.

---

🎲 Random Recall view built by [Clifford](https://github.com/Clifford0550) on top of [tab-bookmark](https://github.com/kellycatz/tab-bookmark) by [饼饼几](https://www.xiaohongshu.com/user/profile/654a536a000000000400a77e), itself based on [Tab Out](https://github.com/zarazhangrui/tab-out) by Zara.
