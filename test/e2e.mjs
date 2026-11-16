/**
 * Loads youtube twice, once plain and once with the script injected, and checks
 * the difference. Also writes the screenshots in docs/.
 *
 *   npm i -D playwright
 *   node test/e2e.mjs
 *
 * PLAYWRIGHT_PATH, CHROME_PATH and HEADED=1 are optional.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { chromium } = require(process.env.PLAYWRIGHT_PATH || 'playwright');

const SCRIPT = fs.readFileSync(path.join(root, 'youtube-focus.user.js'), 'utf8');
const DOCS = path.join(root, 'docs');
fs.mkdirSync(DOCS, { recursive: true });

const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const HEADLESS = process.env.HEADED !== '1';

// A normal watch page with a full recommendation sidebar.
const WATCH_URL = process.env.WATCH_URL || 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';
const SECOND_URL = 'https://www.youtube.com/watch?v=vLAegkGGWrM';
const SEARCH_URL = 'https://www.youtube.com/results?search_query=funny+cats';

const AD_HOSTS = /(doubleclick|googlesyndication|googleadservices|adservice\.google)/i;
const failures = [];
const check = (name, ok, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? ` — ${extra}` : ''}`);
  if (!ok) failures.push(name);
};

async function newContext(browser, withScript) {
  const context = await browser.newContext({
    locale: 'en-US',
    viewport: { width: 1280, height: 900 },
    colorScheme: 'light',
  });
  await context.addCookies([
    { name: 'SOCS', value: 'CAI', domain: '.youtube.com', path: '/' },
    { name: 'PREF', value: 'hl=en', domain: '.youtube.com', path: '/' },
  ]);
  const page = await context.newPage();
  await page.route(AD_HOSTS, (route) => route.abort());
  if (withScript) await page.addInitScript({ content: SCRIPT });
  return page;
}

async function waitForWatch(page) {
  await page.goto(WATCH_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForSelector('#info-contents #info-strings', { timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(3500);
}

/** Pauses on a stable frame so screenshots are comparable. */
async function freezeFrame(page) {
  await page.evaluate(() => {
    const video = document.querySelector('video.html5-main-video');
    if (!video) return;
    try {
      video.pause();
      video.currentTime = 60;
    } catch {
      /* the player may still be initialising */
    }
  });
  await page.waitForTimeout(1400);
  // youtube sometimes puts a "how are your recommendations today?" survey over
  // the sidebar, so close it before the shot.
  await page.evaluate(() => {
    const text = [...document.querySelectorAll('ytd-popup-container *')].find((el) =>
      el.textContent.trim().startsWith('How are your recommendations')
    );
    if (!text) return;
    const dialog = text.closest('tp-yt-paper-dialog') || text.closest('ytd-popup-container');
    dialog?.remove();
  });
  await page.waitForTimeout(300);
}

async function watchState(page) {
  return page.evaluate(() => {
    const visible = (selector) => {
      const el = document.querySelector(selector);
      if (!el) return false;
      const style = getComputedStyle(el);
      return style.display !== 'none' && style.visibility !== 'hidden' && el.getClientRects().length > 0;
    };
    return {
      relatedVisible: visible('#secondary ytd-watch-next-secondary-results-renderer, #secondary #related'),
      secondaryDisplay: getComputedStyle(document.querySelector('#secondary') || document.body).display,
      autoplay: document.querySelector('.ytp-autonav-toggle-button')?.getAttribute('aria-checked') ?? null,
      rate: document.querySelector('video.html5-main-video')?.playbackRate ?? null,
      settings: { ...document.documentElement.dataset },
    };
  });
}

const browser = await chromium.launch({
  executablePath: CHROME,
  headless: HEADLESS,
  args: ['--autoplay-policy=user-gesture-required'],
});

// --- before -----------------------------------------------------------------
const before = await newContext(browser, false);
await waitForWatch(before);
await freezeFrame(before);
const beforeState = await watchState(before);
await before.screenshot({ path: path.join(DOCS, 'before-watch.png') });

// --- after ------------------------------------------------------------------
const after = await newContext(browser, true);
await waitForWatch(after);
await freezeFrame(after);
const afterState = await watchState(after);
await after.screenshot({ path: path.join(DOCS, 'after-watch.png') });

check(
  'focus mode hides the "up next" sidebar',
  beforeState.relatedVisible && afterState.secondaryDisplay === 'none'
);
check('autoplay is switched off', afterState.autoplay === 'false', `aria-checked=${afterState.autoplay}`);
check(
  'page flags are applied',
  afterState.settings.ytfFocus === 'on' && afterState.settings.ytfShorts === 'on'
);

// --- playback speed is remembered ---------------------------------------------
await after.evaluate(() => {
  document.querySelector('video.html5-main-video').playbackRate = 1.5;
});
await after.waitForTimeout(600);
const saved = await after.evaluate(() => localStorage.getItem('ytf:speed:v1'));
check('choosing a speed stores it', saved === '1.5', `stored=${saved}`);

await after.goto(SECOND_URL, { waitUntil: 'domcontentloaded' });
await after.waitForSelector('video.html5-main-video', { timeout: 30000 });
await after.waitForTimeout(4000);
const rateAfterNav = await after.evaluate(() => document.querySelector('video.html5-main-video').playbackRate);
const chipText = await after.evaluate(
  () => document.querySelector('#ytf-root')?.shadowRoot?.querySelector('.ytf-speed')?.textContent ?? null
);
check('the next video starts at the remembered speed', Math.abs(rateAfterNav - 1.5) < 0.01, `rate=${rateAfterNav}`);
check('the speed chip shows the current rate', chipText === '1.5×', `chip=${chipText}`);
await after.screenshot({ path: path.join(DOCS, 'after-speed.png') });

// --- search page: Shorts shelf -------------------------------------------------
async function searchState(page) {
  await page.goto(SEARCH_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(5000);
  const state = await page.evaluate(() => {
    const boxes = (selector) =>
      [...document.querySelectorAll(selector)].filter((el) => el.getClientRects().length > 0).length;
    return {
      reelShelves: boxes('grid-shelf-view-model, ytd-reel-shelf-renderer'),
      shortsCards: boxes('ytd-reel-item-renderer, ytm-shorts-lockup-view-model, ytm-shorts-lockup-view-model-v2'),
      videoResults: boxes('ytd-video-renderer, yt-lockup-view-model'),
    };
  });
  await page.screenshot({ path: path.join(DOCS, 'after-search.png') });
  return state;
}

const beforeSearch = await searchState(before);
await before.screenshot({ path: path.join(DOCS, 'before-search.png') });
const afterSearch = await searchState(after);

check(
  'the Shorts shelf disappears from search',
  beforeSearch.reelShelves === 0 || (afterSearch.reelShelves === 0 && afterSearch.shortsCards === 0),
  `before=${beforeSearch.reelShelves} after=${afterSearch.reelShelves}/${afterSearch.shortsCards}`
);
check('normal video results are untouched', afterSearch.videoResults > 0, `${afterSearch.videoResults} results`);

// --- Shorts URL redirect -------------------------------------------------------
await after.goto('https://www.youtube.com/shorts/X4dGtpUD3gA', { waitUntil: 'domcontentloaded' });
await after.waitForTimeout(3000);
check('a Shorts URL becomes a normal watch page', after.url().includes('/watch?v=X4dGtpUD3gA'), after.url());

// --- settings panel ------------------------------------------------------------
await waitForWatch(after);
const pill = after.locator('#ytf-root .ytf-pill');
await pill.click();
const panelOpen = await after.evaluate(
  () => !document.querySelector('#ytf-root').shadowRoot.querySelector('.ytf-panel').hidden
);
check('the settings panel opens', panelOpen);
await after.screenshot({ path: path.join(DOCS, 'settings-panel.png') });

await after.evaluate(() => {
  const input = document.querySelector('#ytf-root').shadowRoot.querySelector('input[data-key="shorts"]');
  input.checked = false;
  input.dispatchEvent(new Event('change', { bubbles: true }));
});
await after.waitForTimeout(400);
check(
  'turning a setting off updates the page immediately',
  await after.evaluate(() => document.documentElement.dataset.ytfShorts === 'off')
);

await after.evaluate(() => {
  const input = document.querySelector('#ytf-root').shadowRoot.querySelector('input[data-key="shorts"]');
  input.checked = true;
  input.dispatchEvent(new Event('change', { bubbles: true }));
});

await browser.close();

console.log(`\n${failures.length ? `${failures.length} check(s) failed: ${failures.join(', ')}` : 'All checks passed.'}`);
process.exitCode = failures.length ? 1 : 0;
