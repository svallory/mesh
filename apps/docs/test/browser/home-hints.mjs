// Run with Node inside mcr.microsoft.com/playwright:v1.56.0-noble after a site
// build. PLAYWRIGHT_MODULE points to an external Playwright 1.56.0 installation;
// SITE_DIR and SHOTS_DIR are absolute paths. No dependency or server is retained.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, stat, mkdir } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
import { tmpdir } from 'node:os';

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = resolve(process.env.SITE_DIR || 'apps/docs/site');
const shots = resolve(process.env.SHOTS_DIR || resolve(tmpdir(), 'mesh-home-hints-shots'));
await mkdir(shots, { recursive: true });
const mime = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.json': 'application/json', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.png': 'image/png' };
const server = createServer(async (req, res) => {
  try {
    let file = resolve(root, '.' + decodeURIComponent(new URL(req.url, 'http://localhost').pathname));
    if (file !== root && !file.startsWith(root + sep)) throw new Error('outside site');
    if ((await stat(file)).isDirectory()) file = resolve(file, 'index.html');
    res.writeHead(200, { 'Content-Type': mime[extname(file)] || 'application/octet-stream' });
    res.end(await readFile(file));
  } catch { res.writeHead(404); res.end(); }
});
await new Promise((done) => server.listen(0, '127.0.0.1', done));
const base = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
let checks = 0;
const check = (value, message) => { assert.ok(value, message); checks++; };
const same = (actual, expected, message) => { assert.deepEqual(actual, expected, message); checks++; };
const errors = [];
const panel = (page) => page.locator('.mh-hint-panel:not([hidden])');
const hint = (page, key) => page.locator(`.mh-hint[data-hint="${key}"]`).first();
async function opened(page, key) {
  await page.waitForFunction((key) => document.querySelector(`.mh-hint[data-hint="${key}"][aria-expanded="true"]`), key);
  same(await panel(page).count(), 1, 'exactly one visible hint box');
  same(await page.locator('.mh-hint[aria-expanded="true"]').count(), 1, 'exactly one active token');
  same(await panel(page).textContent(), await page.locator(`#mh-hint-${key}`).textContent(), 'box matches the static description');
  same(await panel(page).locator(':scope > :first-child').getAttribute('class'), 'mh-hint-family', 'family sentence first');
  const context = panel(page).locator('.mh-hint-context');
  if (await context.count()) same(await panel(page).locator(':scope > :last-child').getAttribute('class'), 'mh-hint-context', 'context sentence second');
  check(!(await panel(page).textContent()).includes('`'), 'no raw backticks in box');
}
async function closed(page) {
  await page.waitForFunction(() => !document.querySelector('.mh-hint-panel:not([hidden])'));
  same(await page.locator('.mh-hint[aria-expanded="true"]').count(), 0, 'no stale expanded token');
  same(await page.locator('.mh-hint-connector,.mh-hint-destination').count(), 0, 'connector and outline cleaned up');
  same(await page.evaluate(() => window.hintObserversActive), 0, 'no home-hint mutation observer while closed');
}
async function connected(page, key, anchor) {
  await opened(page, key);
  const svg = page.locator('.mh-hint-connector');
  same(await svg.count(), 1, 'one SVG overlay');
  check((await svg.locator('path').getAttribute('d')).startsWith('M '), 'connector has a path');
  same(await svg.evaluate((n) => getComputedStyle(n).pointerEvents), 'none', 'overlay cannot intercept hover/tap');
  check((await svg.evaluate((n) => getComputedStyle(n).strokeDasharray)) !== 'none', 'connector is dashed');
  same(await page.locator('.mh-hint-destination').getAttribute('data-hint-anchor'), anchor, 'correct outlined destination');
  same(await page.locator('.mh-hint-destination').evaluate((n) => getComputedStyle(n).outlineStyle), 'dashed', 'destination outline is dashed');
  same(await page.evaluate(() => window.hintObserversActive), 1, 'one mutation observer while open');
}
// Instrument only this controller's observer, not docmd's own SPA observers.
// Counts distinguish a dormant observer instance from a document-wide watch.
function observerProbe() {
  window.hintObserversActive = 0;
  const Original = window.MutationObserver;
  window.MutationObserver = class extends Original {
    constructor(callback) { super(callback); this.hint = callback.toString().includes('open.isConnected'); this.active = false; }
    observe(...args) { super.observe(...args); if (this.hint && !this.active) { window.hintObserversActive++; this.active = true; } }
    disconnect() { super.disconnect(); if (this.hint && this.active) { window.hintObserversActive--; this.active = false; } }
  };
}
async function bounded(page) {
  const r = await panel(page).boundingBox();
  const viewport = page.viewportSize();
  check(r.x >= 0 && r.y >= 0 && r.x + r.width <= viewport.width && r.y + r.height <= viewport.height, 'hint stays in viewport');
}
async function theme(page, value) {
  await page.evaluate((theme) => { document.documentElement.dataset.theme = theme; }, value);
}
async function stage(page) {
  await page.locator('.mh-file-code').evaluate((pre) => {
    window.scrollTo(0, window.scrollY + pre.getBoundingClientRect().top - 90);
  });
}
try {
  const desktop = await browser.newContext({ viewport: { width: 1280, height: 1000 } });
  await desktop.addInitScript(observerProbe);
  const page = await desktop.newPage();
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(base);
  await page.waitForSelector('.mh-hint');
  // Every authored token has its own accessible description; every actual focus
  // event must open it (including repeated input/title tokens).
  const tokens = page.locator('.mh-hint');
  const count = await tokens.count();
  for (let i = 0; i < count; i++) {
    const token = tokens.nth(i);
    const key = await token.getAttribute('data-hint');
    await token.focus();
    await opened(page, key);
  }
  const descriptions = await page.locator('.mh-hint-notes > span').count();
  const rows = await page.locator('.mh-l:has(.mh-hint)').count();
  same(await page.locator('.mh-hint[tabindex="0"]').count(), rows, 'one tab stop per nonblank row');
  for (const row of await page.locator('.mh-l:has(.mh-hint)').all()) same(await row.locator('.mh-hint[tabindex="0"]').count(), 1, 'each row has exactly one tab stop');
  console.log(`Keyboard coverage: ${count} independent tokens, ${descriptions} descriptions, ${rows} tab stops`);
  await page.keyboard.press('Escape');
  await closed(page);
  await page.evaluate(() => document.activeElement.blur());
  await stage(page);
  await hint(page, 'title').hover();
  await opened(page, 'title');
  await bounded(page);
  await connected(page, 'title', 'attribute-title');
  await page.screenshot({ path: `${shots}/home-title-1280-light.png` });
  await hint(page, 'list').hover();
  await connected(page, 'list', 'relationship');
  await bounded(page);
  await page.screenshot({ path: `${shots}/home-list-1280-light.png` });
  await theme(page, 'dark');
  await page.screenshot({ path: `${shots}/home-list-1280-dark.png` });
  await hint(page, 'types-create').hover();
  await connected(page, 'types-create', 'action-create');
  // Same-line auto atoms retain the outline but cannot loop back onto their
  // own row. Moving from/to a policy atom must remove/restore the shared path.
  for (const type of ['read', 'destroy']) {
    await hint(page, `auto-${type}`).hover();
    await opened(page, `auto-${type}`);
    same(await page.locator('.mh-hint-destination').getAttribute('data-hint-anchor'), 'actions', 'same-line destination remains outlined');
    same(await page.locator('.mh-hint-destination').evaluate((n) => getComputedStyle(n).outlineStyle), 'dashed', 'same-line outline remains dashed');
    same(await page.locator('.mh-hint-connector').count(), 0, 'same-line reference has no path');
    await hint(page, `types-${type}`).hover();
    await connected(page, `types-${type}`, 'actions');
  }
  for (const value of ['light', 'dark']) {
    await theme(page, value);
    const colours = await page.evaluate(() => ['.ts-member', '.ts-name', '.ts-atom'].map((selector) => {
      const node = document.querySelector('.mh-file-code ' + selector);
      return node && getComputedStyle(node).color;
    }));
    check(colours.every(Boolean) && new Set(colours).size === 3, `members/names/atoms distinct in ${value}`);
    await hint(page, 'list').hover();
    same(await panel(page).locator('.mh-hint-family .ts-member').evaluate((n) => getComputedStyle(n).color), colours[0], `box members use file palette in ${value}`);
    await hint(page, 'types-create').hover();
    same(await panel(page).locator('.mh-hint-family .ts-atom').evaluate((n) => getComputedStyle(n).color), colours[2], `box atoms use file palette in ${value}`);
  }
  // Hover disappears when leaving both the token and its box.
  await page.mouse.move(1250, 950);
  await closed(page);
  await hint(page, 'title').hover();
  await opened(page, 'title');
  await panel(page).hover();
  await opened(page, 'title');
  // Click pins; unrelated hover cannot steal it; second click toggles closed.
  await hint(page, 'title').click();
  await hint(page, 'list').hover();
  await opened(page, 'title');
  await hint(page, 'title').click();
  await closed(page);
  // Tab dismisses a pinned token; the next token opens its own unpinned note.
  await hint(page, 'title').click();
  await page.keyboard.press('Tab');
  same(await hint(page, 'title').getAttribute('aria-expanded'), 'false', 'Tab closes the pinned source');
  await opened(page, 'list');
  await page.keyboard.press('Escape');
  await closed(page);
  // Leaving the file also dismisses a keyboard-pinned note.
  await tokens.last().focus();
  await page.keyboard.press('Enter');
  await opened(page, 'family-function');
  await page.keyboard.press('Tab');
  await closed(page);
  check(await page.evaluate(() => !document.activeElement.closest('.mh-file-code')), 'Tab leaves the file');
  // The sole exception is focus inside the box (no focusable content today).
  await hint(page, 'title').focus();
  await page.keyboard.press('Enter');
  await panel(page).evaluate((box) => {
    const button = document.createElement('button');
    button.textContent = 'Focus fixture';
    box.append(button);
    button.focus();
  });
  same(await hint(page, 'title').getAttribute('aria-expanded'), 'true', 'focus inside the box retains the pinned note');
  same(await panel(page).count(), 1, 'box stays visible while it contains focus');
  await page.keyboard.press('Tab');
  await closed(page);
  await hint(page, 'title').click();
  await page.mouse.click(1250, 950);
  await closed(page);
  await hint(page, 'title').click();
  await page.keyboard.press('Escape');
  await closed(page);
  await page.keyboard.press('Tab');
  await opened(page, 'list');
  await page.keyboard.press('Enter');
  await opened(page, 'list');
  await page.keyboard.press('Enter');
  await closed(page);
  // Roving within one row: arrows wrap; Home/End jump; Tab goes to next row.
  await page.keyboard.press('Home');
  await hint(page, 'entity').focus();
  await opened(page, 'entity');
  await page.keyboard.press('ArrowRight');
  await opened(page, 'entity-name');
  await page.keyboard.press('End');
  await opened(page, 'family-string');
  await page.keyboard.press('ArrowRight');
  await opened(page, 'entity');
  await page.keyboard.press('ArrowLeft');
  await opened(page, 'family-string');
  await page.keyboard.press('Home');
  await opened(page, 'entity');
  await page.keyboard.press('Tab');
  await opened(page, 'attributes');
  await page.keyboard.press('Escape');
  await closed(page);
  // Existing card tinting still reaches source sections.
  await page.locator('.mh-box[data-box="types"]').hover();
  const tint = await page.locator('.mh-sec[data-section="attributes"]').evaluate((n) => getComputedStyle(n).backgroundColor);
  check(tint !== 'rgba(0, 0, 0, 0)', 'card still tints the source');
  // SPA replacement removes stale boxes and delegation survives a replacement.
  await hint(page, 'title').click();
  await opened(page, 'title');
  // Don't synthesize a fresh hover on the new token under a stationary pointer.
  await page.mouse.move(1250, 950);
  await page.locator('.mh-file-code').evaluate((pre) => {
    const fresh = pre.cloneNode(true);
    fresh.querySelectorAll('[aria-expanded]').forEach((node) => node.setAttribute('aria-expanded', 'false'));
    // A server-rendered replacement has no transient controller outline.
    fresh.querySelectorAll('.mh-hint-destination').forEach((node) => node.classList.remove('mh-hint-destination'));
    pre.replaceWith(fresh);
  });
  await closed(page);
  await hint(page, 'title').hover();
  await opened(page, 'title');
  await page.keyboard.press('Escape');
  await closed(page);
  // Replacing the entire body must not leave the singleton panel detached.
  await hint(page, 'list').click();
  await connected(page, 'list', 'relationship');
  await page.mouse.move(1250, 950);
  await page.evaluate(() => {
    const body = document.body.cloneNode(true);
    body.querySelectorAll('.mh-hint-panel,.mh-hint-connector').forEach((n) => n.remove());
    body.querySelectorAll('.mh-hint-destination').forEach((n) => n.classList.remove('mh-hint-destination'));
    body.querySelectorAll('.mh-hint').forEach((n) => n.setAttribute('aria-expanded', 'false'));
    document.body.replaceWith(body);
  });
  await closed(page);
  await hint(page, 'list').hover();
  await connected(page, 'list', 'relationship');
  same(await page.locator('.mh-hint-panel').count(), 1, 'panel recreated exactly once after body replacement');
  // Resize and scroll recalculate coordinates while a pinned box stays open.
  await hint(page, 'list').click();
  await page.setViewportSize({ width: 1250, height: 980 });
  await connected(page, 'list', 'relationship');
  await bounded(page);
  await page.evaluate(() => window.scrollBy(0, 12));
  await connected(page, 'list', 'relationship');
  await page.keyboard.press('Escape');
  await closed(page);
  await page.setViewportSize({ width: 1280, height: 1000 });
  await page.goto(base + '/docs/entities/');
  const entityCode = page.locator('pre.mx-hl').filter({ hasText: 'entity :Todo' }).first();
  check(await entityCode.locator('.ts-member').count() > 0, 'ordinary Entities mx fence colours members');
  await entityCode.evaluate((pre) => window.scrollTo(0, window.scrollY + pre.getBoundingClientRect().top - 80));
  await theme(page, 'light');
  await page.screenshot({ path: `${shots}/entities-1280-light.png` });
  await page.goto(base + '/docs/');
  check(await page.locator('.mx-figure .ts-member').count() > 0, 'Introduction figure colours members too');
  await desktop.close();

  const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 1 });
  await phone.addInitScript(observerProbe);
  const mobile = await phone.newPage();
  mobile.on('pageerror', (error) => errors.push(error.message));
  await mobile.goto(base);
  await stage(mobile);
  await hint(mobile, 'types-create').tap();
  await connected(mobile, 'types-create', 'action-create');
  await bounded(mobile);
  await mobile.screenshot({ path: `${shots}/home-create-390-light.png` });
  await theme(mobile, 'dark');
  await mobile.screenshot({ path: `${shots}/home-create-390-dark.png` });
  await hint(mobile, 'types-create').tap();
  await closed(mobile);
  await hint(mobile, 'list').tap();
  await opened(mobile, 'list');
  await bounded(mobile);
  await mobile.touchscreen.tap(380, 820);
  await closed(mobile);
  // A long explanation near a viewport edge, and the bottom-most expression.
  for (const key of ['family-import', 'relationship', 'authorize']) {
    await hint(mobile, key).tap();
    await opened(mobile, key);
    await bounded(mobile);
    await mobile.keyboard.press('Escape');
    await closed(mobile);
  }
  // A small scrollable file models a short viewport: keep the reference in
  // view but its declaration outside the clipping area. Only outline it.
  await mobile.locator('.mh-file-code').evaluate((pre) => { pre.style.maxHeight = '120px'; pre.style.overflowY = 'auto'; });
  await hint(mobile, 'types-create').tap();
  await opened(mobile, 'types-create');
  same(await mobile.locator('.mh-hint-destination').getAttribute('data-hint-anchor'), 'action-create', 'offscreen target still outlined');
  same(await mobile.locator('.mh-hint-connector').count(), 0, 'no connector to clipped target');
  await mobile.keyboard.press('Escape');
  await closed(mobile);
  await mobile.locator('.mh-file-code').evaluate((pre) => { pre.style.maxHeight = ''; pre.style.overflowY = ''; pre.scrollTop = 0; });
  same(await mobile.locator('.mh-file-code').evaluate((pre) => getComputedStyle(pre.closest('.grid-item')).position), 'sticky', 'phone stage stays sticky');
  same(await mobile.locator('.mh-box').first().evaluate((n) => getComputedStyle(n).position), 'sticky', 'phone cards stay sticky');
  const width = await mobile.evaluate(() => document.documentElement.scrollWidth);
  check(width <= 390, 'no horizontal page overflow');
  await phone.close();
  same(errors, [], 'no page errors');
  console.log(`PASS: ${checks} browser assertions; six screenshots in ${shots}`);
} finally {
  await browser.close();
  await new Promise((done) => server.close(done));
}
