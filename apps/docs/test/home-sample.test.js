// Home is a deliberate excerpt of the full flagship (lead correction, 2026-10-09).
// All shared lines must agree; Intro/Quick start/Tutorial are byte-identical.
import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { highlightMx, mxParseProblems } from '../plugins/mx-highlight.js';
import { renderMxFlow } from '../plugins/mesh-home.js';
import { oldSpellingInV4, parseV4 } from '../../../packages/compiler/test/repository-checks.ts';

const page = readFileSync(new URL('../docs/index.md', import.meta.url), 'utf8');
const docsPage = (name) => readFileSync(new URL(`../docs/docs/${name}`, import.meta.url), 'utf8');
const fences = [...page.matchAll(/^```mx(?:-flow)?(?:[ \t][^\n]*)?\n([\s\S]*?)^```[ \t]*$/gm)].map((m) => m[1]);
const todo = (name) => /```mx "src\/domain\/todo\/todo.mesh.mx"\n([\s\S]*?)```/.exec(docsPage(name))[1];
const intro = /```mx-figure\n([\s\S]*?)```/.exec(docsPage('index.md'))[1]
  .split('\n').filter((line) => !/^\s*\/\/\s*@/.test(line)).join('\n');

test('the home excerpt uses v4 and every nonblank line occurs in order in the full file', () => {
  expect(fences).toHaveLength(1);
  expect(fences[0]).toStartWith('import { List } from "./list.mesh.mx"\n');
  expect(createHash('sha256').update(fences[0]).digest('hex')).toBe('ad19a0f0112a3d92e92a7c6fc0827ca4f203c554388279c9f0cade65eb8092eb');
  expect(oldSpellingInV4(fences[0])).toBeNull();
  expect(parseV4(fences[0], 'home.mx')).toEqual([]);
  expect(fences[0]).toContain('belongs-to :list entity=List');
  expect(fences[0]).toContain('create :create\n      input\n        &title\n        &list');
  let at = -1;
  const full = todo('quick-start.md').split('\n');
  for (const line of fences[0].split('\n').filter((line) => line.trim())) {
    const next = full.findIndex((candidate, index) => index > at && candidate === line);
    expect(next).toBeGreaterThan(at);
    at = next;
  }
});

test('the three full flagship files are byte-identical, including blank lines', () => {
  const files = [intro, todo('quick-start.md'), todo('tutorial.md'), todo('entities.md')];
  expect(new Set(files).size).toBe(1);
  console.log('Flagship SHA-256:', createHash('sha256').update(files[0]).digest('hex'));
});

test('home highlights and the relationship carries the generated-key token hint', () => {
  expect(mxParseProblems(fences[0], 'docs/index.md')).toEqual([]);
  expect(highlightMx(fences[0])).toContain('<span class="ts-tag">entity</span>');
  const html = renderMxFlow(fences[0], 'docs/index.md');
  expect(html).not.toContain(' title=');
  expect(html).toContain('aria-describedby="mh-hint-relationship"');
  expect(html.split('id="mh-hint-relationship"').length - 1).toBe(1);
  expect(html).toContain('Creates the <code>listId</code> column; <code>&amp;list</code> in <code>input</code> is how the caller sets it.');
  expect(html).toContain('tabindex="0"');
  expect(page).toContain('listId: string');
  expect(page).toContain('list: List["id"]');
  expect(page).toContain('insertedAt: Date');
});

test('home line count and the planted typo position match its file', () => {
  const lines = fences[0].trimEnd().split('\n');
  expect(page).toContain(`It writes the ${lines.length} lines of <code>todo.mesh.mx</code> above.`);
  const row = lines.findIndex((line) => line.trim() === '&title');
  const column = lines[row].indexOf('&title') + 1;
  expect(page).toContain(`src/domain/todo/todo.mesh.mx:${row + 1}:${column} error &amp;titel`);
  for (const name of ['createTodo', 'renameTodo', 'pendingTodo', 'readTodo', 'destroyTodo']) expect(page).toContain(name);
});

test('cards name real sections and the same groups; the headline keeps its two blocks', async () => {
  const { FLOW_SECTIONS } = await import('../plugins/mesh-home.js');
  const boxes = [...page.matchAll(/<div class="mh-box" data-box="([a-z]+)" data-from="([a-z ]+)"(?: data-via="[^"]*")? data-group="([^"]+)"/g)];
  expect(boxes.map((m) => m[1])).toEqual(['types', 'functions', 'validation', 'authorization', 'table', 'migrations', 'rules', 'model']);
  for (const [, , from] of boxes) for (const part of from.split(' ')) expect(FLOW_SECTIONS).toContain(part);
  expect([...new Set(boxes.map((m) => m[3]))]).toEqual(['Your app', 'The database', 'For your tools']);
  expect(page).not.toContain('What you call');
  expect(page).not.toContain('```ts');
  expect(page).toContain('<h1 id="mh-title" class="mh-title"><span>Describe your domain once.</span> <span>Mesh builds the rest.</span></h1>');
});

test('rules box quotes the rules sample and diagnostics quote Configuration', () => {
  const rules = /## The rules file[\s\S]*?```text\n([\s\S]*?)```/.exec(docsPage('ai-agents.md'))[1];
  const box = /data-box="rules"[\s\S]*?<div class="mh-snip"><code>([\s\S]*?)<\/code><\/div>/.exec(page)[1].replace(/&amp;/g, '&');
  for (const line of box.split('\n')) expect(rules).toContain(line.trim());
  const message = 'error &titel is not a member of :Todo. Did you mean &title?';
  expect(docsPage('configuration.md')).toContain(message);
  expect(page.replace(/&amp;/g, '&').replace(/\n/g, ' ')).toContain(message);
});
