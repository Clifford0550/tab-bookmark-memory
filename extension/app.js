/* ================================================================
   Tab Out — Dashboard App (Pure Extension Edition)

   This file is the brain of the dashboard. Now that the dashboard
   IS the extension page (not inside an iframe), it can call
   chrome.tabs and chrome.storage directly — no postMessage bridge needed.

   What this file does:
   1. Reads open browser tabs directly via chrome.tabs.query()
   2. Groups tabs by domain with a landing pages category
   3. Renders domain cards, banners, and stats
   4. Handles all user actions (close tabs, save for later, focus tab)
   5. Stores "Saved for Later" tabs in chrome.storage.local (no server)
   ================================================================ */

'use strict';


/* ----------------------------------------------------------------
   CHROME TABS — Direct API Access

   Since this page IS the extension's new tab page, it has full
   access to chrome.tabs and chrome.storage. No middleman needed.
   ---------------------------------------------------------------- */

// All open tabs — populated by fetchOpenTabs()
let openTabs = [];

/**
 * fetchOpenTabs()
 *
 * Reads all currently open browser tabs directly from Chrome.
 * Sets the extensionId flag so we can identify Tab Out's own pages.
 */
async function fetchOpenTabs() {
  try {
    const extensionId = chrome.runtime.id;
    // The new URL for this page is now index.html (not newtab.html)
    const newtabUrl = `chrome-extension://${extensionId}/index.html`;

    const tabs = await chrome.tabs.query({});
    openTabs = tabs.map(t => ({
      id:       t.id,
      url:      t.url,
      title:    t.title,
      windowId: t.windowId,
      active:   t.active,
      // Flag Tab Out's own pages so we can detect duplicate new tabs
      isTabOut: t.url === newtabUrl || t.url === 'chrome://newtab/',
    }));
  } catch {
    // chrome.tabs API unavailable (shouldn't happen in an extension page)
    openTabs = [];
  }
}

/**
 * closeTabsByUrls(urls)
 *
 * Closes all open tabs whose hostname matches any of the given URLs.
 * After closing, re-fetches the tab list to keep our state accurate.
 *
 * Special case: file:// URLs are matched exactly (they have no hostname).
 */
async function closeTabsByUrls(urls) {
  if (!urls || urls.length === 0) return;

  // Separate file:// URLs (exact match) from regular URLs (hostname match)
  const targetHostnames = [];
  const exactUrls = new Set();

  for (const u of urls) {
    if (u.startsWith('file://')) {
      exactUrls.add(u);
    } else {
      try { targetHostnames.push(new URL(u).hostname); }
      catch { /* skip unparseable */ }
    }
  }

  const allTabs = await chrome.tabs.query({});
  const toClose = allTabs
    .filter(tab => {
      const tabUrl = tab.url || '';
      if (tabUrl.startsWith('file://') && exactUrls.has(tabUrl)) return true;
      try {
        const tabHostname = new URL(tabUrl).hostname;
        return tabHostname && targetHostnames.includes(tabHostname);
      } catch { return false; }
    })
    .map(tab => tab.id);

  if (toClose.length > 0) await chrome.tabs.remove(toClose);
  await fetchOpenTabs();
}

/**
 * closeTabsExact(urls)
 *
 * Closes tabs by exact URL match (not hostname). Used for landing pages
 * so closing "Gmail inbox" doesn't also close individual email threads.
 */
async function closeTabsExact(urls) {
  if (!urls || urls.length === 0) return;
  const urlSet = new Set(urls);
  const allTabs = await chrome.tabs.query({});
  const toClose = allTabs.filter(t => urlSet.has(t.url)).map(t => t.id);
  if (toClose.length > 0) await chrome.tabs.remove(toClose);
  await fetchOpenTabs();
}

/**
 * focusTab(url)
 *
 * Switches Chrome to the tab with the given URL (exact match first,
 * then hostname fallback). Also brings the window to the front.
 */
async function focusTab(url) {
  if (!url) return;
  const allTabs = await chrome.tabs.query({});
  const currentWindow = await chrome.windows.getCurrent();

  // Try exact URL match first
  let matches = allTabs.filter(t => t.url === url);

  // Fall back to hostname match
  if (matches.length === 0) {
    try {
      const targetHost = new URL(url).hostname;
      matches = allTabs.filter(t => {
        try { return new URL(t.url).hostname === targetHost; }
        catch { return false; }
      });
    } catch {}
  }

  if (matches.length === 0) return;

  // Prefer a match in a different window so it actually switches windows
  const match = matches.find(t => t.windowId !== currentWindow.id) || matches[0];
  await chrome.tabs.update(match.id, { active: true });
  await chrome.windows.update(match.windowId, { focused: true });
}

/**
 * closeDuplicateTabs(urls, keepOne)
 *
 * Closes duplicate tabs for the given list of URLs.
 * keepOne=true → keep one copy of each, close the rest.
 * keepOne=false → close all copies.
 */
async function closeDuplicateTabs(urls, keepOne = true) {
  const allTabs = await chrome.tabs.query({});
  const toClose = [];

  for (const url of urls) {
    const matching = allTabs.filter(t => t.url === url);
    if (keepOne) {
      const keep = matching.find(t => t.active) || matching[0];
      for (const tab of matching) {
        if (tab.id !== keep.id) toClose.push(tab.id);
      }
    } else {
      for (const tab of matching) toClose.push(tab.id);
    }
  }

  if (toClose.length > 0) await chrome.tabs.remove(toClose);
  await fetchOpenTabs();
}

/**
 * closeTabOutDupes()
 *
 * Closes all duplicate Tab Out new-tab pages except the current one.
 */
async function closeTabOutDupes() {
  const extensionId = chrome.runtime.id;
  const newtabUrl = `chrome-extension://${extensionId}/index.html`;

  const allTabs = await chrome.tabs.query({});
  const currentWindow = await chrome.windows.getCurrent();
  const tabOutTabs = allTabs.filter(t =>
    t.url === newtabUrl || t.url === 'chrome://newtab/'
  );

  if (tabOutTabs.length <= 1) return;

  // Keep the active Tab Out tab in the CURRENT window — that's the one the
  // user is looking at right now. Falls back to any active one, then the first.
  const keep =
    tabOutTabs.find(t => t.active && t.windowId === currentWindow.id) ||
    tabOutTabs.find(t => t.active) ||
    tabOutTabs[0];
  const toClose = tabOutTabs.filter(t => t.id !== keep.id).map(t => t.id);
  if (toClose.length > 0) await chrome.tabs.remove(toClose);
  await fetchOpenTabs();
}


/* ----------------------------------------------------------------
   SAVED FOR LATER — chrome.storage.local

   Replaces the old server-side SQLite + REST API with Chrome's
   built-in key-value storage. Data persists across browser sessions
   and doesn't require a running server.

   Data shape stored under the "deferred" key:
   [
     {
       id: "1712345678901",          // timestamp-based unique ID
       url: "https://example.com",
       title: "Example Page",
       savedAt: "2026-04-04T10:00:00.000Z",  // ISO date string
       completed: false,             // true = checked off (archived)
       dismissed: false              // true = dismissed without reading
     },
     ...
   ]
   ---------------------------------------------------------------- */

/**
 * saveTabForLater(tab)
 *
 * Saves a single tab to the "Saved for Later" list in chrome.storage.local.
 * @param {{ url: string, title: string }} tab
 */
async function saveTabForLater(tab) {
  const { deferred = [] } = await chrome.storage.local.get('deferred');
  deferred.push({
    id:        Date.now().toString(),
    url:       tab.url,
    title:     tab.title,
    savedAt:   new Date().toISOString(),
    completed: false,
    dismissed: false,
  });
  await chrome.storage.local.set({ deferred });
}

/**
 * getSavedTabs()
 *
 * Returns all saved tabs from chrome.storage.local.
 * Filters out dismissed items (those are gone for good).
 * Splits into active (not completed) and archived (completed).
 */
async function getSavedTabs() {
  const { deferred = [] } = await chrome.storage.local.get('deferred');
  const visible = deferred.filter(t => !t.dismissed);
  return {
    active:   visible.filter(t => !t.completed),
    archived: visible.filter(t => t.completed),
  };
}

/**
 * checkOffSavedTab(id)
 *
 * Marks a saved tab as completed (checked off). It moves to the archive.
 */
async function checkOffSavedTab(id) {
  const { deferred = [] } = await chrome.storage.local.get('deferred');
  const tab = deferred.find(t => t.id === id);
  if (tab) {
    tab.completed = true;
    tab.completedAt = new Date().toISOString();
    await chrome.storage.local.set({ deferred });
  }
}

/**
 * dismissSavedTab(id)
 *
 * Marks a saved tab as dismissed (removed from all lists).
 */
async function dismissSavedTab(id) {
  const { deferred = [] } = await chrome.storage.local.get('deferred');
  const tab = deferred.find(t => t.id === id);
  if (tab) {
    tab.dismissed = true;
    await chrome.storage.local.set({ deferred });
  }
}


/* ----------------------------------------------------------------
   UI HELPERS
   ---------------------------------------------------------------- */

/**
 * playCloseSound()
 *
 * Plays a clean "swoosh" sound when tabs are closed.
 * Built entirely with the Web Audio API — no sound files needed.
 * A filtered noise sweep that descends in pitch, like air moving.
 */
function playCloseSound() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const t = ctx.currentTime;

    // Swoosh: shaped white noise through a sweeping bandpass filter
    const duration = 0.25;
    const buffer = ctx.createBuffer(1, ctx.sampleRate * duration, ctx.sampleRate);
    const data = buffer.getChannelData(0);

    // Generate noise with a natural envelope (quick attack, smooth decay)
    for (let i = 0; i < data.length; i++) {
      const pos = i / data.length;
      // Envelope: ramps up fast in first 10%, then fades out smoothly
      const env = pos < 0.1 ? pos / 0.1 : Math.pow(1 - (pos - 0.1) / 0.9, 1.5);
      data[i] = (Math.random() * 2 - 1) * env;
    }

    const source = ctx.createBufferSource();
    source.buffer = buffer;

    // Bandpass filter sweeps from high to low — creates the "swoosh" character
    const filter = ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.Q.value = 2.0;
    filter.frequency.setValueAtTime(4000, t);
    filter.frequency.exponentialRampToValueAtTime(400, t + duration);

    // Volume
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.15, t);
    gain.gain.exponentialRampToValueAtTime(0.001, t + duration);

    source.connect(filter).connect(gain).connect(ctx.destination);
    source.start(t);

    setTimeout(() => ctx.close(), 500);
  } catch {
    // Audio not supported — fail silently
  }
}

/**
 * shootConfetti(x, y)
 *
 * Shoots a burst of colorful confetti particles from the given screen
 * coordinates (typically the center of a card being closed).
 * Pure CSS + JS, no libraries.
 */
function shootConfetti(x, y) {
  const colors = [
    '#c8713a', // amber
    '#e8a070', // amber light
    '#5a7a62', // sage
    '#8aaa92', // sage light
    '#5a6b7a', // slate
    '#8a9baa', // slate light
    '#d4b896', // warm paper
    '#b35a5a', // rose
  ];

  const particleCount = 17;

  for (let i = 0; i < particleCount; i++) {
    const el = document.createElement('div');

    const isCircle = Math.random() > 0.5;
    const size = 5 + Math.random() * 6; // 5–11px
    const color = colors[Math.floor(Math.random() * colors.length)];

    el.style.cssText = `
      position: fixed;
      left: ${x}px;
      top: ${y}px;
      width: ${size}px;
      height: ${size}px;
      background: ${color};
      border-radius: ${isCircle ? '50%' : '2px'};
      pointer-events: none;
      z-index: 9999;
      transform: translate(-50%, -50%);
      opacity: 1;
    `;
    document.body.appendChild(el);

    // Physics: random angle and speed for the outward burst
    const angle   = Math.random() * Math.PI * 2;
    const speed   = 60 + Math.random() * 120;
    const vx      = Math.cos(angle) * speed;
    const vy      = Math.sin(angle) * speed - 80; // bias upward
    const gravity = 200;

    const startTime = performance.now();
    const duration  = 700 + Math.random() * 200; // 700–900ms

    function frame(now) {
      const elapsed  = (now - startTime) / 1000;
      const progress = elapsed / (duration / 1000);

      if (progress >= 1) { el.remove(); return; }

      const px = vx * elapsed;
      const py = vy * elapsed + 0.5 * gravity * elapsed * elapsed;
      const opacity = progress < 0.5 ? 1 : 1 - (progress - 0.5) * 2;
      const rotate  = elapsed * 200 * (isCircle ? 0 : 1);

      el.style.transform = `translate(calc(-50% + ${px}px), calc(-50% + ${py}px)) rotate(${rotate}deg)`;
      el.style.opacity = opacity;

      requestAnimationFrame(frame);
    }

    requestAnimationFrame(frame);
  }
}

/**
 * animateCardOut(card)
 *
 * Smoothly removes a mission card: fade + scale down, then confetti.
 * After the animation, checks if the grid is now empty.
 */
function animateCardOut(card) {
  if (!card) return;

  const rect = card.getBoundingClientRect();
  shootConfetti(rect.left + rect.width / 2, rect.top + rect.height / 2);

  card.classList.add('closing');
  setTimeout(() => {
    card.remove();
    checkAndShowEmptyState();
  }, 300);
}

/**
 * showToast(message)
 *
 * Brief pop-up notification at the bottom of the screen.
 */
function showToast(message) {
  const toast = document.getElementById('toast');
  document.getElementById('toastText').textContent = message;
  toast.classList.add('visible');
  setTimeout(() => toast.classList.remove('visible'), 2500);
}

/**
 * checkAndShowEmptyState()
 *
 * Shows a cheerful "Inbox zero" message when all domain cards are gone.
 */
function checkAndShowEmptyState() {
  const missionsEl = document.getElementById('openTabsMissions');
  if (!missionsEl) return;

  const remaining = missionsEl.querySelectorAll('.mission-card:not(.closing)').length;
  if (remaining > 0) return;

  missionsEl.innerHTML = `
    <div class="missions-empty-state">
      <div class="empty-checkmark">
        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor">
          <path stroke-linecap="round" stroke-linejoin="round" d="m4.5 12.75 6 6 9-13.5" />
        </svg>
      </div>
      <div class="empty-title">Inbox zero, but for tabs.</div>
      <div class="empty-subtitle">You're free.</div>
    </div>
  `;

  const countEl = document.getElementById('openTabsSectionCount');
  if (countEl) countEl.textContent = '0 domains';
}

/**
 * timeAgo(dateStr)
 *
 * Converts an ISO date string into a human-friendly relative time.
 * "2026-04-04T10:00:00Z" → "2 hrs ago" or "yesterday"
 */
function timeAgo(dateStr) {
  if (!dateStr) return '';
  const then = new Date(dateStr);
  const now  = new Date();
  const diffMins  = Math.floor((now - then) / 60000);
  const diffHours = Math.floor((now - then) / 3600000);
  const diffDays  = Math.floor((now - then) / 86400000);

  if (diffMins < 1)   return 'just now';
  if (diffMins < 60)  return diffMins + ' min ago';
  if (diffHours < 24) return diffHours + ' hr' + (diffHours !== 1 ? 's' : '') + ' ago';
  if (diffDays === 1) return 'yesterday';
  return diffDays + ' days ago';
}

/**
 * getGreeting() — "Good morning / afternoon / evening"
 */
function getGreeting() {
  const hour = new Date().getHours();
  if (hour < 12) return 'Good morning';
  if (hour < 17) return 'Good afternoon';
  return 'Good evening';
}

/**
 * getDateDisplay() — "Friday, April 4, 2026"
 */
function getDateDisplay() {
  return new Date().toLocaleDateString('en-US', {
    weekday: 'long',
    year:    'numeric',
    month:   'long',
    day:     'numeric',
  });
}


/* ----------------------------------------------------------------
   DOMAIN & TITLE CLEANUP HELPERS
   ---------------------------------------------------------------- */

// Map of known hostnames → friendly display names.
const FRIENDLY_DOMAINS = {
  'github.com':           'GitHub',
  'www.github.com':       'GitHub',
  'gist.github.com':      'GitHub Gist',
  'youtube.com':          'YouTube',
  'www.youtube.com':      'YouTube',
  'music.youtube.com':    'YouTube Music',
  'x.com':                'X',
  'www.x.com':            'X',
  'twitter.com':          'X',
  'www.twitter.com':      'X',
  'reddit.com':           'Reddit',
  'www.reddit.com':       'Reddit',
  'old.reddit.com':       'Reddit',
  'substack.com':         'Substack',
  'www.substack.com':     'Substack',
  'medium.com':           'Medium',
  'www.medium.com':       'Medium',
  'linkedin.com':         'LinkedIn',
  'www.linkedin.com':     'LinkedIn',
  'stackoverflow.com':    'Stack Overflow',
  'www.stackoverflow.com':'Stack Overflow',
  'news.ycombinator.com': 'Hacker News',
  'google.com':           'Google',
  'www.google.com':       'Google',
  'mail.google.com':      'Gmail',
  'docs.google.com':      'Google Docs',
  'drive.google.com':     'Google Drive',
  'calendar.google.com':  'Google Calendar',
  'meet.google.com':      'Google Meet',
  'gemini.google.com':    'Gemini',
  'chatgpt.com':          'ChatGPT',
  'www.chatgpt.com':      'ChatGPT',
  'chat.openai.com':      'ChatGPT',
  'claude.ai':            'Claude',
  'www.claude.ai':        'Claude',
  'code.claude.com':      'Claude Code',
  'notion.so':            'Notion',
  'www.notion.so':        'Notion',
  'figma.com':            'Figma',
  'www.figma.com':        'Figma',
  'slack.com':            'Slack',
  'app.slack.com':        'Slack',
  'discord.com':          'Discord',
  'www.discord.com':      'Discord',
  'wikipedia.org':        'Wikipedia',
  'en.wikipedia.org':     'Wikipedia',
  'amazon.com':           'Amazon',
  'www.amazon.com':       'Amazon',
  'netflix.com':          'Netflix',
  'www.netflix.com':      'Netflix',
  'spotify.com':          'Spotify',
  'open.spotify.com':     'Spotify',
  'vercel.com':           'Vercel',
  'www.vercel.com':       'Vercel',
  'npmjs.com':            'npm',
  'www.npmjs.com':        'npm',
  'developer.mozilla.org':'MDN',
  'arxiv.org':            'arXiv',
  'www.arxiv.org':        'arXiv',
  'huggingface.co':       'Hugging Face',
  'www.huggingface.co':   'Hugging Face',
  'producthunt.com':      'Product Hunt',
  'www.producthunt.com':  'Product Hunt',
  'xiaohongshu.com':      'RedNote',
  'www.xiaohongshu.com':  'RedNote',
  'local-files':          'Local Files',
};

function friendlyDomain(hostname) {
  if (!hostname) return '';
  if (FRIENDLY_DOMAINS[hostname]) return FRIENDLY_DOMAINS[hostname];

  if (hostname.endsWith('.substack.com') && hostname !== 'substack.com') {
    return capitalize(hostname.replace('.substack.com', '')) + "'s Substack";
  }
  if (hostname.endsWith('.github.io')) {
    return capitalize(hostname.replace('.github.io', '')) + ' (GitHub Pages)';
  }

  let clean = hostname
    .replace(/^www\./, '')
    .replace(/\.(com|org|net|io|co|ai|dev|app|so|me|xyz|info|us|uk|co\.uk|co\.jp)$/, '');

  return clean.split('.').map(part => capitalize(part)).join(' ');
}

function capitalize(str) {
  if (!str) return '';
  return str.charAt(0).toUpperCase() + str.slice(1);
}

function stripTitleNoise(title) {
  if (!title) return '';
  // Strip leading notification count: "(2) Title"
  title = title.replace(/^\(\d+\+?\)\s*/, '');
  // Strip inline counts like "Inbox (16,359)"
  title = title.replace(/\s*\([\d,]+\+?\)\s*/g, ' ');
  // Strip email addresses (privacy + cleaner display)
  title = title.replace(/\s*[\-\u2010-\u2015]\s*[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g, '');
  title = title.replace(/[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g, '');
  // Clean X/Twitter format
  title = title.replace(/\s+on X:\s*/, ': ');
  title = title.replace(/\s*\/\s*X\s*$/, '');
  return title.trim();
}

function cleanTitle(title, hostname) {
  if (!title || !hostname) return title || '';

  const friendly = friendlyDomain(hostname);
  const domain   = hostname.replace(/^www\./, '');
  const seps     = [' - ', ' | ', ' — ', ' · ', ' – '];

  for (const sep of seps) {
    const idx = title.lastIndexOf(sep);
    if (idx === -1) continue;
    const suffix     = title.slice(idx + sep.length).trim();
    const suffixLow  = suffix.toLowerCase();
    if (
      suffixLow === domain.toLowerCase() ||
      suffixLow === friendly.toLowerCase() ||
      suffixLow === domain.replace(/\.\w+$/, '').toLowerCase() ||
      domain.toLowerCase().includes(suffixLow) ||
      friendly.toLowerCase().includes(suffixLow)
    ) {
      const cleaned = title.slice(0, idx).trim();
      if (cleaned.length >= 5) return cleaned;
    }
  }
  return title;
}

function smartTitle(title, url) {
  if (!url) return title || '';
  let pathname = '', hostname = '';
  try { const u = new URL(url); pathname = u.pathname; hostname = u.hostname; }
  catch { return title || ''; }

  const titleIsUrl = !title || title === url || title.startsWith(hostname) || title.startsWith('http');

  if ((hostname === 'x.com' || hostname === 'twitter.com' || hostname === 'www.x.com') && pathname.includes('/status/')) {
    const username = pathname.split('/')[1];
    if (username) return titleIsUrl ? `Post by @${username}` : title;
  }

  if (hostname === 'github.com' || hostname === 'www.github.com') {
    const parts = pathname.split('/').filter(Boolean);
    if (parts.length >= 2) {
      const [owner, repo, ...rest] = parts;
      if (rest[0] === 'issues' && rest[1]) return `${owner}/${repo} Issue #${rest[1]}`;
      if (rest[0] === 'pull'   && rest[1]) return `${owner}/${repo} PR #${rest[1]}`;
      if (rest[0] === 'blob' || rest[0] === 'tree') return `${owner}/${repo} — ${rest.slice(2).join('/')}`;
      if (titleIsUrl) return `${owner}/${repo}`;
    }
  }

  if ((hostname === 'www.youtube.com' || hostname === 'youtube.com') && pathname === '/watch') {
    if (titleIsUrl) return 'YouTube Video';
  }

  if ((hostname === 'www.reddit.com' || hostname === 'reddit.com' || hostname === 'old.reddit.com') && pathname.includes('/comments/')) {
    const parts  = pathname.split('/').filter(Boolean);
    const subIdx = parts.indexOf('r');
    if (subIdx !== -1 && parts[subIdx + 1]) {
      if (titleIsUrl) return `r/${parts[subIdx + 1]} post`;
    }
  }

  return title || url;
}


/* ----------------------------------------------------------------
   SVG ICON STRINGS
   ---------------------------------------------------------------- */
const ICONS = {
  tabs:    `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M3 8.25V18a2.25 2.25 0 0 0 2.25 2.25h13.5A2.25 2.25 0 0 0 21 18V8.25m-18 0V6a2.25 2.25 0 0 1 2.25-2.25h13.5A2.25 2.25 0 0 1 21 6v2.25m-18 0h18" /></svg>`,
  close:   `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18 18 6M6 6l12 12" /></svg>`,
  archive: `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M20.25 7.5l-.625 10.632a2.25 2.25 0 0 1-2.247 2.118H6.622a2.25 2.25 0 0 1-2.247-2.118L3.75 7.5m6 4.125l2.25 2.25m0 0l2.25 2.25M12 13.875l2.25-2.25M12 13.875l-2.25 2.25M3.375 7.5h17.25c.621 0 1.125-.504 1.125-1.125v-1.5c0-.621-.504-1.125-1.125-1.125H3.375c-.621 0-1.125.504-1.125 1.125v1.5c0 .621.504 1.125 1.125 1.125Z" /></svg>`,
  focus:   `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="m4.5 19.5 15-15m0 0H8.25m11.25 0v11.25" /></svg>`,
};


/* ----------------------------------------------------------------
   IN-MEMORY STORE FOR OPEN-TAB GROUPS
   ---------------------------------------------------------------- */
let domainGroups = [];


/* ----------------------------------------------------------------
   HELPER: filter out browser-internal pages
   ---------------------------------------------------------------- */

/**
 * getRealTabs()
 *
 * Returns tabs that are real web pages — no chrome://, extension
 * pages, about:blank, etc.
 */
function getRealTabs() {
  return openTabs.filter(t => {
    const url = t.url || '';
    return (
      !url.startsWith('chrome://') &&
      !url.startsWith('chrome-extension://') &&
      !url.startsWith('about:') &&
      !url.startsWith('edge://') &&
      !url.startsWith('brave://')
    );
  });
}

/**
 * checkTabOutDupes()
 *
 * Counts how many Tab Out pages are open. If more than 1,
 * shows a banner offering to close the extras.
 */
function checkTabOutDupes() {
  const tabOutTabs = openTabs.filter(t => t.isTabOut);
  const banner  = document.getElementById('tabOutDupeBanner');
  const countEl = document.getElementById('tabOutDupeCount');
  if (!banner) return;

  if (tabOutTabs.length > 1) {
    if (countEl) countEl.textContent = tabOutTabs.length;
    banner.style.display = 'flex';
  } else {
    banner.style.display = 'none';
  }
}


/* ----------------------------------------------------------------
   OVERFLOW CHIPS ("+N more" expand button in domain cards)
   ---------------------------------------------------------------- */

function buildOverflowChips(hiddenTabs, urlCounts = {}) {
  const hiddenChips = hiddenTabs.map(tab => {
    const label    = cleanTitle(smartTitle(stripTitleNoise(tab.title || ''), tab.url), '');
    const count    = urlCounts[tab.url] || 1;
    const dupeTag  = count > 1 ? ` <span class="chip-dupe-badge">(${count}x)</span>` : '';
    const chipClass = count > 1 ? ' chip-has-dupes' : '';
    const safeUrl   = (tab.url || '').replace(/"/g, '&quot;');
    const safeTitle = label.replace(/"/g, '&quot;');
    let domain = '';
    try { domain = new URL(tab.url).hostname; } catch {}
    const faviconUrl = domain ? `https://www.google.com/s2/favicons?domain=${domain}&sz=16` : '';
    return `<div class="page-chip clickable${chipClass}" data-action="focus-tab" data-tab-url="${safeUrl}" title="${safeTitle}">
      ${faviconUrl ? `<img class="chip-favicon" src="${faviconUrl}" alt="" onerror="this.style.display='none'">` : ''}
      <span class="chip-text">${label}</span>${dupeTag}
      <div class="chip-actions">
        <button class="chip-action chip-save" data-action="defer-single-tab" data-tab-url="${safeUrl}" data-tab-title="${safeTitle}" title="Save for later">
          <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M17.593 3.322c1.1.128 1.907 1.077 1.907 2.185V21L12 17.25 4.5 21V5.507c0-1.108.806-2.057 1.907-2.185a48.507 48.507 0 0 1 11.186 0Z" /></svg>
        </button>
        <button class="chip-action chip-close" data-action="close-single-tab" data-tab-url="${safeUrl}" title="Close this tab">
          <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2.5" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18 18 6M6 6l12 12" /></svg>
        </button>
      </div>
    </div>`;
  }).join('');

  return `
    <div class="page-chips-overflow" style="display:none">${hiddenChips}</div>
    <div class="page-chip page-chip-overflow clickable" data-action="expand-chips">
      <span class="chip-text">+${hiddenTabs.length} more</span>
    </div>`;
}


/* ----------------------------------------------------------------
   DOMAIN CARD RENDERER
   ---------------------------------------------------------------- */

/**
 * renderDomainCard(group, groupIndex)
 *
 * Builds the HTML for one domain group card.
 * group = { domain: string, tabs: [{ url, title, id, windowId, active }] }
 */
function renderDomainCard(group) {
  const tabs      = group.tabs || [];
  const tabCount  = tabs.length;
  const isLanding = group.domain === '__landing-pages__';
  const stableId  = 'domain-' + group.domain.replace(/[^a-z0-9]/g, '-');

  // Count duplicates (exact URL match)
  const urlCounts = {};
  for (const tab of tabs) urlCounts[tab.url] = (urlCounts[tab.url] || 0) + 1;
  const dupeUrls   = Object.entries(urlCounts).filter(([, c]) => c > 1);
  const hasDupes   = dupeUrls.length > 0;
  const totalExtras = dupeUrls.reduce((s, [, c]) => s + c - 1, 0);

  const tabBadge = `<span class="open-tabs-badge">
    ${ICONS.tabs}
    ${tabCount} tab${tabCount !== 1 ? 's' : ''} open
  </span>`;

  const dupeBadge = hasDupes
    ? `<span class="open-tabs-badge" style="color:var(--accent-amber);background:rgba(200,113,58,0.08);">
        ${totalExtras} duplicate${totalExtras !== 1 ? 's' : ''}
      </span>`
    : '';

  // Deduplicate for display: show each URL once, with (Nx) badge if duped
  const seen = new Set();
  const uniqueTabs = [];
  for (const tab of tabs) {
    if (!seen.has(tab.url)) { seen.add(tab.url); uniqueTabs.push(tab); }
  }

  const visibleTabs = uniqueTabs.slice(0, 8);
  const extraCount  = uniqueTabs.length - visibleTabs.length;

  const pageChips = visibleTabs.map(tab => {
    let label = cleanTitle(smartTitle(stripTitleNoise(tab.title || ''), tab.url), group.domain);
    // For localhost tabs, prepend port number so you can tell projects apart
    try {
      const parsed = new URL(tab.url);
      if (parsed.hostname === 'localhost' && parsed.port) label = `${parsed.port} ${label}`;
    } catch {}
    const count    = urlCounts[tab.url];
    const dupeTag  = count > 1 ? ` <span class="chip-dupe-badge">(${count}x)</span>` : '';
    const chipClass = count > 1 ? ' chip-has-dupes' : '';
    const safeUrl   = (tab.url || '').replace(/"/g, '&quot;');
    const safeTitle = label.replace(/"/g, '&quot;');
    let domain = '';
    try { domain = new URL(tab.url).hostname; } catch {}
    const faviconUrl = domain ? `https://www.google.com/s2/favicons?domain=${domain}&sz=16` : '';
    return `<div class="page-chip clickable${chipClass}" data-action="focus-tab" data-tab-url="${safeUrl}" title="${safeTitle}">
      ${faviconUrl ? `<img class="chip-favicon" src="${faviconUrl}" alt="" onerror="this.style.display='none'">` : ''}
      <span class="chip-text">${label}</span>${dupeTag}
      <div class="chip-actions">
        <button class="chip-action chip-save" data-action="defer-single-tab" data-tab-url="${safeUrl}" data-tab-title="${safeTitle}" title="Save for later">
          <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M17.593 3.322c1.1.128 1.907 1.077 1.907 2.185V21L12 17.25 4.5 21V5.507c0-1.108.806-2.057 1.907-2.185a48.507 48.507 0 0 1 11.186 0Z" /></svg>
        </button>
        <button class="chip-action chip-close" data-action="close-single-tab" data-tab-url="${safeUrl}" title="Close this tab">
          <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2.5" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18 18 6M6 6l12 12" /></svg>
        </button>
      </div>
    </div>`;
  }).join('') + (extraCount > 0 ? buildOverflowChips(uniqueTabs.slice(8), urlCounts) : '');

  let actionsHtml = `
    <button class="action-btn close-tabs" data-action="close-domain-tabs" data-domain-id="${stableId}">
      ${ICONS.close}
      Close all ${tabCount} tab${tabCount !== 1 ? 's' : ''}
    </button>`;

  if (hasDupes) {
    const dupeUrlsEncoded = dupeUrls.map(([url]) => encodeURIComponent(url)).join(',');
    actionsHtml += `
      <button class="action-btn" data-action="dedup-keep-one" data-dupe-urls="${dupeUrlsEncoded}">
        Close ${totalExtras} duplicate${totalExtras !== 1 ? 's' : ''}
      </button>`;
  }

  return `
    <div class="mission-card domain-card ${hasDupes ? 'has-amber-bar' : 'has-neutral-bar'}" data-domain-id="${stableId}">
      <div class="status-bar"></div>
      <div class="mission-content">
        <div class="mission-top">
          <span class="mission-name">${isLanding ? 'Homepages' : (group.label || friendlyDomain(group.domain))}</span>
          ${tabBadge}
          ${dupeBadge}
        </div>
        <div class="mission-pages">${pageChips}</div>
        <div class="actions">${actionsHtml}</div>
      </div>
      <div class="mission-meta">
        <div class="mission-page-count">${tabCount}</div>
        <div class="mission-page-label">tabs</div>
      </div>
    </div>`;
}


/* ----------------------------------------------------------------
   SAVED FOR LATER — Render Checklist Column
   ---------------------------------------------------------------- */

/**
 * renderDeferredColumn()
 *
 * Reads saved tabs from chrome.storage.local and renders the right-side
 * "Saved for Later" checklist column. Shows active items as a checklist
 * and completed items in a collapsible archive.
 */
async function renderDeferredColumn() {
  const column         = document.getElementById('deferredColumn');
  const list           = document.getElementById('deferredList');
  const empty          = document.getElementById('deferredEmpty');
  const countEl        = document.getElementById('deferredCount');
  const archiveEl      = document.getElementById('deferredArchive');
  const archiveCountEl = document.getElementById('archiveCount');
  const archiveList    = document.getElementById('archiveList');

  if (!column) return;

  try {
    const { active, archived } = await getSavedTabs();

    // Hide the entire column if there's nothing to show
    if (active.length === 0 && archived.length === 0) {
      column.style.display = 'none';
      return;
    }

    column.style.display = 'block';

    // Render active checklist items
    if (active.length > 0) {
      countEl.textContent = `${active.length} item${active.length !== 1 ? 's' : ''}`;
      list.innerHTML = active.map(item => renderDeferredItem(item)).join('');
      list.style.display = 'block';
      empty.style.display = 'none';
    } else {
      list.style.display = 'none';
      countEl.textContent = '';
      empty.style.display = 'block';
    }

    // Render archive section
    if (archived.length > 0) {
      archiveCountEl.textContent = `(${archived.length})`;
      archiveList.innerHTML = archived.map(item => renderArchiveItem(item)).join('');
      archiveEl.style.display = 'block';
    } else {
      archiveEl.style.display = 'none';
    }

  } catch (err) {
    console.warn('[tab-out] Could not load saved tabs:', err);
    column.style.display = 'none';
  }
}

/**
 * renderDeferredItem(item)
 *
 * Builds HTML for one active checklist item: checkbox, title link,
 * domain, time ago, dismiss button.
 */
function renderDeferredItem(item) {
  let domain = '';
  try { domain = new URL(item.url).hostname.replace(/^www\./, ''); } catch {}
  const faviconUrl = `https://www.google.com/s2/favicons?domain=${domain}&sz=16`;
  const ago = timeAgo(item.savedAt);

  return `
    <div class="deferred-item" data-deferred-id="${item.id}">
      <input type="checkbox" class="deferred-checkbox" data-action="check-deferred" data-deferred-id="${item.id}">
      <div class="deferred-info">
        <a href="${item.url}" target="_blank" rel="noopener" class="deferred-title" title="${(item.title || '').replace(/"/g, '&quot;')}">
          <img src="${faviconUrl}" alt="" style="width:14px;height:14px;vertical-align:-2px;margin-right:4px" onerror="this.style.display='none'">${item.title || item.url}
        </a>
        <div class="deferred-meta">
          <span>${domain}</span>
          <span>${ago}</span>
        </div>
      </div>
      <button class="deferred-dismiss" data-action="dismiss-deferred" data-deferred-id="${item.id}" title="Dismiss">
        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18 18 6M6 6l12 12" /></svg>
      </button>
    </div>`;
}

/**
 * renderArchiveItem(item)
 *
 * Builds HTML for one completed/archived item (simpler: just title + date).
 */
function renderArchiveItem(item) {
  const ago = item.completedAt ? timeAgo(item.completedAt) : timeAgo(item.savedAt);
  return `
    <div class="archive-item">
      <a href="${item.url}" target="_blank" rel="noopener" class="archive-item-title" title="${(item.title || '').replace(/"/g, '&quot;')}">
        ${item.title || item.url}
      </a>
      <span class="archive-item-date">${ago}</span>
    </div>`;
}


/* ----------------------------------------------------------------
   MAIN DASHBOARD RENDERER
   ---------------------------------------------------------------- */

/**
 * renderStaticDashboard()
 *
 * The main render function:
 * 1. Paints greeting + date
 * 2. Fetches open tabs via chrome.tabs.query()
 * 3. Groups tabs by domain (with landing pages pulled out to their own group)
 * 4. Renders domain cards
 * 5. Updates footer stats
 * 6. Renders the "Saved for Later" checklist
 */
async function renderStaticDashboard() {
  // --- Header ---
  const greetingEl = document.getElementById('greeting');
  const dateEl     = document.getElementById('dateDisplay');
  if (greetingEl) greetingEl.textContent = getGreeting();
  if (dateEl)     dateEl.textContent     = getDateDisplay();

  // --- Fetch tabs ---
  await fetchOpenTabs();
  const realTabs = getRealTabs();

  // --- Group tabs by domain ---
  // Landing pages (Gmail inbox, Twitter home, etc.) get their own special group
  // so they can be closed together without affecting content tabs on the same domain.
  const LANDING_PAGE_PATTERNS = [
    { hostname: 'mail.google.com', test: (p, h) =>
        !h.includes('#inbox/') && !h.includes('#sent/') && !h.includes('#search/') },
    { hostname: 'x.com',               pathExact: ['/home'] },
    { hostname: 'www.linkedin.com',    pathExact: ['/'] },
    { hostname: 'github.com',          pathExact: ['/'] },
    { hostname: 'www.youtube.com',     pathExact: ['/'] },
    // Merge personal patterns from config.local.js (if it exists)
    ...(typeof LOCAL_LANDING_PAGE_PATTERNS !== 'undefined' ? LOCAL_LANDING_PAGE_PATTERNS : []),
  ];

  function isLandingPage(url) {
    try {
      const parsed = new URL(url);
      return LANDING_PAGE_PATTERNS.some(p => {
        // Support both exact hostname and suffix matching (for wildcard subdomains)
        const hostnameMatch = p.hostname
          ? parsed.hostname === p.hostname
          : p.hostnameEndsWith
            ? parsed.hostname.endsWith(p.hostnameEndsWith)
            : false;
        if (!hostnameMatch) return false;
        if (p.test)       return p.test(parsed.pathname, url);
        if (p.pathPrefix) return parsed.pathname.startsWith(p.pathPrefix);
        if (p.pathExact)  return p.pathExact.includes(parsed.pathname);
        return parsed.pathname === '/';
      });
    } catch { return false; }
  }

  domainGroups = [];
  const groupMap    = {};
  const landingTabs = [];

  // Custom group rules from config.local.js (if any)
  const customGroups = typeof LOCAL_CUSTOM_GROUPS !== 'undefined' ? LOCAL_CUSTOM_GROUPS : [];

  // Check if a URL matches a custom group rule; returns the rule or null
  function matchCustomGroup(url) {
    try {
      const parsed = new URL(url);
      return customGroups.find(r => {
        const hostMatch = r.hostname
          ? parsed.hostname === r.hostname
          : r.hostnameEndsWith
            ? parsed.hostname.endsWith(r.hostnameEndsWith)
            : false;
        if (!hostMatch) return false;
        if (r.pathPrefix) return parsed.pathname.startsWith(r.pathPrefix);
        return true; // hostname matched, no path filter
      }) || null;
    } catch { return null; }
  }

  for (const tab of realTabs) {
    try {
      if (isLandingPage(tab.url)) {
        landingTabs.push(tab);
        continue;
      }

      // Check custom group rules first (e.g. merge subdomains, split by path)
      const customRule = matchCustomGroup(tab.url);
      if (customRule) {
        const key = customRule.groupKey;
        if (!groupMap[key]) groupMap[key] = { domain: key, label: customRule.groupLabel, tabs: [] };
        groupMap[key].tabs.push(tab);
        continue;
      }

      let hostname;
      if (tab.url && tab.url.startsWith('file://')) {
        hostname = 'local-files';
      } else {
        hostname = new URL(tab.url).hostname;
      }
      if (!hostname) continue;

      if (!groupMap[hostname]) groupMap[hostname] = { domain: hostname, tabs: [] };
      groupMap[hostname].tabs.push(tab);
    } catch {
      // Skip malformed URLs
    }
  }

  if (landingTabs.length > 0) {
    groupMap['__landing-pages__'] = { domain: '__landing-pages__', tabs: landingTabs };
  }

  // Sort: landing pages first, then domains from landing page sites, then by tab count
  // Collect exact hostnames and suffix patterns for priority sorting
  const landingHostnames = new Set(LANDING_PAGE_PATTERNS.map(p => p.hostname).filter(Boolean));
  const landingSuffixes = LANDING_PAGE_PATTERNS.map(p => p.hostnameEndsWith).filter(Boolean);
  function isLandingDomain(domain) {
    if (landingHostnames.has(domain)) return true;
    return landingSuffixes.some(s => domain.endsWith(s));
  }
  domainGroups = Object.values(groupMap).sort((a, b) => {
    const aIsLanding = a.domain === '__landing-pages__';
    const bIsLanding = b.domain === '__landing-pages__';
    if (aIsLanding !== bIsLanding) return aIsLanding ? -1 : 1;

    const aIsPriority = isLandingDomain(a.domain);
    const bIsPriority = isLandingDomain(b.domain);
    if (aIsPriority !== bIsPriority) return aIsPriority ? -1 : 1;

    return b.tabs.length - a.tabs.length;
  });

  // --- Render domain cards ---
  const openTabsSection      = document.getElementById('openTabsSection');
  const openTabsMissionsEl   = document.getElementById('openTabsMissions');
  const openTabsSectionCount = document.getElementById('openTabsSectionCount');
  const openTabsSectionTitle = document.getElementById('openTabsSectionTitle');

  if (domainGroups.length > 0 && openTabsSection) {
    if (openTabsSectionTitle) openTabsSectionTitle.textContent = 'Open tabs';
    openTabsSectionCount.innerHTML = `${domainGroups.length} domain${domainGroups.length !== 1 ? 's' : ''} &nbsp;&middot;&nbsp; <button class="action-btn close-tabs" data-action="close-all-open-tabs" style="font-size:11px;padding:3px 10px;">${ICONS.close} Close all ${realTabs.length} tabs</button>`;
    openTabsMissionsEl.innerHTML = domainGroups.map(g => renderDomainCard(g)).join('');
    openTabsSection.style.display = 'block';
  } else if (openTabsSection) {
    openTabsSection.style.display = 'none';
  }

  // --- Footer stats ---
  const statTabs = document.getElementById('statTabs');
  if (statTabs) statTabs.textContent = openTabs.length;

  // --- Check for duplicate Tab Out tabs ---
  checkTabOutDupes();

  // --- Render "Saved for Later" column ---
  await renderDeferredColumn();
}

async function renderDashboard() {
  await renderStaticDashboard();
}


/* ----------------------------------------------------------------
   EVENT HANDLERS — using event delegation

   One listener on document handles ALL button clicks.
   Think of it as one security guard watching the whole building
   instead of one per door.
   ---------------------------------------------------------------- */

document.addEventListener('click', async (e) => {
  // Walk up the DOM to find the nearest element with data-action
  const actionEl = e.target.closest('[data-action]');
  if (!actionEl) return;

  const action = actionEl.dataset.action;

  // ---- Close duplicate Tab Out tabs ----
  if (action === 'close-tabout-dupes') {
    await closeTabOutDupes();
    playCloseSound();
    const banner = document.getElementById('tabOutDupeBanner');
    if (banner) {
      banner.style.transition = 'opacity 0.4s';
      banner.style.opacity = '0';
      setTimeout(() => { banner.style.display = 'none'; banner.style.opacity = '1'; }, 400);
    }
    showToast('Closed extra Tab Out tabs');
    return;
  }

  const card = actionEl.closest('.mission-card');

  // ---- Expand overflow chips ("+N more") ----
  if (action === 'expand-chips') {
    const overflowContainer = actionEl.parentElement.querySelector('.page-chips-overflow');
    if (overflowContainer) {
      overflowContainer.style.display = 'contents';
      actionEl.remove();
    }
    return;
  }

  // ---- Focus a specific tab ----
  if (action === 'focus-tab') {
    const tabUrl = actionEl.dataset.tabUrl;
    if (tabUrl) await focusTab(tabUrl);
    return;
  }

  // ---- Close a single tab ----
  if (action === 'close-single-tab') {
    e.stopPropagation(); // don't trigger parent chip's focus-tab
    const tabUrl = actionEl.dataset.tabUrl;
    if (!tabUrl) return;

    // Close the tab in Chrome directly
    const allTabs = await chrome.tabs.query({});
    const match   = allTabs.find(t => t.url === tabUrl);
    if (match) await chrome.tabs.remove(match.id);
    await fetchOpenTabs();

    playCloseSound();

    // Animate the chip row out
    const chip = actionEl.closest('.page-chip');
    if (chip) {
      const rect = chip.getBoundingClientRect();
      shootConfetti(rect.left + rect.width / 2, rect.top + rect.height / 2);
      chip.style.transition = 'opacity 0.2s, transform 0.2s';
      chip.style.opacity    = '0';
      chip.style.transform  = 'scale(0.8)';
      setTimeout(() => {
        chip.remove();
        // If the card now has no tabs, remove it too
        const parentCard = document.querySelector('.mission-card:has(.mission-pages:empty)');
        if (parentCard) animateCardOut(parentCard);
        document.querySelectorAll('.mission-card').forEach(c => {
          if (c.querySelectorAll('.page-chip[data-action="focus-tab"]').length === 0) {
            animateCardOut(c);
          }
        });
      }, 200);
    }

    // Update footer
    const statTabs = document.getElementById('statTabs');
    if (statTabs) statTabs.textContent = openTabs.length;

    showToast('Tab closed');
    return;
  }

  // ---- Save a single tab for later (then close it) ----
  if (action === 'defer-single-tab') {
    e.stopPropagation();
    const tabUrl   = actionEl.dataset.tabUrl;
    const tabTitle = actionEl.dataset.tabTitle || tabUrl;
    if (!tabUrl) return;

    // Save to chrome.storage.local
    try {
      await saveTabForLater({ url: tabUrl, title: tabTitle });
    } catch (err) {
      console.error('[tab-out] Failed to save tab:', err);
      showToast('Failed to save tab');
      return;
    }

    // Close the tab in Chrome
    const allTabs = await chrome.tabs.query({});
    const match   = allTabs.find(t => t.url === tabUrl);
    if (match) await chrome.tabs.remove(match.id);
    await fetchOpenTabs();

    // Animate chip out
    const chip = actionEl.closest('.page-chip');
    if (chip) {
      chip.style.transition = 'opacity 0.2s, transform 0.2s';
      chip.style.opacity    = '0';
      chip.style.transform  = 'scale(0.8)';
      setTimeout(() => chip.remove(), 200);
    }

    showToast('Saved for later');
    await renderDeferredColumn();
    return;
  }

  // ---- Check off a saved tab (moves it to archive) ----
  if (action === 'check-deferred') {
    const id = actionEl.dataset.deferredId;
    if (!id) return;

    await checkOffSavedTab(id);

    // Animate: strikethrough first, then slide out
    const item = actionEl.closest('.deferred-item');
    if (item) {
      item.classList.add('checked');
      setTimeout(() => {
        item.classList.add('removing');
        setTimeout(() => {
          item.remove();
          renderDeferredColumn(); // refresh counts and archive
        }, 300);
      }, 800);
    }
    return;
  }

  // ---- Dismiss a saved tab (removes it entirely) ----
  if (action === 'dismiss-deferred') {
    const id = actionEl.dataset.deferredId;
    if (!id) return;

    await dismissSavedTab(id);

    const item = actionEl.closest('.deferred-item');
    if (item) {
      item.classList.add('removing');
      setTimeout(() => {
        item.remove();
        renderDeferredColumn();
      }, 300);
    }
    return;
  }

  // ---- Close all tabs in a domain group ----
  if (action === 'close-domain-tabs') {
    const domainId = actionEl.dataset.domainId;
    const group    = domainGroups.find(g => {
      return 'domain-' + g.domain.replace(/[^a-z0-9]/g, '-') === domainId;
    });
    if (!group) return;

    const urls      = group.tabs.map(t => t.url);
    // Landing pages and custom groups (whose domain key isn't a real hostname)
    // must use exact URL matching to avoid closing unrelated tabs
    const useExact  = group.domain === '__landing-pages__' || !!group.label;

    if (useExact) {
      await closeTabsExact(urls);
    } else {
      await closeTabsByUrls(urls);
    }

    if (card) {
      playCloseSound();
      animateCardOut(card);
    }

    // Remove from in-memory groups
    const idx = domainGroups.indexOf(group);
    if (idx !== -1) domainGroups.splice(idx, 1);

    const groupLabel = group.domain === '__landing-pages__' ? 'Homepages' : (group.label || friendlyDomain(group.domain));
    showToast(`Closed ${urls.length} tab${urls.length !== 1 ? 's' : ''} from ${groupLabel}`);

    const statTabs = document.getElementById('statTabs');
    if (statTabs) statTabs.textContent = openTabs.length;
    return;
  }

  // ---- Close duplicates, keep one copy ----
  if (action === 'dedup-keep-one') {
    const urlsEncoded = actionEl.dataset.dupeUrls || '';
    const urls = urlsEncoded.split(',').map(u => decodeURIComponent(u)).filter(Boolean);
    if (urls.length === 0) return;

    await closeDuplicateTabs(urls, true);
    playCloseSound();

    // Hide the dedup button
    actionEl.style.transition = 'opacity 0.2s';
    actionEl.style.opacity    = '0';
    setTimeout(() => actionEl.remove(), 200);

    // Remove dupe badges from the card
    if (card) {
      card.querySelectorAll('.chip-dupe-badge').forEach(b => {
        b.style.transition = 'opacity 0.2s';
        b.style.opacity    = '0';
        setTimeout(() => b.remove(), 200);
      });
      card.querySelectorAll('.open-tabs-badge').forEach(badge => {
        if (badge.textContent.includes('duplicate')) {
          badge.style.transition = 'opacity 0.2s';
          badge.style.opacity    = '0';
          setTimeout(() => badge.remove(), 200);
        }
      });
      card.classList.remove('has-amber-bar');
      card.classList.add('has-neutral-bar');
    }

    showToast('Closed duplicates, kept one copy each');
    return;
  }

  // ---- Close ALL open tabs ----
  if (action === 'close-all-open-tabs') {
    const allUrls = openTabs
      .filter(t => t.url && !t.url.startsWith('chrome') && !t.url.startsWith('about:'))
      .map(t => t.url);
    await closeTabsByUrls(allUrls);
    playCloseSound();

    document.querySelectorAll('#openTabsMissions .mission-card').forEach(c => {
      shootConfetti(
        c.getBoundingClientRect().left + c.offsetWidth / 2,
        c.getBoundingClientRect().top  + c.offsetHeight / 2
      );
      animateCardOut(c);
    });

    showToast('All tabs closed. Fresh start.');
    return;
  }
});

// ---- Archive toggle — expand/collapse the archive section ----
document.addEventListener('click', (e) => {
  const toggle = e.target.closest('#archiveToggle');
  if (!toggle) return;

  toggle.classList.toggle('open');
  const body = document.getElementById('archiveBody');
  if (body) {
    body.style.display = body.style.display === 'none' ? 'block' : 'none';
  }
});

// ---- Archive search — filter archived items as user types ----
document.addEventListener('input', async (e) => {
  if (e.target.id !== 'archiveSearch') return;

  const q = e.target.value.trim().toLowerCase();
  const archiveList = document.getElementById('archiveList');
  if (!archiveList) return;

  try {
    const { archived } = await getSavedTabs();

    if (q.length < 2) {
      // Show all archived items
      archiveList.innerHTML = archived.map(item => renderArchiveItem(item)).join('');
      return;
    }

    // Filter by title or URL containing the query string
    const results = archived.filter(item =>
      (item.title || '').toLowerCase().includes(q) ||
      (item.url  || '').toLowerCase().includes(q)
    );

    archiveList.innerHTML = results.map(item => renderArchiveItem(item)).join('')
      || '<div style="font-size:12px;color:var(--muted);padding:8px 0">No results</div>';
  } catch (err) {
    console.warn('[tab-out] Archive search failed:', err);
  }
});


/* ----------------------------------------------------------------
   SHARED HELPERS
   ---------------------------------------------------------------- */
function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}


/* ================================================================
   整理收藏夹 — Chrome Bookmarks Organizer

   Reads chrome.bookmarks tree, flags duplicates / dead / stale
   items, and lets the user delete or move bookmarks. All mutations
   go through chrome.bookmarks.* — no separate storage layer.
   ================================================================ */

const BM_STALE_MS = 365 * 24 * 3600 * 1000;         // 1 year — older than this gets darker visual treatment
const BM_DEAD_TIMEOUT_MS = 6000;
const BM_DEAD_CONCURRENCY = 6;

let bmFlat = [];                  // [{id,title,url,parentId,folderPath,dateAdded,normUrl}]
let bmFolders = [];               // [{id,title,path}] — for filter + move menu
let bmFolderMeta = new Map();     // id -> {id,title,path,parentId,bookmarkCount,childFolderIds}
let bmDupGroups = new Map();      // normUrl -> [bmId, ...]
let bmDeadIds = new Set();        // ids that failed reachability check
let bmLoaded = false;
let bmFilter = 'all';
let bmSort = 'folder';
let bmFolderFilterId = '';
let bmSelected = new Set();
let bmCollapsedGroups = new Set();

function normalizeBmUrl(url) {
  try {
    const u = new URL(url);
    if (!/^https?:$/.test(u.protocol)) return url.toLowerCase();
    let host = u.hostname.toLowerCase().replace(/^www\./, '');
    let path = u.pathname.replace(/\/+$/, '') || '/';
    const cleanedParams = [];
    for (const [k, v] of u.searchParams) {
      if (/^utm_/i.test(k) || k === 'fbclid' || k === 'gclid' || k === 'ref' || k === 'ref_src') continue;
      cleanedParams.push([k, v]);
    }
    cleanedParams.sort((a, b) => a[0].localeCompare(b[0]));
    const qs = cleanedParams.map(([k, v]) => `${k}=${v}`).join('&');
    return `${host}${path}${qs ? '?' + qs : ''}`;
  } catch {
    return String(url || '').toLowerCase();
  }
}

function flattenBookmarkTree(tree) {
  const flat = [];
  const folders = [];
  const folderMeta = new Map();
  function walk(node, pathParts) {
    if (!node) return 0;
    if (node.url) {
      const norm = normalizeBmUrl(node.url);
      flat.push({
        id:         node.id,
        title:      node.title || '',
        url:        node.url,
        parentId:   node.parentId,
        folderPath: pathParts.join(' / '),
        dateAdded:  node.dateAdded || 0,
        normUrl:    norm,
      });
      return 1;
    }
    // Skip the synthetic root node (no parentId)
    const isRoot = !node.parentId;
    const nextPath = isRoot ? pathParts : [...pathParts, node.title || '(未命名)'];
    let bookmarkCount = 0;
    const childFolderIds = [];
    for (const child of (node.children || [])) {
      bookmarkCount += walk(child, nextPath);
      if (!child.url) childFolderIds.push(child.id);
    }
    if (!isRoot && node.id) {
      const folderObj = {
        id: node.id,
        title: node.title || '(未命名)',
        path: nextPath.join(' / '),
        parentId: node.parentId,
        bookmarkCount,
        childFolderIds,
      };
      folders.push({ id: folderObj.id, title: folderObj.title, path: folderObj.path });
      folderMeta.set(node.id, folderObj);
    }
    return bookmarkCount;
  }
  (tree || []).forEach(root => walk(root, []));
  return { flat, folders, folderMeta };
}

// Chrome's top-level system folders (Bookmarks bar / Other / Mobile) sit
// directly under the synthetic root and shouldn't be deletable.
function isSystemRootFolder(meta) {
  return !meta?.parentId || meta.parentId === '0';
}

function getEmptyFolders() {
  return [...bmFolderMeta.values()]
    .filter(f => f.bookmarkCount === 0 && !isSystemRootFolder(f));
}

// Topmost empty folders only — if A is empty and contains empty B,
// removing A removes B too, so we only delete A.
function getTopmostEmptyFolders() {
  const empty = getEmptyFolders();
  const emptyIds = new Set(empty.map(f => f.id));
  return empty.filter(f => !emptyIds.has(f.parentId));
}

function findDuplicateGroups(items) {
  const map = new Map();
  for (const b of items) {
    if (!b.url || !/^https?:/i.test(b.url)) continue;
    if (!map.has(b.normUrl)) map.set(b.normUrl, []);
    map.get(b.normUrl).push(b.id);
  }
  return new Map([...map].filter(([, v]) => v.length > 1));
}

// Age tier: 'fresh' | 'tier-1y' (1-2y) | 'tier-2y' (2-3y) | 'tier-3y' (3y+)
const BM_YEAR_MS = 365 * 86400000;
function bmAgeTier(b) {
  if (!b.dateAdded) return 'fresh';
  const age = Date.now() - b.dateAdded;
  if (age < BM_YEAR_MS) return 'fresh';
  if (age < 2 * BM_YEAR_MS) return 'tier-1y';
  if (age < 3 * BM_YEAR_MS) return 'tier-2y';
  return 'tier-3y';
}
function bmIsStale(b)      { return bmAgeTier(b) !== 'fresh'; }
function bmIsDuplicate(b)  { return bmDupGroups.has(b.normUrl); }
function bmIsDead(b)       { return bmDeadIds.has(b.id); }

// Domain-category dictionary — drives the colored category pill on each card.
// Match against eTLD+1 host with leading "www." stripped. Order matters
// only for ambiguous overlaps (none currently).
const BM_CATEGORIES = [
  { label: '视频', cls: 'cat-video', hosts: [
    'bilibili.com','b23.tv','biligame.com','youtube.com','youtu.be','vimeo.com',
    'douyin.com','ixigua.com','iqiyi.com','v.qq.com','tv.cctv.com','xiaoyuzhoufm.com',
  ]},
  { label: '代码', cls: 'cat-code', hosts: [
    'github.com','gitlab.com','gitee.com','stackoverflow.com','stackexchange.com',
    'npmjs.com','crates.io','pypi.org','developer.mozilla.org','mdn.dev',
    'codepen.io','codesandbox.io','replit.com','jsfiddle.net','dev.to',
  ]},
  { label: 'AI', cls: 'cat-ai', hosts: [
    'openai.com','anthropic.com','claude.ai','chatgpt.com','huggingface.co',
    'replicate.com','midjourney.com','civitai.com','runwayml.com','perplexity.ai',
  ]},
  { label: '资讯', cls: 'cat-news', hosts: [
    'zhihu.com','twitter.com','x.com','weibo.com','reddit.com','news.ycombinator.com',
    '36kr.com','huxiu.com','sspai.com','jiqizhixin.com','medium.com','substack.com',
  ]},
  { label: '设计', cls: 'cat-design', hosts: [
    'figma.com','dribbble.com','behance.net','pinterest.com','miro.com',
    'excalidraw.com','canva.com','sketch.com',
  ]},
  { label: '学习', cls: 'cat-learn', hosts: [
    'coursera.org','udemy.com','edx.org','leetcode.com','leetcode.cn','khanacademy.org',
    'mooc.org','school365.com','imooc.com',
  ]},
  { label: '购物', cls: 'cat-shop', hosts: [
    'taobao.com','tmall.com','jd.com','pinduoduo.com','amazon.com','amazon.cn',
    'smzdm.com','xianyu.taobao.com','dewu.com',
  ]},
  { label: '协作', cls: 'cat-tool', hosts: [
    'notion.so','notion.com','airtable.com','asana.com','trello.com','slack.com',
    'linear.app','feishu.cn','larksuite.com','dingtalk.com',
  ]},
];

function bmCategoryFor(url) {
  try {
    const host = new URL(url).hostname.toLowerCase().replace(/^www\./, '');
    for (const cat of BM_CATEGORIES) {
      if (cat.hosts.some(h => host === h || host.endsWith('.' + h))) return cat;
    }
    return null;
  } catch { return null; }
}

// Age tiers — used for visual emphasis. > 1 year = "老" (darker card).
const BM_ONE_YEAR = 365 * 86400000;
function bmAgeYears(b) {
  if (!b.dateAdded) return 0;
  return (Date.now() - b.dateAdded) / BM_ONE_YEAR;
}

function applyBmFilter(items) {
  let out = items;
  if (bmFolderFilterId) {
    out = out.filter(b => b.parentId === bmFolderFilterId);
  }
  switch (bmFilter) {
    case 'duplicates': out = out.filter(bmIsDuplicate); break;
    case 'dead':       out = out.filter(bmIsDead); break;
    case 'age-1y':     out = out.filter(b => { const t = bmAgeTier(b); return t === 'tier-1y' || t === 'tier-2y' || t === 'tier-3y'; }); break;
    case 'age-2y':     out = out.filter(b => { const t = bmAgeTier(b); return t === 'tier-2y' || t === 'tier-3y'; }); break;
    case 'age-3y':     out = out.filter(b => bmAgeTier(b) === 'tier-3y'); break;
  }
  return out;
}

function applyBmSort(items) {
  const arr = items.slice();
  switch (bmSort) {
    case 'date-desc':
      arr.sort((a, b) => b.dateAdded - a.dateAdded); break;
    case 'date-asc':
      arr.sort((a, b) => a.dateAdded - b.dateAdded); break;
    case 'domain':
      arr.sort((a, b) => {
        const da = (() => { try { return new URL(a.url).hostname.replace(/^www\./, ''); } catch { return ''; } })();
        const db = (() => { try { return new URL(b.url).hostname.replace(/^www\./, ''); } catch { return ''; } })();
        return da.localeCompare(db) || (b.dateAdded - a.dateAdded);
      });
      break;
    case 'folder':
    default:
      arr.sort((a, b) => a.folderPath.localeCompare(b.folderPath) || (b.dateAdded - a.dateAdded));
      break;
  }
  return arr;
}

function bmFaviconUrl(url) {
  try {
    const u = new URL(url);
    return `https://www.google.com/s2/favicons?domain=${u.hostname}&sz=32`;
  } catch { return ''; }
}

function bmDomain(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; }
}

function renderBmRow(b) {
  const dup   = bmIsDuplicate(b);
  const dead  = bmIsDead(b);
  const tier  = bmAgeTier(b);                  // 'fresh' | 'tier-1y' | 'tier-2y' | 'tier-3y'
  const ageYears = bmAgeYears(b);
  const cat = bmCategoryFor(b.url);

  const tags = [];
  if (cat)   tags.push(`<span class="bm-tag bm-cat ${cat.cls}">${escapeHtml(cat.label)}</span>`);
  if (dup)   tags.push('<span class="bm-tag is-dup">重复</span>');
  if (dead)  tags.push('<span class="bm-tag is-dead">失效</span>');
  if (tier !== 'fresh') {
    const tierLabel = tier === 'tier-3y' ? '3 年+' : tier === 'tier-2y' ? '2 年+' : '1 年+';
    tags.push(`<span class="bm-tag age-${tier}">${tierLabel}</span>`);
  }

  const folderOpts = bmFolders
    .filter(f => f.id !== b.parentId)
    .map(f => `<option value="${escapeHtml(f.id)}">${escapeHtml(f.path)}</option>`)
    .join('');
  const checked = bmSelected.has(b.id) ? 'checked' : '';
  const cls = ['bm-row'];
  if (dup) cls.push('is-dup');
  if (dead) cls.push('is-dead');
  if (tier !== 'fresh') cls.push(tier);
  // Cards are draggable only when grouped by folder (drop target = a folder)
  const draggable = bmSort === 'folder' ? 'draggable="true"' : '';
  return `
    <div class="${cls.join(' ')}" data-bm-id="${escapeHtml(b.id)}" ${draggable}>
      <input type="checkbox" class="bm-check" data-bm-action="select" ${checked}>
      <button class="bm-delete" data-bm-action="delete" title="删除">×</button>
      <a class="bm-title-link" href="${escapeHtml(b.url)}" target="_blank" rel="noopener" draggable="false" title="${escapeHtml(b.title || b.url)}">
        <img class="bm-favicon" src="${escapeHtml(bmFaviconUrl(b.url))}" alt="" loading="lazy" draggable="false">
        <span class="bm-title">${escapeHtml(b.title || b.url)}</span>
      </a>
      <div class="bm-meta">
        <span class="bm-url">${escapeHtml(bmDomain(b.url) || b.url)}</span>
        <span class="bm-folder">${escapeHtml(b.folderPath || '(顶层)')}</span>
        ${tags.join('')}
      </div>
      <div class="bm-actions">
        <select class="bm-move-select" data-bm-action="move" title="移动到文件夹">
          <option value="">移动到…</option>
          ${folderOpts}
        </select>
      </div>
    </div>
  `;
}

function renderEmptyFolderCard(f) {
  const childEmpty = (f.childFolderIds || []).filter(id => {
    const m = bmFolderMeta.get(id);
    return m && m.bookmarkCount === 0;
  }).length;
  const detail = childEmpty > 0
    ? `空文件夹 · 含 ${childEmpty} 个空子文件夹`
    : '空文件夹';
  return `
    <div class="bm-folder-card" data-folder-id="${escapeHtml(f.id)}">
      <button class="bm-delete" data-bm-action="delete-folder" title="删除该空文件夹">×</button>
      <div class="bm-folder-icon">📁</div>
      <div class="bm-folder-name">${escapeHtml(f.title)}</div>
      <div class="bm-folder-path">${escapeHtml(f.path)}</div>
      <div class="bm-folder-detail">${escapeHtml(detail)}</div>
    </div>
  `;
}

function updateBmCounters() {
  const dupCount = [...bmDupGroups.values()].reduce((s, ids) => s + ids.length, 0);
  let age1y = 0, age2y = 0, age3y = 0;
  for (const b of bmFlat) {
    const t = bmAgeTier(b);
    if (t === 'tier-3y') { age3y++; age2y++; age1y++; }
    else if (t === 'tier-2y') { age2y++; age1y++; }
    else if (t === 'tier-1y') { age1y++; }
  }
  const emptyCount = getEmptyFolders().length;
  const all = bmFlat.length;
  const dead = bmDeadIds.size;
  const set = (id, n) => { const el = document.getElementById(id); if (el) el.textContent = n ? n : ''; };
  set('bmAllCount', all);
  set('bmDupCount', dupCount);
  set('bmDeadCount', dead);
  set('bmAge1yCount', age1y);
  set('bmAge2yCount', age2y);
  set('bmAge3yCount', age3y);
  set('bmEmptyCount', emptyCount);
  const total = document.getElementById('bmCount');
  if (total) total.textContent = all ? `${all} 条` : '';
  const dedupeBtn = document.getElementById('bmDedupeBtn');
  if (dedupeBtn) dedupeBtn.style.display = bmFilter === 'duplicates' && bmDupGroups.size > 0 ? '' : 'none';
  const clearEmptyBtn = document.getElementById('bmClearEmptyBtn');
  if (clearEmptyBtn) clearEmptyBtn.style.display = bmFilter === 'empty-folders' && emptyCount > 0 ? '' : 'none';
}

// Stable, URL-safe anchor id from a folder path
function bmAnchorIdFor(path) {
  return 'bm-g-' + Array.from(path).reduce((h, ch) => ((h << 5) - h + ch.charCodeAt(0)) | 0, 0).toString(36).replace('-', 'n');
}

function renderBmFolderNav(groupOrder) {
  const nav = document.getElementById('bmFolderNav');
  if (!nav) return;
  if (!groupOrder || !groupOrder.length) {
    nav.style.display = 'none';
    nav.innerHTML = '';
    return;
  }
  nav.style.display = 'flex';
  nav.innerHTML = groupOrder.map(([path, items]) => {
    const id = bmAnchorIdFor(path);
    // Pills are drop targets only when grouped by folder
    const parentId = bmSort === 'folder' ? (items[0]?.parentId || '') : '';
    return `<a class="bm-folder-pill" href="#${id}" data-anchor="${id}" data-parent-id="${escapeHtml(parentId)}" title="${escapeHtml(path)}">
      <span class="bm-folder-pill-name">${escapeHtml(path.split(' / ').pop())}</span>
      <span class="bm-folder-pill-count">${items.length}</span>
    </a>`;
  }).join('');
}

let bmGroupObserver = null;
function observeBmGroups() {
  if (bmGroupObserver) bmGroupObserver.disconnect();
  const groups = document.querySelectorAll('.bm-group[id]');
  if (!groups.length) return;
  bmGroupObserver = new IntersectionObserver((entries) => {
    // Pick the topmost intersecting group as "active"
    const visible = entries
      .filter(e => e.isIntersecting)
      .map(e => ({ id: e.target.id, top: e.target.getBoundingClientRect().top }))
      .sort((a, b) => a.top - b.top);
    if (!visible.length) return;
    const activeId = visible[0].id;
    document.querySelectorAll('.bm-folder-pill').forEach(p => {
      p.classList.toggle('is-active', p.dataset.anchor === activeId);
    });
  }, { rootMargin: '-90px 0px -65% 0px', threshold: 0 });
  groups.forEach(g => bmGroupObserver.observe(g));
}

function renderBmList() {
  const list = document.getElementById('bmList');
  const status = document.getElementById('bmStatus');
  if (!list) return;

  // Special mode: show empty folders, not bookmarks
  if (bmFilter === 'empty-folders') {
    const empties = getEmptyFolders();
    list.classList.add('is-folder-mode');
    list.classList.remove('is-grouped');
    renderBmFolderNav(null);
    if (!empties.length) {
      list.innerHTML = '<div class="bm-empty">没有空文件夹，干净。</div>';
    } else {
      empties.sort((a, b) => (b.path.split('/').length) - (a.path.split('/').length));
      list.innerHTML = empties.map(renderEmptyFolderCard).join('');
    }
    if (status) status.textContent = '';
    updateBmCounters();
    updateBmSelectionUI();
    return;
  }
  list.classList.remove('is-folder-mode');

  const visible = applyBmSort(applyBmFilter(bmFlat));
  const isGrouped = bmSort === 'folder' || bmSort === 'domain';
  if (!visible.length) {
    const empty = bmFlat.length === 0 ? '没有读取到任何书签。' : '当前过滤条件下没有书签。';
    list.innerHTML = `<div class="bm-empty">${empty}</div>`;
    list.classList.remove('is-grouped');
    renderBmFolderNav(null);
  } else if (isGrouped) {
    list.classList.add('is-grouped');
    // Pick grouping key based on sort
    const keyFn = bmSort === 'folder'
      ? b => b.folderPath || '(顶层)'
      : b => bmDomain(b.url) || '(无域名)';
    const groups = new Map();
    for (const b of visible) {
      const key = keyFn(b);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(b);
    }
    // Order groups by count desc (largest folder/domain first) for both modes
    const groupOrder = [...groups].sort((a, b) => b[1].length - a[1].length);
    list.innerHTML = groupOrder.map(([key, items]) => {
      const collapsed = bmCollapsedGroups.has(key) ? ' is-collapsed' : '';
      const allChecked = items.every(b => bmSelected.has(b.id));
      const someChecked = !allChecked && items.some(b => bmSelected.has(b.id));
      const id = bmAnchorIdFor(key);
      // For folder-grouping, parentId comes from any item (they all share it).
      // For domain-grouping, no parent (drop disabled — different folders may share a domain).
      const parentId = bmSort === 'folder' ? (items[0]?.parentId || '') : '';
      return `
        <div class="bm-group${collapsed}" data-group-key="${escapeHtml(key)}" data-parent-id="${escapeHtml(parentId)}" id="${id}">
          <div class="bm-group-header">
            <input type="checkbox" class="bm-group-check" data-bm-action="select-group"
                   ${allChecked ? 'checked' : ''}
                   ${someChecked ? 'data-indeterminate="1"' : ''}>
            <span class="bm-group-chevron">▼</span>
            <span class="bm-group-title">${escapeHtml(key)}</span>
            <span class="bm-group-count">${items.length}</span>
          </div>
          <div class="bm-group-body">
            ${items.map(renderBmRow).join('')}
          </div>
        </div>
      `;
    }).join('');
    list.querySelectorAll('.bm-group-check[data-indeterminate]').forEach(cb => { cb.indeterminate = true; });
    renderBmFolderNav(groupOrder);
    requestAnimationFrame(observeBmGroups);
  } else {
    list.classList.remove('is-grouped');
    list.innerHTML = visible.map(renderBmRow).join('');
    renderBmFolderNav(null);
  }
  if (status) status.textContent = '';
  updateBmCounters();
  updateBmSelectionUI();
}

function updateBmSelectionUI() {
  const bar = document.getElementById('bmSelectionBar');
  const count = document.getElementById('bmSelCount');
  if (!bar) return;
  const n = bmSelected.size;
  bar.style.display = n > 0 ? '' : 'none';
  if (count) count.textContent = `已选 ${n} 项`;
  // Refresh bulk-move dropdown options (folders may have changed)
  const sel = document.getElementById('bmBulkMoveSelect');
  if (sel && n > 0) {
    sel.innerHTML = '<option value="">批量移动到…</option>' +
      bmFolders.map(f => `<option value="${escapeHtml(f.id)}">${escapeHtml(f.path)}</option>`).join('');
  }
}

function populateBmFolderFilter() {
  const sel = document.getElementById('bmFolderFilter');
  if (!sel) return;
  const opts = ['<option value="">全部文件夹</option>']
    .concat(bmFolders.map(f => `<option value="${escapeHtml(f.id)}">${escapeHtml(f.path)}</option>`));
  sel.innerHTML = opts.join('');
  sel.value = bmFolderFilterId;
}

async function loadBookmarks() {
  const status = document.getElementById('bmStatus');
  const list   = document.getElementById('bmList');
  if (!list) return;
  if (status) status.textContent = '正在读取书签…';
  list.innerHTML = '';

  try {
    if (!chrome.bookmarks) throw new Error('chrome.bookmarks API 不可用，请确认扩展已加 bookmarks 权限并重新加载。');
    const tree = await chrome.bookmarks.getTree();
    const { flat, folders, folderMeta } = flattenBookmarkTree(tree);
    bmFlat = flat;
    bmFolders = folders;
    bmFolderMeta = folderMeta;
    bmDupGroups = findDuplicateGroups(bmFlat);
    bmDeadIds = new Set();
    populateBmFolderFilter();
    renderBmList();
    bmLoaded = true;
    detectDeadLinksInBackground();
  } catch (err) {
    if (status) status.innerHTML = `<div class="bm-error">读取失败: ${escapeHtml(err.message || String(err))}</div>`;
    console.warn('[tab-out] bookmarks load failed', err);
  }
}

async function checkLinkAlive(url) {
  // Best-effort reachability — Chrome blocks reading status under no-cors,
  // so we treat "fetch resolves" as alive and "fetch throws" as dead.
  // DNS failures, total connection refusals, and timeouts all throw.
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), BM_DEAD_TIMEOUT_MS);
  try {
    await fetch(url, { method: 'HEAD', mode: 'no-cors', redirect: 'follow', signal: ctrl.signal, cache: 'no-store' });
    return true;
  } catch {
    try {
      await fetch(url, { method: 'GET', mode: 'no-cors', redirect: 'follow', signal: ctrl.signal, cache: 'no-store' });
      return true;
    } catch {
      return false;
    }
  } finally {
    clearTimeout(t);
  }
}

let bmDeadDetectionToken = 0;
async function detectDeadLinksInBackground() {
  const myToken = ++bmDeadDetectionToken;
  const targets = bmFlat.filter(b => /^https?:/i.test(b.url));
  let cursor = 0;
  let anyChanged = false;

  async function worker() {
    while (cursor < targets.length) {
      if (myToken !== bmDeadDetectionToken) return;
      const b = targets[cursor++];
      const alive = await checkLinkAlive(b.url);
      if (myToken !== bmDeadDetectionToken) return;
      if (!alive) {
        bmDeadIds.add(b.id);
        anyChanged = true;
        // Annotate the row in place if it's currently rendered
        const row = document.querySelector(`.bm-row[data-bm-id="${CSS.escape(b.id)}"]`);
        if (row && !row.classList.contains('is-dead')) {
          row.classList.add('is-dead');
          const meta = row.querySelector('.bm-meta');
          if (meta && !meta.querySelector('.bm-tag.is-dead')) {
            meta.insertAdjacentHTML('beforeend', '<span class="bm-tag is-dead">失效</span>');
          }
        }
      }
    }
  }

  const workers = Array.from({ length: BM_DEAD_CONCURRENCY }, worker);
  await Promise.all(workers);
  if (myToken === bmDeadDetectionToken && anyChanged) {
    updateBmCounters();
    if (bmFilter === 'dead') renderBmList();
  }
}

async function deleteBookmark(id, rowEl) {
  if (!id) return;
  try {
    await chrome.bookmarks.remove(id);
    const r = rowEl?.getBoundingClientRect();
    if (r) {
      playCloseSound?.();
      shootConfetti?.(r.left + r.width / 2, r.top + r.height / 2);
    }
    if (rowEl && typeof animateCardOut === 'function') animateCardOut(rowEl);
    else rowEl?.remove();

    // Update in-memory state without a full reload
    const removed = bmFlat.find(b => b.id === id);
    bmFlat = bmFlat.filter(b => b.id !== id);
    bmDeadIds.delete(id);
    if (removed) {
      bmDupGroups = findDuplicateGroups(bmFlat);
    }
    updateBmCounters();
  } catch (err) {
    showToast?.('删除失败: ' + (err.message || err));
    console.warn('[tab-out] bookmark remove failed', err);
  }
}

async function moveBookmark(id, parentId, rowEl) {
  if (!id || !parentId) return;
  try {
    await chrome.bookmarks.move(id, { parentId });
    const folder = bmFolders.find(f => f.id === parentId);
    showToast?.(`已移动到「${folder ? folder.path : '其他'}」`);
    const b = bmFlat.find(x => x.id === id);
    if (b) {
      b.parentId = parentId;
      b.folderPath = folder ? folder.path : b.folderPath;
    }
    if (rowEl) {
      const folderEl = rowEl.querySelector('.bm-folder');
      if (folderEl && folder) folderEl.textContent = folder.path;
    }
  } catch (err) {
    showToast?.('移动失败: ' + (err.message || err));
    console.warn('[tab-out] bookmark move failed', err);
  }
}

async function deleteEmptyFolder(folderId, cardEl) {
  if (!folderId) return;
  const meta = bmFolderMeta.get(folderId);
  if (!meta) return;
  if (meta.bookmarkCount > 0) {
    showToast?.('该文件夹包含书签，无法用此功能删除');
    return;
  }
  if (isSystemRootFolder(meta)) {
    showToast?.('系统根文件夹不能删除');
    return;
  }
  try {
    await chrome.bookmarks.removeTree(folderId);
    if (cardEl) {
      const r = cardEl.getBoundingClientRect();
      playCloseSound?.();
      shootConfetti?.(r.left + r.width / 2, r.top + r.height / 2);
      if (typeof animateCardOut === 'function') animateCardOut(cardEl);
      else cardEl.remove();
    }
    bmFolderMeta.delete(folderId);
    bmFolders = bmFolders.filter(f => f.id !== folderId);
    updateBmCounters();
  } catch (err) {
    showToast?.('删除失败: ' + (err.message || err));
    console.warn('[tab-out] removeTree failed', err);
  }
}

async function bulkClearEmptyFolders() {
  const tops = getTopmostEmptyFolders();
  if (!tops.length) { showToast?.('没有空文件夹'); return; }
  if (!confirm(`将删除 ${tops.length} 个空文件夹（含递归空的子文件夹）。继续？`)) return;
  let removed = 0;
  for (const f of tops) {
    try { await chrome.bookmarks.removeTree(f.id); removed++; }
    catch (err) { console.warn('[tab-out] removeTree failed', f.id, err); }
  }
  showToast?.(`已删除 ${removed} 个空文件夹`);
  await loadBookmarks();
}

async function bulkDeleteSelected() {
  if (!bmSelected.size) return;
  const ids = [...bmSelected];
  if (!confirm(`确认删除选中的 ${ids.length} 条书签？`)) return;
  let removed = 0;
  for (const id of ids) {
    try { await chrome.bookmarks.remove(id); removed++; }
    catch (err) { console.warn('[tab-out] bulk delete failed for', id, err); }
  }
  bmSelected.clear();
  showToast?.(`已删除 ${removed} 条`);
  await loadBookmarks();
}

async function bulkMoveSelected(parentId) {
  if (!bmSelected.size || !parentId) return;
  const ids = [...bmSelected];
  let moved = 0;
  for (const id of ids) {
    try { await chrome.bookmarks.move(id, { parentId }); moved++; }
    catch (err) { console.warn('[tab-out] bulk move failed for', id, err); }
  }
  bmSelected.clear();
  const folder = bmFolders.find(f => f.id === parentId);
  showToast?.(`已移动 ${moved} 条到「${folder?.path || ''}」`);
  await loadBookmarks();
}

async function bulkDedupe() {
  if (!bmDupGroups.size) return;
  const toRemove = [];
  for (const [, ids] of bmDupGroups) {
    const items = ids.map(id => bmFlat.find(b => b.id === id)).filter(Boolean);
    if (items.length < 2) continue;
    items.sort((a, b) => (a.dateAdded || 0) - (b.dateAdded || 0));
    // Keep the earliest, remove the rest
    for (let i = 1; i < items.length; i++) toRemove.push(items[i].id);
  }
  if (!toRemove.length) return;
  if (!confirm(`将删除 ${toRemove.length} 条重复书签（每组保留最早一条）。继续？`)) return;
  for (const id of toRemove) {
    try { await chrome.bookmarks.remove(id); } catch (err) { console.warn('[tab-out] dedupe remove failed', id, err); }
  }
  showToast?.(`已删除 ${toRemove.length} 条重复书签`);
  await loadBookmarks();
}

/* ---- Bookmarks event wiring ---- */
document.getElementById('bmRefresh')?.addEventListener('click', () => {
  bmLoaded = false;
  loadBookmarks();
});

document.getElementById('bmList')?.addEventListener('click', (e) => {
  // Empty-folder card delete
  const delFolderBtn = e.target.closest('[data-bm-action="delete-folder"]');
  if (delFolderBtn) {
    const card = delFolderBtn.closest('.bm-folder-card');
    if (card) deleteEmptyFolder(card.dataset.folderId, card);
    return;
  }
  // Per-row delete
  const delBtn = e.target.closest('[data-bm-action="delete"]');
  if (delBtn) {
    const row = delBtn.closest('.bm-row');
    if (row) deleteBookmark(row.dataset.bmId, row);
    return;
  }
  // Group header click — toggle collapse (but not when clicking the checkbox)
  const header = e.target.closest('.bm-group-header');
  if (header && !e.target.closest('.bm-group-check')) {
    const group = header.closest('.bm-group');
    if (!group) return;
    const key = group.dataset.groupKey;
    if (bmCollapsedGroups.has(key)) bmCollapsedGroups.delete(key);
    else bmCollapsedGroups.add(key);
    group.classList.toggle('is-collapsed');
  }
});

document.getElementById('bmList')?.addEventListener('change', (e) => {
  // Per-row move
  const moveSel = e.target.closest('[data-bm-action="move"]');
  if (moveSel) {
    const parentId = moveSel.value;
    if (!parentId) return;
    const row = moveSel.closest('.bm-row');
    if (!row) return;
    moveBookmark(row.dataset.bmId, parentId, row);
    moveSel.value = '';
    return;
  }
  // Per-row checkbox
  const rowCheck = e.target.closest('[data-bm-action="select"]');
  if (rowCheck) {
    const row = rowCheck.closest('.bm-row');
    if (!row) return;
    const id = row.dataset.bmId;
    if (rowCheck.checked) bmSelected.add(id); else bmSelected.delete(id);
    // Sync the parent group header's checkbox state
    const group = rowCheck.closest('.bm-group');
    if (group) syncGroupCheckbox(group);
    updateBmSelectionUI();
    return;
  }
  // Group "select all" checkbox
  const groupCheck = e.target.closest('[data-bm-action="select-group"]');
  if (groupCheck) {
    const group = groupCheck.closest('.bm-group');
    if (!group) return;
    const checks = group.querySelectorAll('.bm-row .bm-check');
    checks.forEach(cb => {
      cb.checked = groupCheck.checked;
      const id = cb.closest('.bm-row')?.dataset.bmId;
      if (!id) return;
      if (groupCheck.checked) bmSelected.add(id); else bmSelected.delete(id);
    });
    groupCheck.indeterminate = false;
    updateBmSelectionUI();
  }
});

function syncGroupCheckbox(group) {
  const check = group.querySelector('.bm-group-check');
  if (!check) return;
  const items = group.querySelectorAll('.bm-row .bm-check');
  const total = items.length;
  const checked = [...items].filter(c => c.checked).length;
  check.checked = total > 0 && checked === total;
  check.indeterminate = checked > 0 && checked < total;
}

document.getElementById('bmSelClear')?.addEventListener('click', () => {
  bmSelected.clear();
  document.querySelectorAll('.bm-check, .bm-group-check').forEach(cb => {
    cb.checked = false;
    cb.indeterminate = false;
  });
  updateBmSelectionUI();
});

document.getElementById('bmBulkDeleteBtn')?.addEventListener('click', bulkDeleteSelected);

document.getElementById('bmBulkMoveSelect')?.addEventListener('change', (e) => {
  const parentId = e.target.value;
  if (!parentId) return;
  bulkMoveSelected(parentId);
  e.target.value = '';
});

document.querySelectorAll('.bm-filter').forEach(btn => {
  btn.addEventListener('click', () => {
    bmFilter = btn.dataset.filter;
    document.querySelectorAll('.bm-filter').forEach(b => b.classList.toggle('is-active', b === btn));
    renderBmList();
  });
});

document.getElementById('bmSort')?.addEventListener('change', (e) => {
  bmSort = e.target.value;
  renderBmList();
});

document.getElementById('bmFolderFilter')?.addEventListener('change', (e) => {
  bmFolderFilterId = e.target.value;
  renderBmList();
});

document.getElementById('bmDedupeBtn')?.addEventListener('click', bulkDedupe);
document.getElementById('bmClearEmptyBtn')?.addEventListener('click', bulkClearEmptyFolders);

document.getElementById('bmFolderNav')?.addEventListener('click', (e) => {
  const pill = e.target.closest('.bm-folder-pill');
  if (!pill) return;
  e.preventDefault();
  const target = document.getElementById(pill.dataset.anchor);
  if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
});


/* ---- Drag-drop re-categorization ---- */
function clearBmDropTargets() {
  document.querySelectorAll('.is-drop-target').forEach(el => el.classList.remove('is-drop-target'));
}

document.getElementById('bmList')?.addEventListener('dragstart', (e) => {
  const row = e.target.closest('.bm-row[draggable="true"]');
  if (!row) return;
  e.dataTransfer.effectAllowed = 'move';
  // If the dragged item is selected and there are multiple in selection, drag all of them
  const ids = bmSelected.has(row.dataset.bmId) && bmSelected.size > 1
    ? [...bmSelected].join(',')
    : row.dataset.bmId;
  e.dataTransfer.setData('text/x-bm-ids', ids);
  e.dataTransfer.setData('text/plain', ids);
  row.classList.add('is-dragging');
});

document.getElementById('bmList')?.addEventListener('dragend', (e) => {
  const row = e.target.closest('.bm-row');
  if (row) row.classList.remove('is-dragging');
  clearBmDropTargets();
});

// Drop on a folder lane (any .bm-group with a non-empty parentId)
document.getElementById('bmList')?.addEventListener('dragover', (e) => {
  const group = e.target.closest('.bm-group');
  if (!group || !group.dataset.parentId) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
  if (!group.classList.contains('is-drop-target')) {
    clearBmDropTargets();
    group.classList.add('is-drop-target');
  }
});

document.getElementById('bmList')?.addEventListener('dragleave', (e) => {
  // Only clear when leaving the list entirely
  if (e.target === e.currentTarget) clearBmDropTargets();
});

document.getElementById('bmList')?.addEventListener('drop', async (e) => {
  const group = e.target.closest('.bm-group');
  if (!group || !group.dataset.parentId) return;
  e.preventDefault();
  const idsRaw = e.dataTransfer.getData('text/x-bm-ids') || e.dataTransfer.getData('text/plain');
  if (!idsRaw) return;
  clearBmDropTargets();
  await dropBookmarksToFolder(idsRaw.split(','), group.dataset.parentId);
});

// Drop on a folder TOC pill
document.getElementById('bmFolderNav')?.addEventListener('dragover', (e) => {
  const pill = e.target.closest('.bm-folder-pill');
  if (!pill || !pill.dataset.parentId) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
  if (!pill.classList.contains('is-drop-target')) {
    clearBmDropTargets();
    pill.classList.add('is-drop-target');
  }
});

document.getElementById('bmFolderNav')?.addEventListener('drop', async (e) => {
  const pill = e.target.closest('.bm-folder-pill');
  if (!pill || !pill.dataset.parentId) return;
  e.preventDefault();
  const idsRaw = e.dataTransfer.getData('text/x-bm-ids') || e.dataTransfer.getData('text/plain');
  if (!idsRaw) return;
  clearBmDropTargets();
  await dropBookmarksToFolder(idsRaw.split(','), pill.dataset.parentId);
});

async function dropBookmarksToFolder(ids, parentId) {
  if (!ids || !ids.length || !parentId) return;
  // Filter out items already in target folder
  const idsToMove = ids.filter(id => {
    const b = bmFlat.find(x => x.id === id);
    return b && b.parentId !== parentId;
  });
  if (!idsToMove.length) return;
  let moved = 0;
  for (const id of idsToMove) {
    try { await chrome.bookmarks.move(id, { parentId }); moved++; }
    catch (err) { console.warn('[tab-out] drop move failed for', id, err); }
  }
  // Clear selection if we moved selected items
  if (idsToMove.some(id => bmSelected.has(id))) bmSelected.clear();
  const folder = bmFolders.find(f => f.id === parentId);
  showToast?.(`已移动 ${moved} 条到「${folder?.title || folder?.path || ''}」`);
  await loadBookmarks();
}


/* ================================================================
   时间洞察 — Timeline Insights

   Buckets bmFlat by N-month windows aligned to the calendar (e.g.
   2024 H1, 2024 H2, ...). Per bucket: top domains, top keywords
   (mixed CJK + ASCII), monthly density sparkline.
   ================================================================ */

const INS_STOPWORDS = new Set([
  // English glue
  'the','a','an','is','are','of','to','and','or','in','on','for','with','by','from',
  'how','what','why','when','where','this','that','these','those','it','its','as','at',
  'be','been','was','were','do','does','did','can','could','should','would','will',
  'i','you','he','she','we','they','my','your','his','her','our','their',
  'about','into','out','up','down','over','under','more','most','less','vs',
  'com','org','net','www','html','htm','www2','app',
  // Chinese function/glue
  '的','了','和','与','或','在','是','有','被','把','这','那','你','我','他','她','它',
  '我们','你们','他们','一个','一些','怎么','什么','为什么','如何','如果','可以','应该',
  '会','要','到','上','下','中','里','内','外','前','后','使用','介绍','以及','一种',
  '关于','已经','还是','不是','还有','但是','所以','因为','虽然','只是','非常','通过',
]);

let insLoaded = false;
let insWindowMonths = 6;

function insBucketBookmarks(items, monthsPerBucket) {
  const buckets = new Map();
  for (const b of items) {
    if (!b.dateAdded) continue;
    const d = new Date(b.dateAdded);
    if (isNaN(d.getTime())) continue;
    const year = d.getFullYear();
    const month = d.getMonth();
    const startMonth = Math.floor(month / monthsPerBucket) * monthsPerBucket;
    const key = `${year}-${String(startMonth + 1).padStart(2, '0')}`;
    if (!buckets.has(key)) {
      const start = new Date(year, startMonth, 1);
      const end = new Date(year, startMonth + monthsPerBucket, 0);
      buckets.set(key, { key, start, end, items: [] });
    }
    buckets.get(key).items.push(b);
  }
  return [...buckets.values()].sort((a, b) => b.start - a.start);
}

function insTopDomains(items, n = 6) {
  const counts = new Map();
  for (const b of items) {
    const d = bmDomain(b.url);
    if (!d) continue;
    counts.set(d, (counts.get(d) || 0) + 1);
  }
  return [...counts].sort((a, b) => b[1] - a[1]).slice(0, n);
}

function insExtractKeywords(items, n = 18) {
  const counts = new Map();
  for (const b of items) {
    const t = b.title || '';
    if (!t) continue;
    // ASCII tokens
    const ascii = t.toLowerCase().match(/[a-z][a-z0-9+#.-]{1,}/g) || [];
    for (const w of ascii) {
      if (INS_STOPWORDS.has(w) || w.length < 2 || /^\d+$/.test(w)) continue;
      counts.set(w, (counts.get(w) || 0) + 1);
    }
    // CJK runs of 2-6 chars (no segmentation, but natural punctuation breaks usually help)
    const cjk = t.match(/[\u4e00-\u9fa5]{2,6}/g) || [];
    for (const w of cjk) {
      if (INS_STOPWORDS.has(w)) continue;
      counts.set(w, (counts.get(w) || 0) + 1);
    }
  }
  return [...counts].sort((a, b) => b[1] - a[1]).slice(0, n);
}

function insMonthlyDensity(bucket) {
  const months = [];
  const cur = new Date(bucket.start);
  while (cur <= bucket.end) {
    months.push({ year: cur.getFullYear(), month: cur.getMonth(), count: 0 });
    cur.setMonth(cur.getMonth() + 1);
  }
  for (const b of bucket.items) {
    const d = new Date(b.dateAdded);
    for (const m of months) {
      if (m.year === d.getFullYear() && m.month === d.getMonth()) { m.count++; break; }
    }
  }
  return months;
}

function insFormatRange(bucket) {
  const s = bucket.start, e = bucket.end;
  const sStr = `${s.getFullYear()}年${s.getMonth() + 1}月`;
  const eStr = `${e.getFullYear()}年${e.getMonth() + 1}月`;
  return s.getFullYear() === e.getFullYear() && s.getMonth() === e.getMonth()
    ? sStr
    : `${sStr} – ${eStr}`;
}

function renderInsightCard(bucket) {
  const domains = insTopDomains(bucket.items, 6);
  const keywords = insExtractKeywords(bucket.items, 18);
  const density = insMonthlyDensity(bucket);
  const maxC = Math.max(...density.map(d => d.count), 1);

  const sparkline = density.map(d => {
    const h = d.count > 0 ? Math.max(4, Math.round((d.count / maxC) * 32)) : 2;
    return `<span class="ins-bar" style="height:${h}px" title="${d.year}-${String(d.month + 1).padStart(2, '0')}: ${d.count} 条"></span>`;
  }).join('');

  const monthLabels = density.map(d => `<span class="ins-bar-label">${d.month + 1}</span>`).join('');

  const domainsHtml = domains.map(([d, c]) =>
    `<span class="ins-domain"><span class="ins-domain-name">${escapeHtml(d)}</span><span class="ins-domain-c">${c}</span></span>`
  ).join('');

  const minK = keywords.length ? keywords[keywords.length - 1][1] : 1;
  const maxK = keywords.length ? keywords[0][1] : 1;
  const keywordsHtml = keywords.map(([w, c]) => {
    const ratio = maxK === minK ? 0.5 : (c - minK) / (maxK - minK);
    const size = (14 + ratio * 10).toFixed(1);
    const weight = ratio > 0.6 ? 700 : ratio > 0.3 ? 600 : 500;
    return `<span class="ins-kw" style="font-size:${size}px;font-weight:${weight}" title="${c} 次">${escapeHtml(w)}</span>`;
  }).join('');

  return `
    <div class="ins-card">
      <div class="ins-card-head">
        <div class="ins-period">${escapeHtml(insFormatRange(bucket))}</div>
        <div class="ins-count">${bucket.items.length} 条</div>
      </div>
      <div class="ins-spark-wrap">
        <div class="ins-spark">${sparkline}</div>
        <div class="ins-spark-labels">${monthLabels}</div>
      </div>
      <div class="ins-block">
        <div class="ins-label">主要域名</div>
        <div class="ins-domains">${domainsHtml || '<span class="ins-empty-text">无</span>'}</div>
      </div>
      <div class="ins-block">
        <div class="ins-label">关键词</div>
        <div class="ins-keywords">${keywordsHtml || '<span class="ins-empty-text">标题里没找到关键词</span>'}</div>
      </div>
    </div>
  `;
}

function renderInsights() {
  const list   = document.getElementById('insList');
  const count  = document.getElementById('insCount');
  const status = document.getElementById('insStatus');
  if (!list) return;
  const buckets = insBucketBookmarks(bmFlat, insWindowMonths);
  if (count) count.textContent = `${bmFlat.length} 条 · ${buckets.length} 个时段`;
  if (!buckets.length) {
    list.innerHTML = '<div class="ins-empty">没有可分析的书签（书签需要带时间戳）。</div>';
  } else {
    list.innerHTML = buckets.map(renderInsightCard).join('');
  }
  if (status) status.textContent = '';
}

async function loadInsights() {
  const status = document.getElementById('insStatus');
  if (!bmLoaded) {
    if (status) status.textContent = '正在读取书签…';
    await loadBookmarks();
  }
  insLoaded = true;
  renderInsights();
}

document.getElementById('insRefresh')?.addEventListener('click', async () => {
  bmLoaded = false; insLoaded = false;
  await loadInsights();
});

document.getElementById('insWindow')?.addEventListener('change', (e) => {
  insWindowMonths = parseInt(e.target.value, 10) || 6;
  if (insLoaded) renderInsights();
});


/* ================================================================
   近期足迹 — Browser History insights

   Pulls from chrome.history.search() over a configurable window
   (7/30/90 days). Renders: stat strip, category breakdown,
   top domains, top pages.
   ================================================================ */

let histLoaded = false;
let histWindowDays = 30;
let histItems = [];

async function loadHistoryInsights() {
  const status = document.getElementById('histStatus');
  if (!chrome.history) {
    if (status) status.innerHTML = '<div class="bm-error">chrome.history API 不可用，请确认扩展已加 history 权限并重新加载。</div>';
    return;
  }
  if (status) status.textContent = '正在读取浏览历史…';
  try {
    const startTime = Date.now() - histWindowDays * 86400000;
    histItems = await chrome.history.search({ text: '', startTime, maxResults: 50000 });
    histLoaded = true;
    renderHistoryInsights();
    if (status) status.textContent = '';
  } catch (err) {
    if (status) status.innerHTML = `<div class="bm-error">读取失败: ${escapeHtml(err.message || String(err))}</div>`;
    console.warn('[tab-out] history load failed', err);
  }
}

function histDomainOf(url) {
  try { return new URL(url).hostname.toLowerCase().replace(/^www\./, ''); } catch { return ''; }
}

function renderHistStats() {
  const wrap = document.getElementById('histStats');
  const count = document.getElementById('histCount');
  if (!wrap) return;
  const totalItems = histItems.length;
  const totalVisits = histItems.reduce((s, it) => s + (it.visitCount || 0), 0);
  const uniqueDomains = new Set();
  for (const it of histItems) { const d = histDomainOf(it.url); if (d) uniqueDomains.add(d); }
  if (count) count.textContent = totalItems ? `${totalItems} 个页面 · ${histWindowDays} 天` : '';
  wrap.innerHTML = `
    <div class="hist-stat"><div class="hist-stat-num">${totalItems.toLocaleString()}</div><div class="hist-stat-label">不同页面</div></div>
    <div class="hist-stat"><div class="hist-stat-num">${uniqueDomains.size.toLocaleString()}</div><div class="hist-stat-label">不同域名</div></div>
    <div class="hist-stat"><div class="hist-stat-num">${totalVisits.toLocaleString()}</div><div class="hist-stat-label">总访问次数 (历史累计)</div></div>
  `;
}

function renderHistCategories() {
  const wrap = document.getElementById('histCategories');
  if (!wrap) return;
  // Aggregate visit counts by category
  const cats = new Map(); // label -> { label, cls, visits, domains: Set }
  let other = { label: '其他', cls: 'cat-other', visits: 0, domains: new Set() };
  for (const it of histItems) {
    const cat = bmCategoryFor(it.url);
    const d = histDomainOf(it.url);
    if (cat) {
      const e = cats.get(cat.label) || { label: cat.label, cls: cat.cls, visits: 0, domains: new Set() };
      e.visits += it.visitCount || 0;
      if (d) e.domains.add(d);
      cats.set(cat.label, e);
    } else {
      other.visits += it.visitCount || 0;
      if (d) other.domains.add(d);
    }
  }
  const all = [...cats.values()];
  if (other.visits > 0) all.push(other);
  const totalVisits = all.reduce((s, e) => s + e.visits, 0);
  if (!totalVisits) {
    wrap.innerHTML = '<div class="hist-empty">暂无数据</div>';
    return;
  }
  all.sort((a, b) => b.visits - a.visits);
  wrap.innerHTML = all.map(e => {
    const pct = (e.visits / totalVisits * 100).toFixed(1);
    return `
      <div class="hist-cat-row">
        <div class="hist-cat-label">
          <span class="bm-tag bm-cat ${e.cls}">${escapeHtml(e.label)}</span>
        </div>
        <div class="hist-cat-bar-wrap">
          <div class="hist-cat-bar ${e.cls}" style="width:${pct}%"></div>
        </div>
        <div class="hist-cat-stats">
          <span class="hist-cat-pct">${pct}%</span>
          <span class="hist-cat-count">${e.visits.toLocaleString()} 次 · ${e.domains.size} 域名</span>
        </div>
      </div>
    `;
  }).join('');
}

function renderHistTopDomains() {
  const wrap = document.getElementById('histDomains');
  if (!wrap) return;
  const counts = new Map();
  for (const it of histItems) {
    const d = histDomainOf(it.url);
    if (!d) continue;
    const e = counts.get(d) || { domain: d, visits: 0, pages: 0, lastVisit: 0 };
    e.visits += it.visitCount || 0;
    e.pages += 1;
    if ((it.lastVisitTime || 0) > e.lastVisit) e.lastVisit = it.lastVisitTime || 0;
    counts.set(d, e);
  }
  const top = [...counts.values()].sort((a, b) => b.visits - a.visits).slice(0, 15);
  if (!top.length) {
    wrap.innerHTML = '<div class="hist-empty">暂无数据</div>';
    return;
  }
  const max = top[0].visits;
  wrap.innerHTML = top.map(e => {
    const pct = (e.visits / max * 100).toFixed(0);
    const cat = bmCategoryFor('https://' + e.domain);
    const catTag = cat ? `<span class="bm-tag bm-cat ${cat.cls}">${escapeHtml(cat.label)}</span>` : '';
    return `
      <div class="hist-domain-row">
        <img class="bm-favicon" src="${escapeHtml(`https://www.google.com/s2/favicons?domain=${e.domain}&sz=32`)}" alt="" loading="lazy">
        <div class="hist-domain-name">${escapeHtml(e.domain)}</div>
        ${catTag}
        <div class="hist-domain-bar-wrap"><div class="hist-domain-bar" style="width:${pct}%"></div></div>
        <div class="hist-domain-stats">
          <strong>${e.visits.toLocaleString()}</strong> 次 · ${e.pages} 页
        </div>
      </div>
    `;
  }).join('');
}

function renderHistTopPages() {
  const wrap = document.getElementById('histPages');
  if (!wrap) return;
  const sorted = histItems
    .slice()
    .sort((a, b) => (b.visitCount || 0) - (a.visitCount || 0))
    .slice(0, 30);
  if (!sorted.length) {
    wrap.innerHTML = '<div class="hist-empty">暂无数据</div>';
    return;
  }
  const max = sorted[0].visitCount || 1;
  wrap.innerHTML = sorted.map(it => {
    const d = histDomainOf(it.url);
    const cat = bmCategoryFor(it.url);
    const catTag = cat ? `<span class="bm-tag bm-cat ${cat.cls}">${escapeHtml(cat.label)}</span>` : '';
    const visits = it.visitCount || 0;
    const pct = (visits / max * 100).toFixed(0);
    return `
      <div class="hist-page-row">
        <img class="bm-favicon" src="${escapeHtml(`https://www.google.com/s2/favicons?domain=${d}&sz=32`)}" alt="" loading="lazy">
        <div class="hist-page-main">
          <a class="hist-page-title" href="${escapeHtml(it.url)}" target="_blank" rel="noopener" title="${escapeHtml(it.title || it.url)}">${escapeHtml(it.title || it.url)}</a>
          <div class="hist-page-meta">
            <span class="hist-page-domain">${escapeHtml(d)}</span>
            ${catTag}
          </div>
        </div>
        <div class="hist-page-bar-wrap"><div class="hist-page-bar" style="width:${pct}%"></div></div>
        <div class="hist-page-count">
          <strong>${visits.toLocaleString()}</strong>
          <span>次</span>
        </div>
      </div>
    `;
  }).join('');
}

// Hex colors keyed by bm category class — used for SVG fill/stroke
const HIST_CAT_COLOR = {
  'cat-video':  '#C75B3F',
  'cat-code':   '#6B5544',
  'cat-ai':     '#3A2A1F',
  'cat-news':   '#6E9F6E',
  'cat-design': '#E89378',
  'cat-learn':  '#D6A04D',
  'cat-shop':   '#D6684D',
  'cat-tool':   '#9C8169',
  'cat-other':  '#C5B7A8',
};

async function loadHistClockData() {
  const status = document.getElementById('histClockStatus');
  if (status) status.textContent = '正在统计每次访问的时间…';
  const startTime = Date.now() - histWindowDays * 86400000;
  const items = histItems;
  const concurrency = 16;
  let cursor = 0;
  // hour -> Map<categoryLabel, {label, cls, count}>
  const grid = Array.from({ length: 24 }, () => new Map());
  await Promise.all(Array.from({ length: concurrency }, async () => {
    while (cursor < items.length) {
      const it = items[cursor++];
      try {
        const list = await chrome.history.getVisits({ url: it.url });
        const cat = bmCategoryFor(it.url);
        const label = cat ? cat.label : '其他';
        const cls   = cat ? cat.cls   : 'cat-other';
        for (const v of list) {
          if (!v.visitTime || v.visitTime < startTime) continue;
          const hr = new Date(v.visitTime).getHours();
          const m = grid[hr];
          const e = m.get(label) || { label, cls, count: 0 };
          e.count++;
          m.set(label, e);
        }
      } catch { /* ignore unreadable URLs */ }
    }
  }));
  if (status) status.textContent = '';
  return grid;
}

function renderHistClock(grid) {
  const wrap = document.getElementById('histClock');
  const peakWrap = document.getElementById('histPeakList');
  const legendWrap = document.getElementById('histClockLegend');
  if (!wrap) return;

  const totalsByHour = grid.map(m => [...m.values()].reduce((s, e) => s + e.count, 0));
  const maxCount = Math.max(...totalsByHour, 1);
  const totalAll = totalsByHour.reduce((s, n) => s + n, 0);

  if (!totalAll) {
    wrap.innerHTML = '<div class="hist-empty">暂无访问数据</div>';
    if (peakWrap) peakWrap.innerHTML = '';
    if (legendWrap) legendWrap.innerHTML = '';
    return;
  }

  // Consistent stacking order: most-visited categories at the bottom
  const seenCats = new Map();
  for (const m of grid) for (const e of m.values()) {
    if (!seenCats.has(e.label)) seenCats.set(e.label, { label: e.label, cls: e.cls, count: 0 });
    seenCats.get(e.label).count += e.count;
  }
  const orderedCats = [...seenCats.values()].sort((a, b) => b.count - a.count);
  const peakHour = totalsByHour.indexOf(maxCount);

  // Build 24 stacked columns
  const cols = [];
  for (let h = 0; h < 24; h++) {
    const total = totalsByHour[h];
    const heightPct = (total / maxCount) * 100;
    let segments = '';
    if (total > 0) {
      segments = orderedCats.map(cat => {
        const e = grid[h].get(cat.label);
        if (!e || !e.count) return '';
        const segPct = (e.count / total) * 100;
        const color = HIST_CAT_COLOR[cat.cls] || HIST_CAT_COLOR['cat-other'];
        return `<div class="hist-hour-seg" style="height:${segPct.toFixed(2)}%;background:${color}" title="${h}:00 ${escapeHtml(cat.label)}: ${e.count}"></div>`;
      }).join('');
    }
    const isPeak = h === peakHour && total > 0;
    cols.push(`
      <div class="hist-hour-col${isPeak ? ' is-peak' : ''}" title="${String(h).padStart(2,'0')}:00 — ${total} 次">
        <div class="hist-hour-count">${total > 0 ? total : ''}</div>
        <div class="hist-hour-stack" style="height:${heightPct.toFixed(2)}%">${segments}</div>
        <div class="hist-hour-label">${String(h).padStart(2,'0')}</div>
      </div>
    `);
  }
  wrap.innerHTML = `<div class="hist-hourly-chart">${cols.join('')}</div>`;

  // Peak list — top 3 hours
  if (peakWrap) {
    const ranked = totalsByHour
      .map((c, h) => ({ h, c }))
      .filter(x => x.c > 0)
      .sort((a, b) => b.c - a.c)
      .slice(0, 3);
    peakWrap.innerHTML = `
      <div class="hist-peak-title">活跃时段 TOP 3</div>
      <ol class="hist-peak-ol">
        ${ranked.map(({ h, c }) => {
          const dom = [...grid[h].values()].sort((a, b) => b.count - a.count)[0];
          const color = HIST_CAT_COLOR[dom.cls];
          const pct = ((c / totalAll) * 100).toFixed(0);
          return `<li>
            <span class="hist-peak-hour">${String(h).padStart(2,'0')}:00</span>
            <span class="hist-peak-bar" style="background:${color}; width:${(c/maxCount*100).toFixed(0)}%"></span>
            <span class="hist-peak-meta"><strong>${dom.label}</strong> · ${c} 次 · ${pct}%</span>
          </li>`;
        }).join('')}
      </ol>
    `;
  }

  // Legend — only categories that appear
  if (legendWrap) {
    const seen = new Map();
    for (const m of grid) for (const e of m.values()) {
      if (!seen.has(e.label)) seen.set(e.label, { label: e.label, cls: e.cls, count: 0 });
      seen.get(e.label).count += e.count;
    }
    const items = [...seen.values()].sort((a, b) => b.count - a.count);
    legendWrap.innerHTML = `
      <div class="hist-legend-title">类别图例</div>
      <div class="hist-legend-grid">
        ${items.map(it => `
          <div class="hist-legend-item">
            <span class="hist-legend-swatch" style="background:${HIST_CAT_COLOR[it.cls]}"></span>
            <span class="hist-legend-label">${escapeHtml(it.label)}</span>
            <span class="hist-legend-count">${it.count.toLocaleString()}</span>
          </div>
        `).join('')}
      </div>
    `;
  }
}

async function renderHistoryInsights() {
  if (!histItems.length) {
    const status = document.getElementById('histStatus');
    if (status) status.textContent = '这个时段没有浏览记录。';
    ['histStats', 'histClock', 'histPeakList', 'histClockLegend', 'histCategories', 'histDomains', 'histPages']
      .forEach(id => { const el = document.getElementById(id); if (el) el.innerHTML = ''; });
    return;
  }
  renderHistStats();
  renderHistCategories();
  renderHistTopDomains();
  renderHistTopPages();
  // Clock requires async getVisits — kicks off, renders when done
  const grid = await loadHistClockData();
  renderHistClock(grid);
}

document.getElementById('histRefresh')?.addEventListener('click', () => {
  histLoaded = false;
  loadHistoryInsights();
});

document.getElementById('histWindow')?.addEventListener('change', (e) => {
  histWindowDays = parseInt(e.target.value, 10) || 30;
  histLoaded = false;
  loadHistoryInsights();
});


/* ----------------------------------------------------------------
   VIEW TABS — switch between Open Tabs / 整理收藏夹 / 时间洞察 / 近期足迹
   ---------------------------------------------------------------- */
function setActiveView(view) {
  document.body.dataset.view = view;
  document.querySelectorAll('.view-tab').forEach(t => {
    t.classList.toggle('is-active', t.dataset.view === view);
  });
  document.querySelectorAll('.view-pane').forEach(p => {
    p.classList.toggle('is-active', p.dataset.view === view);
  });
  if (view === 'bookmarks' && !bmLoaded) loadBookmarks();
  if (view === 'insights' && !insLoaded) loadInsights();
  if (view === 'history' && !histLoaded) loadHistoryInsights();
}

document.getElementById('viewTabs')?.addEventListener('click', (e) => {
  const tab = e.target.closest('.view-tab');
  if (!tab) return;
  setActiveView(tab.dataset.view);
});


/* ----------------------------------------------------------------
   INITIALIZE
   ---------------------------------------------------------------- */
renderDashboard();
