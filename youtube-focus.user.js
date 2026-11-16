// ==UserScript==
// @name         YouTube Focus
// @namespace    https://github.com/neverwinter6/youtube-focus
// @version      1.0.0
// @description  Removes Shorts, the recommendation sidebar, end screens and autoplay, and remembers your playback speed.
// @author       Fabrizio (neverwinter6)
// @match        https://www.youtube.com/*
// @match        https://m.youtube.com/*
// @icon         data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'%3E%3Ccircle cx='12' cy='12' r='10' fill='%23ff0033'/%3E%3Cpath d='M10 8l6 4-6 4z' fill='white'/%3E%3C/svg%3E
// @run-at       document-start
// @noframes
// @license      MIT
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// ==/UserScript==

/*
 * YouTube Focus
 * -------------
 * Five changes, each one switchable from the "Focus" pill in the top-right
 * corner or from the userscript manager's menu:
 *
 *   shorts     hide every Shorts surface, and turn /shorts/<id> links into
 *              ordinary watch pages
 *   focus      hide the "up next" sidebar, end-screen cards and overlays
 *   autoplay   switch YouTube's autoplay toggle off whenever a video starts
 *   speed      remember the playback speed you picked for the next video,
 *              reload and session
 *   home       replace the home feed with a search prompt
 *
 * YouTube is a single-page app: clicking a link does not reload the page, it
 * swaps components in place. So nothing here runs only once: the script
 * listens for YouTube's navigation events and keeps a debounced
 * MutationObserver on the DOM, then cheaply re-applies every change.
 */

(() => {
  'use strict';

  // ---------------------------------------------------------------------------
  // Settings
  // ---------------------------------------------------------------------------

  const SETTINGS_KEY = 'ytf:settings:v1';
  const SPEED_KEY = 'ytf:speed:v1';
  const DEFAULTS = {
    shorts: true,
    focus: true,
    autoplay: true,
    speed: true,
    home: false,
  };

  const gmAvailable =
    typeof GM_getValue === 'function' && typeof GM_setValue === 'function';

  function readRaw(key, fallback) {
    try {
      if (gmAvailable) {
        const value = GM_getValue(key, null);
        return value == null ? fallback : value;
      }
      const raw = localStorage.getItem(key);
      return raw == null ? fallback : JSON.parse(raw);
    } catch {
      return fallback;
    }
  }

  function writeRaw(key, value) {
    try {
      if (gmAvailable) GM_setValue(key, value);
      else localStorage.setItem(key, JSON.stringify(value));
    } catch {
      /* storage full or disabled: the script still works for this tab */
    }
  }

  function loadSettings() {
    const stored = readRaw(SETTINGS_KEY, {});
    const merged = { ...DEFAULTS };
    if (stored && typeof stored === 'object') {
      for (const key of Object.keys(DEFAULTS)) {
        if (typeof stored[key] === 'boolean') merged[key] = stored[key];
      }
    }
    return merged;
  }

  let settings = loadSettings();

  function saveSettings() {
    writeRaw(SETTINGS_KEY, settings);
  }

  function setSetting(key, value) {
    if (settings[key] === value) return;
    settings[key] = value;
    saveSettings();
    applyNow();
  }

  // ---------------------------------------------------------------------------
  // Small helpers
  // ---------------------------------------------------------------------------

  /**
   * Tiny element helper. YouTube ships a Trusted Types policy, so assigning
   * innerHTML from a userscript is blocked; every node is built by hand.
   */
  function h(tag, props = {}, ...children) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(props)) {
      if (key === 'text') node.textContent = value;
      else if (key === 'class') node.className = value;
      else node.setAttribute(key, value);
    }
    for (const child of children.flat()) {
      if (child == null) continue;
      node.append(typeof child === 'string' ? document.createTextNode(child) : child);
    }
    return node;
  }

  function currentVideoId() {
    const url = new URL(location.href);
    if (url.pathname === '/watch') return url.searchParams.get('v');
    const shorts = url.pathname.match(/^\/shorts\/([\w-]+)/);
    return shorts ? shorts[1] : null;
  }

  // ---------------------------------------------------------------------------
  // Shorts
  // ---------------------------------------------------------------------------

  const SHORTS_CONTAINERS = [
    'ytd-rich-item-renderer',
    'ytd-video-renderer',
    'ytd-compact-video-renderer',
    'ytd-grid-video-renderer',
    'ytd-playlist-video-renderer',
    'yt-lockup-view-model',
    'ytd-guide-entry-renderer',
    'ytd-mini-guide-entry-renderer',
    'ytd-reel-item-renderer',
    'ytm-shorts-lockup-view-model',
  ].join(',');

  /** Tags the card that contains a Shorts link, not the whole feed. */
  function markShortsCards() {
    for (const link of document.querySelectorAll('a[href^="/shorts/"]')) {
      // A dedicated Shorts shelf: hide the shelf block (header included) but
      // stop at the section, which also holds ordinary results.
      const shelf = link.closest('grid-shelf-view-model, ytd-reel-shelf-renderer');
      if (shelf) {
        let block = shelf;
        while (
          block.parentElement &&
          block.parentElement.id !== 'contents' &&
          !/^(YTD-ITEM-SECTION-RENDERER|YTD-RICH-SECTION-RENDERER|YTD-RICH-GRID-RENDERER)$/.test(
            block.parentElement.tagName
          )
        ) {
          block = block.parentElement;
        }
        block.dataset.ytfShorts = '1';
        continue;
      }
      // A single Short mixed into a normal list: drop just that card.
      const card = link.closest(SHORTS_CONTAINERS);
      if (card) card.dataset.ytfShorts = '1';
    }
  }

  /** Sends /shorts/<id> to the ordinary watch page, keeping the timestamp. */
  function redirectShortsPage() {
    if (!settings.shorts) return;
    const match = location.pathname.match(/^\/shorts\/([\w-]+)/);
    if (!match) return;
    const url = new URL(location.href);
    url.pathname = '/watch';
    url.searchParams.set('v', match[1]);
    location.replace(url.toString());
  }

  // ---------------------------------------------------------------------------
  // Autoplay
  // ---------------------------------------------------------------------------

  let autoplayFor = null;

  /**
   * Clicks YouTube's own autoplay switch off, once per video. We do not keep
   * fighting the user if they turn it back on for the current video.
   */
  function enforceAutoplay() {
    if (!settings.autoplay || location.pathname !== '/watch') return;
    const videoId = currentVideoId();
    if (!videoId || autoplayFor === videoId) return;

    const toggle = document.querySelector('.ytp-autonav-toggle-button');
    if (!toggle) return;

    if (toggle.getAttribute('aria-checked') === 'true') {
      toggle.click();
      autoplayFor = videoId;
    }
  }

  // ---------------------------------------------------------------------------
  // Playback speed memory
  // ---------------------------------------------------------------------------

  function storedSpeed() {
    const value = Number(readRaw(SPEED_KEY, 1));
    return Number.isFinite(value) && value >= 0.25 && value <= 4 ? value : 1;
  }

  function saveSpeed(rate) {
    writeRaw(SPEED_KEY, rate);
    updateSpeedChip();
  }

  let speedVideo = null;
  let speedWatchTimer = null;
  let speedWindowStart = Date.now();

  /**
   * YouTube re-applies its own playback rate while a video initialises, which
   * silently undoes ours. A short watch loop re-asserts the saved speed until
   * the player settles, then stops.
   */
  function startSpeedWatch() {
    if (speedWatchTimer) return;
    const until = Date.now() + 8000;
    speedWatchTimer = setInterval(() => {
      applySpeed();
      if (Date.now() > until) {
        clearInterval(speedWatchTimer);
        speedWatchTimer = null;
      }
    }, 400);
  }

  function applySpeed() {
    if (!settings.speed || location.pathname !== '/watch') return;

    const video = document.querySelector('video.html5-main-video');
    if (!video) return;

    if (video !== speedVideo) {
      speedVideo = video;
      video.addEventListener('ratechange', () => {
        const rate = video.playbackRate;
        // Ignore the rate YouTube restores while the player boots, and ignore
        // the value we just wrote ourselves.
        if (Date.now() - speedWindowStart < 1500) return;
        if (Math.abs(rate - storedSpeed()) < 0.01) return;
        saveSpeed(rate);
        updateSpeedChip();
      });
      video.addEventListener('loadeddata', applySpeed);
      video.addEventListener('play', applySpeed);
    }

    const wanted = storedSpeed();
    if (wanted !== 1) {
      if (Math.abs(video.playbackRate - wanted) > 0.01) {
        video.playbackRate = wanted;
        video.defaultPlaybackRate = wanted;
      }
    }
    updateSpeedChip();
  }

  function setSpeed(rate) {
    settings.speed = true;
    saveSettings();
    saveSpeed(rate);
    const video = document.querySelector('video.html5-main-video');
    if (video) {
      video.playbackRate = rate;
      video.defaultPlaybackRate = rate;
    }
    const input = ui?.shadow.querySelector('input[data-key="speed"]');
    if (input) input.checked = true;
    updateSpeedChip();
  }

  // ---------------------------------------------------------------------------
  // Home feed
  // ---------------------------------------------------------------------------

  function renderHomeBlocker() {
    if (!settings.home) {
      document.querySelector('#ytf-home')?.remove();
      return;
    }
    const browse = document.querySelector('ytd-browse[page-subtype="home"]');
    if (!browse || browse.querySelector('#ytf-home')) return;

    const button = h('button', { type: 'button', text: 'Turn the feed back on' });
    button.addEventListener('click', () => setSetting('home', false));

    const panel = h(
      'div',
      { id: 'ytf-home' },
      h('h2', { text: 'Feed off' }),
      h('p', {
        text: 'YouTube Focus is keeping the home feed out of the way. Search for something specific, or open a channel you actually want to watch.',
      }),
      button
    );

    (browse.querySelector('#primary') || browse).prepend(panel);
  }

  // ---------------------------------------------------------------------------
  // Settings panel
  // ---------------------------------------------------------------------------

  const PANEL_LABELS = [
    ['shorts', 'Hide Shorts', 'Shelves, cards and the sidebar entry, everywhere.'],
    ['focus', 'Focus mode', 'No "up next" sidebar, end screens or overlays on videos.'],
    ['autoplay', 'No autoplay', 'The next video never starts by itself.'],
    ['speed', 'Remember speed', 'Keeps your playback speed for the next video.'],
    ['home', 'Hide home feed', 'Replaces the feed with a search prompt.'],
  ];

  let ui = null;

  const UI_CSS = `
    :host {
      all: initial;
      display: flex; align-items: center; gap: 6px;
      font-family: "YouTube Sans", Roboto, system-ui, sans-serif;
    }
    :host([data-floating]) {
      position: fixed; bottom: 20px; right: 20px; z-index: 2147483646;
      padding: 4px; border-radius: 22px;
      background: rgba(15, 15, 15, .8); backdrop-filter: blur(10px);
    }
    .ytf-pill, .ytf-speed {
      display: flex; align-items: center; gap: 6px;
      height: 34px; padding: 0 12px; border-radius: 17px; cursor: pointer;
      font-family: inherit; font-size: 12px; font-weight: 600; line-height: 1;
      color: var(--yt-spec-text-primary, #0f0f0f);
      border: 1px solid var(--yt-spec-10-percent-layer, rgba(0, 0, 0, .15));
      background: transparent; user-select: none; white-space: nowrap;
    }
    :host([data-floating]) .ytf-pill,
    :host([data-floating]) .ytf-speed { color: #f1f1f1; border-color: rgba(255, 255, 255, .2); }
    .ytf-pill:hover, .ytf-speed:hover,
    .ytf-pill:focus-visible, .ytf-speed:focus-visible {
      background: var(--yt-spec-badge-chip-background, rgba(0, 0, 0, .05));
    }
    .ytf-pill[data-active="true"] .ytf-dot { background: #ff0033; }
    .ytf-dot { width: 7px; height: 7px; border-radius: 50%; background: #9a9a9a; }
    .ytf-speed[hidden] { display: none; }
    .ytf-panel {
      position: fixed; top: 64px; right: 16px; z-index: 2147483647;
      width: 300px; max-height: calc(100vh - 88px); overflow: auto;
      padding: 14px; border-radius: 14px;
      background: #212121; color: #f1f1f1;
      border: 1px solid rgba(255, 255, 255, .12);
      box-shadow: 0 18px 50px rgba(0, 0, 0, .55);
      font: 400 13px/1.4 Roboto, system-ui, sans-serif;
    }
    .ytf-panel[hidden] { display: none; }
    .ytf-panel h3 { margin: 0 0 2px; font: 600 14px/1.2 Roboto, system-ui, sans-serif; }
    .ytf-panel .ytf-sub { margin: 0 0 12px; color: #aaa; font-size: 11.5px; }
    .ytf-row {
      display: flex; align-items: flex-start; justify-content: space-between;
      gap: 12px; padding: 9px 0; border-top: 1px solid rgba(255, 255, 255, .07);
      cursor: pointer;
    }
    .ytf-row:first-of-type { border-top: 0; }
    .ytf-name { display: block; font-weight: 500; }
    .ytf-desc { display: block; color: #9a9a9a; font-size: 11px; margin-top: 2px; }
    .ytf-switch { position: relative; flex: none; width: 34px; height: 20px; }
    .ytf-switch input { position: absolute; opacity: 0; width: 100%; height: 100%; margin: 0; cursor: pointer; }
    .ytf-switch .rail {
      position: absolute; inset: 0; border-radius: 999px;
      background: #4a4a4a; transition: background .15s ease;
    }
    .ytf-switch .rail::after {
      content: ""; position: absolute; top: 2px; left: 2px;
      width: 16px; height: 16px; border-radius: 50%;
      background: #fff; transition: transform .15s ease;
    }
    .ytf-switch input:checked + .rail { background: #ff0033; }
    .ytf-switch input:checked + .rail::after { transform: translateX(14px); }
    .ytf-switch input:focus-visible + .rail { outline: 2px solid #7ab8ff; outline-offset: 2px; }
    .ytf-foot {
      margin-top: 10px; padding-top: 10px; border-top: 1px solid rgba(255, 255, 255, .07);
      color: #8a8a8a; font-size: 11px;
    }
    kbd {
      font: 600 10px/1 ui-monospace, monospace; padding: 2px 4px; border-radius: 4px;
      background: #333; border: 1px solid #444; color: #ddd;
    }
  `;

  /**
   * Docks the settings button in YouTube's masthead. If the masthead is not
   * there (unusual layouts), it falls back to a floating pill instead.
   */
  function mountHost(host) {
    const buttons = document.querySelector('ytd-masthead #buttons');
    if (buttons) {
      host.removeAttribute('data-floating');
      if (host.parentElement !== buttons) buttons.prepend(host);
      return;
    }
    host.dataset.floating = '1';
    if (host.parentElement !== document.body) document.body.append(host);
  }

  function updateSpeedChip() {
    if (!ui) return;
    const rate = speedVideo?.playbackRate ?? storedSpeed();
    const show = settings.speed && location.pathname === '/watch' && Math.abs(rate - 1) > 0.01;
    ui.speed.hidden = !show;
    if (show) {
      ui.speed.textContent = `${Number(rate.toFixed(2))}\u00d7`;
      ui.speed.title = 'Playback speed remembered by YouTube Focus. Click for 1\u00d7.';
    }
  }

  function buildUi() {
    if (ui || !document.body) return;

    const host = document.createElement('div');
    host.id = 'ytf-root';
    const shadow = host.attachShadow({ mode: 'open' });

    const style = document.createElement('style');
    style.textContent = UI_CSS;

    const pill = h(
      'div',
      {
        class: 'ytf-pill',
        role: 'button',
        tabindex: '0',
        'aria-expanded': 'false',
        title: 'YouTube Focus settings (Alt+J)',
      },
      h('span', { class: 'ytf-dot' }),
      h('span', { text: 'Focus' })
    );

    const speed = h('div', { class: 'ytf-speed', hidden: '', role: 'button', tabindex: '0' });
    speed.addEventListener('click', () => setSpeed(1));
    speed.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        setSpeed(1);
      }
    });

    const rows = PANEL_LABELS.map(([key, name, desc]) => {
      const input = h('input', { type: 'checkbox', 'data-key': key });
      input.addEventListener('change', () => setSetting(key, input.checked));
      return h(
        'label',
        { class: 'ytf-row' },
        h(
          'span',
          {},
          h('span', { class: 'ytf-name', text: name }),
          h('span', { class: 'ytf-desc', text: desc })
        ),
        h('span', { class: 'ytf-switch' }, input, h('span', { class: 'rail' }))
      );
    });

    const kbd = (text) => h('kbd', { text });

    const panel = h(
      'div',
      { class: 'ytf-panel', hidden: '' },
      h('h3', { text: 'YouTube Focus' }),
      h('p', { class: 'ytf-sub', text: 'Changes apply immediately and are remembered.' }),
      ...rows,
      h(
        'div',
        { class: 'ytf-foot' },
        kbd('Alt'),
        ' + ',
        kbd('F'),
        ' toggles focus mode / ',
        kbd('Alt'),
        ' + ',
        kbd('J'),
        ' opens this panel'
      )
    );

    shadow.append(style, speed, pill, panel);

    const togglePanel = (force) => {
      const open = typeof force === 'boolean' ? force : panel.hidden;
      panel.hidden = !open;
      pill.setAttribute('aria-expanded', String(open));
    };

    pill.addEventListener('click', () => togglePanel());
    pill.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        togglePanel();
      }
    });

    // Close when clicking somewhere else on the page.
    document.addEventListener(
      'pointerdown',
      (event) => {
        if (!host.isConnected) return;
        if (!event.composedPath().includes(host)) togglePanel(false);
      },
      true
    );

    mountHost(host);
    ui = { host, shadow, pill, panel, speed, togglePanel };

    ui.sync = () => {
      for (const input of shadow.querySelectorAll('input[data-key]')) {
        input.checked = Boolean(settings[input.dataset.key]);
      }
      const anyOn = Object.values(settings).some(Boolean);
      pill.dataset.active = String(anyOn);
      updateSpeedChip();
    };
    ui.sync();
  }

  // ---------------------------------------------------------------------------
  // Applying everything
  // ---------------------------------------------------------------------------

  function applyNow() {
    const root = document.documentElement;
    // Between documents (initial about:blank, teardown) there is no root yet.
    if (!root) return;

    root.dataset.ytfShorts = settings.shorts ? 'on' : 'off';
    root.dataset.ytfFocus = settings.focus ? 'on' : 'off';
    root.dataset.ytfHome = settings.home ? 'on' : 'off';

    if (settings.shorts) {
      redirectShortsPage();
      markShortsCards();
    }
    if (settings.autoplay) enforceAutoplay();
    if (settings.speed) applySpeed();

    if (ui) mountHost(ui.host);

    renderHomeBlocker();
    ui?.sync?.();
  }

  let applyTimer = null;
  function scheduleApply(delay = 120) {
    if (applyTimer) return;
    applyTimer = setTimeout(() => {
      applyTimer = null;
      applyNow();
    }, delay);
  }

  // ---------------------------------------------------------------------------
  // Styles
  // ---------------------------------------------------------------------------

  const CSS = `
    /* ---- Shorts, everywhere ---- */
    html[data-ytf-shorts="on"] ytd-reel-shelf-renderer,
    html[data-ytf-shorts="on"] ytd-rich-shelf-renderer[is-shorts],
    html[data-ytf-shorts="on"] ytd-rich-section-renderer:has(a[href^="/shorts/"]),
    html[data-ytf-shorts="on"] ytm-shorts-lockup-view-model,
    html[data-ytf-shorts="on"] ytm-shorts-lockup-view-model-v2,
    html[data-ytf-shorts="on"] ytd-reel-item-renderer,
    html[data-ytf-shorts="on"] ytd-guide-entry-renderer:has(a[href="/shorts"]),
    html[data-ytf-shorts="on"] ytd-mini-guide-entry-renderer[aria-label="Shorts"],
    html[data-ytf-shorts="on"] [data-ytf-shorts="1"] {
      display: none !important;
    }

    /* ---- Focus mode ---- */
    html[data-ytf-focus="on"] ytd-watch-flexy #secondary,
    html[data-ytf-focus="on"] ytd-watch-flexy #secondary-inner {
      display: none !important;
    }
    html[data-ytf-focus="on"] ytd-watch-flexy #primary {
      max-width: 100% !important;
    }
    html[data-ytf-focus="on"] ytd-watch-flexy #columns {
      max-width: 100% !important;
    }
    html[data-ytf-focus="on"] .ytp-ce-element,
    html[data-ytf-focus="on"] .ytp-endscreen-content,
    html[data-ytf-focus="on"] .ytp-suggestion-set,
    html[data-ytf-focus="on"] .ytp-autonav-endscreen,
    html[data-ytf-focus="on"] .ytp-cards-teaser,
    html[data-ytf-focus="on"] .ytp-pause-overlay {
      display: none !important;
    }

    /* ---- Home feed replacement ---- */
    html[data-ytf-home="on"] ytd-browse[page-subtype="home"] ytd-rich-grid-renderer {
      display: none !important;
    }
    #ytf-home {
      max-width: 560px;
      margin: 48px auto;
      padding: 28px 30px;
      border: 1px solid var(--yt-spec-10-percent-layer, rgba(0, 0, 0, .1));
      border-radius: 16px;
      font-family: Roboto, system-ui, sans-serif;
      color: var(--yt-spec-text-primary, #0f0f0f);
      background: var(--yt-spec-base-background, transparent);
    }
    #ytf-home h2 { margin: 0 0 6px; font-size: 20px; }
    #ytf-home p { margin: 0 0 16px; color: var(--yt-spec-text-secondary, #606060); line-height: 1.5; }
    #ytf-home button {
      padding: 9px 14px; border-radius: 999px; cursor: pointer;
      border: 1px solid var(--yt-spec-10-percent-layer, #ccc);
      background: transparent; color: inherit; font: inherit; font-weight: 500;
    }
    #ytf-home button:hover { background: var(--yt-spec-badge-chip-background, rgba(0, 0, 0, .05)); }
  `;

  function injectStyles() {
    if (document.getElementById('ytf-style')) return;
    const style = document.createElement('style');
    style.id = 'ytf-style';
    style.textContent = CSS;
    (document.head || document.documentElement).append(style);
  }

  // ---------------------------------------------------------------------------
  // Boot
  // ---------------------------------------------------------------------------

  function registerMenu() {
    if (typeof GM_registerMenuCommand !== 'function') return;
    for (const [key, name] of PANEL_LABELS) {
      GM_registerMenuCommand(`${settings[key] ? '[on]' : '[off]'} ${name}`, () => {
        setSetting(key, !settings[key]);
      });
    }
  }

  /**
   * @run-at document-start means document.documentElement can still be null for
   * a tick, so nothing here may assume the page exists.
   */
  function boot() {
    injectStyles();
    // Set the flags before first paint so hidden things never flash.
    applyNow();

    // YouTube's router fires these; the observer catches everything else
    // (lazy shelves, late sidebars, re-rendered metadata).
    const onNavigate = () => {
      autoplayFor = null;
      speedVideo = null;
      speedWindowStart = Date.now();
      scheduleApply(60);
      if (location.pathname === '/watch') startSpeedWatch();
    };

    for (const event of ['yt-navigate-start', 'yt-navigate-finish', 'yt-page-data-updated', 'yt-player-updated']) {
      document.addEventListener(event, onNavigate);
    }

    window.addEventListener('popstate', onNavigate);
    if (location.pathname === '/watch') startSpeedWatch();

    const observer = new MutationObserver(() => {
      if (document.hidden) return;
      scheduleApply();
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });

    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', () => {
        buildUi();
        ui?.sync?.();
      }, { once: true });
    } else {
      buildUi();
      ui?.sync?.();
    }

    scheduleApply(0);
  }

  let booted = false;
  const start = () => {
    if (booted || !document.documentElement) return;
    booted = true;
    boot();
  };

  if (document.documentElement) {
    start();
  } else {
    const ready = new MutationObserver(() => {
      if (!document.documentElement) return;
      ready.disconnect();
      start();
    });
    ready.observe(document, { childList: true, subtree: true });
    // In case the observer misses it, a timeout always lands.
    setTimeout(() => {
      ready.disconnect();
      start();
    }, 50);
  }

  // Keyboard: Alt+F toggles focus mode, Alt+J toggles the panel.
  document.addEventListener(
    'keydown',
    (event) => {
      if (!event.altKey || event.ctrlKey || event.metaKey) return;
      if (event.code === 'KeyF') {
        event.preventDefault();
        setSetting('focus', !settings.focus);
      } else if (event.code === 'KeyJ') {
        event.preventDefault();
        ui?.togglePanel?.();
      }
    },
    true
  );

  registerMenu();
})();

