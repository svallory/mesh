import { expect, test } from 'bun:test';
import { createRequire } from 'node:module';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseMxFigure, renderMxFigure, figureStyles, installMxFigure } from '../plugins/mx-figure.js';

// Resolve docmd's own parser, rather than pinning a second markdown implementation.
const require = createRequire(import.meta.url);
const coreRequire = createRequire(require.resolve('@docmd/core'));
const { createMarkdownProcessor } = await import(coreRequire.resolve('@docmd/parser'));
const processor = () => createMarkdownProcessor({}, (md) => installMxFigure(md));

const aligned = [
  '// @name: Name and table — the entity and its table.',
  'entity="todo" table="todos"',
  '// @fields: Fields you send — title is a string.',
  '  attributes',
  '    attribute="title" type="string"',
  '// @belongs: Linked to a list — `listId` arrives with it.',
  '  relationships',
  '    belongs-to="list" destination="list"',
  '',
].join('\n');

// The same file split one line late: each section tag is left at the end of the
// previous segment, so every note describes the lines above it.
const oneLineLate = [
  '// @name: Name and table — the entity and its table.',
  'entity="todo" table="todos"',
  '// @fields: Fields you send — title is a string.',
  '  attributes',
  '    attribute="title" type="string"',
  '  relationships',
  '// @belongs: Linked to a list — `listId` arrives with it.',
  '    belongs-to="list" destination="list"',
  '',
].join('\n');

test('segments are the annotation followed by its own lines, in file order', () => {
  const { segments, problems } = parseMxFigure(aligned, 'todo.md');
  expect(problems).toEqual([]);
  expect(segments.map((segment) => segment.key)).toEqual(['name', 'fields', 'belongs']);
  expect(segments.map((segment) => segment.code.length)).toEqual([1, 2, 2]);
  expect(segments[1].code[0]).toBe('  attributes');
});

test('a segment ending with a line less indented than the next segment starts with is a problem', () => {
  expect(parseMxFigure(aligned, 'todo.md').problems).toEqual([]);
  const late = parseMxFigure(oneLineLate, 'todo.md');
  expect(late.problems).toHaveLength(1);
  expect(late.problems[0]).toContain('todo.md:7');
  expect(late.problems[0]).toContain('kept a section tag its note does not head');
});

test('an empty segment, code before the first note and a long note title are all build errors', () => {
  expect(parseMxFigure('// @a: T — b\n// @b: T — b\n', 'x.md').problems[0]).toContain('must hold at least one line');
  expect(parseMxFigure('entity="todo"\n', 'x.md').problems[0]).toContain('starts with code');
  expect(parseMxFigure('// @a: One two three four five — b\nx=1\n', 'x.md').problems[0]).toContain('5-word title');
});

test('the fence renders one grid row per segment, with a highlighted pre and a note', () => {
  const html = renderMxFigure(aligned, 'todo.md');
  expect(html.startsWith('<div class="mx-figure-wrap"><figure class="mx-figure">')).toBe(true);
  expect(html.match(/class="mx-row mx-code"/g)).toHaveLength(3);
  expect(html.match(/class="mx-row mx-note"/g)).toHaveLength(3);
  expect(html).toContain('class="shiki shiki-themes github-light github-dark"');
  expect(html).toContain('<span class="mx-badge">1</span>');
  expect(html).toContain('<strong>Name and table</strong> the entity and its table.');
  expect(html).toContain('<code>listId</code>');
});

test('a render failure carries the page, the line and the fence', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mx-figure-'));
  try {
    const error = (() => {
      try { processor().render('```mx-figure\nentity="todo"\n```', { filePath: 'todo.md' }); } catch (cause) { return cause; }
      return null;
    })();
    expect(String(error)).toContain('starts with code');
    expect(String(error)).toContain('```mx-figure');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a render failure is a build failure, not a silent fallback', () => {
  expect(figureStyles).toContain('@container');
  expect(figureStyles).toContain('.mx-figure .mx-code::after');
  expect(() => renderMxFigure('entity="todo"\n', 'todo.md')).toThrow(/todo\.md: mx-figure starts with code/);
  expect(writeFileSync).toBeTypeOf('function');
});