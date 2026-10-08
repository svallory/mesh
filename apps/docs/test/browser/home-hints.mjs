// Run with Node inside mcr.microsoft.com/playwright:v1.56.0-noble after a site
// build. PLAYWRIGHT_MODULE points to an external Playwright 1.56.0 installation;
// SITE_DIR and SHOTS_DIR are absolute paths. No dependency or server is retained.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, stat, mkdir } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = resolve(process.env.SITE_DIR || 'apps/docs/site');
const shots = resolve(process.env.SHOTS_DIR || 'home-hints-shots');
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
  same(await panel(page).innerText(), await page.locator(`#mh-hint-${key}`).innerText(), 'box matches the static description');
}
async function closed(page) {
  await page.waitForFunction(() => !document.querySelector('.mh-hint-panel:not([hidden])'));
  same(await page.locator('.mh-hint[aria-expanded="true"]').count(), 0, 'no stale expanded token');
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
  console.log(`Keyboard coverage: ${count} independent tokens, 22 descriptions`);
  await page.keyboard.press('Escape');
  await closed(page);
  await page.evaluate(() => document.activeElement.blur());
  await stage(page);
  await hint(page, 'title').hover();
  await opened(page, 'title');
  await bounded(page);
  await page.screenshot({ path: `${shots}/home-1280-light.png` });
  await theme(page, 'dark');
  await page.screenshot({ path: `${shots}/home-1280-dark.png` });
  for (const value of ['light', 'dark']) {
    await theme(page, value);
    const colours = await page.evaluate(() => ['.ts-member', '.ts-name', '.ts-atom'].map((selector) => {
      const node = document.querySelector('.mh-file-code ' + selector);
      return node && getComputedStyle(node).color;
    }));
    check(colours.every(Boolean) && new Set(colours).size === 3, `members/names/atoms distinct in ${value}`);
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
  await hint(page, 'title').click();
  await page.keyboard.press('Escape');
  await closed(page);
  await page.keyboard.press('Tab');
  await opened(page, 'list');
  await page.keyboard.press('Enter');
  await opened(page, 'list');
  await page.keyboard.press('Enter');
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
    pre.replaceWith(fresh);
  });
  await closed(page);
  await hint(page, 'title').hover();
  await opened(page, 'title');
  await page.keyboard.press('Escape');
  await closed(page);
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
  const mobile = await phone.newPage();
  mobile.on('pageerror', (error) => errors.push(error.message));
  await mobile.goto(base);
  await stage(mobile);
  await hint(mobile, 'title').tap();
  await opened(mobile, 'title');
  await bounded(mobile);
  await mobile.screenshot({ path: `${shots}/home-390-light.png` });
  await theme(mobile, 'dark');
  await mobile.screenshot({ path: `${shots}/home-390-dark.png` });
  await hint(mobile, 'title').tap();
  await closed(mobile);
  await hint(mobile, 'list').tap();
  await opened(mobile, 'list');
  await bounded(mobile);
  await mobile.touchscreen.tap(380, 820);
  await closed(mobile);
  // A long explanation near a viewport edge, and the bottom-most expression.
  for (const key of ['import', 'relationship', 'authorize']) {
    await hint(mobile, key).tap();
    await opened(mobile, key);
    await bounded(mobile);
    await mobile.keyboard.press('Escape');
    await closed(mobile);
  }
  same(await mobile.locator('.mh-file-code').evaluate((pre) => getComputedStyle(pre.closest('.grid-item')).position), 'sticky', 'phone stage stays sticky');
  same(await mobile.locator('.mh-box').first().evaluate((n) => getComputedStyle(n).position), 'sticky', 'phone cards stay sticky');
  const width = await mobile.evaluate(() => document.documentElement.scrollWidth);
  check(width <= 390, 'no horizontal page overflow');
  await phone.close();
  same(errors, [], 'no page errors');
  console.log(`PASS: ${checks} browser assertions; five screenshots in ${shots}`);
} finally {
  await browser.close();
  await new Promise((done) => server.close(done));
}
