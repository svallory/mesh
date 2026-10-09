// Run inside mcr.microsoft.com/playwright:v1.56.0-noble after a docs build.
// PLAYWRIGHT_MODULE: external Playwright 1.56.0 module; SITE_DIR: built site;
// SHOTS_DIR: required absolute artifact directory. BEFORE=1 captures the ADR
// before the heading fix; otherwise assertions cover the finished site.
// The HTTP server is private to this short-lived process and closes in finally.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, stat, mkdir } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';

if (!process.env.SHOTS_DIR) throw new Error('Set SHOTS_DIR to an artifact directory');
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = resolve(process.env.SITE_DIR || 'apps/docs/site');
const shots = resolve(process.env.SHOTS_DIR);
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
let browser;
let checks = 0;
const equal = (actual, expected) => { assert.deepEqual(actual, expected); checks++; };
const check = (condition, label) => { assert.ok(condition, label); checks++; };
const before = process.env.BEFORE === '1';
const adr = '/architecture/decisions/0057-one-domain-modules-as-folders/';
try {
  browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  for (const theme of ['light', 'dark']) {
    const context = await browser.newContext({ viewport: { width: 1280, height: 1000 }, colorScheme: theme });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(base + adr);
    await page.waitForSelector('h1.docmd-heading code');
    await page.screenshot({ path: `${shots}/adr-title-${before ? 'before' : 'after'}-1280-${theme}.png` });
    if (before) { await context.close(); continue; }
    equal(await page.locator('html').getAttribute('data-theme'), theme);
    const metrics = await page.locator('h1.docmd-heading code').evaluate((code) => {
      const style = getComputedStyle(code), heading = getComputedStyle(code.closest('h1'));
      return { size: parseFloat(style.fontSize), headingSize: parseFloat(heading.fontSize), weight: style.fontWeight, headingWeight: heading.fontWeight, display: style.display, headingDisplay: heading.display };
    });
    check(Math.abs(metrics.size / metrics.headingSize - 0.85) < 0.01, 'code scales with heading');
    equal(metrics.weight, metrics.headingWeight);
    equal(metrics.display, 'inline');
    equal(metrics.headingDisplay, 'block');
    for (const selector of ['.nav-item-title', '.header-title', '.docmd-focus-title', '.toc-link']) {
      check(!(await page.locator(selector).allTextContents()).some((text) => text.includes('`')), `${selector} has no raw backticks`);
    }
    await page.goto(base + '/architecture/decisions/');
    check(!(await page.locator('.main-content a').allTextContents()).some((text) => text.includes('`')), 'ADR index links have no raw backticks');
    await page.screenshot({ path: `${shots}/adr-index-1280-${theme}.png` });

    await page.goto(base + '/docs/quick-start/');
    const title = page.locator('.sidebar-header h1 a');
    equal((await title.innerText()).trim(), 'Mesh');
    equal(new URL(await title.getAttribute('href'), page.url()).pathname, '/');
    const colours = await title.evaluate((node) => ({ title: getComputedStyle(node).color, body: getComputedStyle(document.body).color }));
    equal(colours.title, colours.body);
    const group = page.locator('li.nav-group').filter({ has: page.locator(':scope > .nav-label', { hasText: 'Your first project' }) });
    // docmd may leave an inactive subgroup collapsed; open it as a reader would.
    equal(await group.count(), 1);
    if (await group.getAttribute('aria-expanded') !== 'true') await group.locator(':scope > .nav-label').click();
    equal((await group.locator('a .nav-item-title').allTextContents()).map((text) => text.trim()), [
      'Project structure', 'Entities', 'Using your domain', 'Testing', 'Configuration',
    ]);
    await page.screenshot({ path: `${shots}/quick-start-top-1280-${theme}.png` });
    await page.locator('.sidebar').screenshot({ path: `${shots}/sidebar-1280-${theme}.png` });
    await title.click();
    await page.waitForURL(base + '/');
    check(await page.locator('.mh-title').isVisible(), 'site title reaches home');
    equal(errors, []);
    await context.close();
  }
  console.log(`${checks} browser assertions passed; ${before ? 'before' : 'final'} screenshots saved to ${shots}`);
} finally {
  await browser?.close();
  await new Promise((done) => server.close(done));
}
