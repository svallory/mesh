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
  'entity #Todo table="todos"',
  '// @fields: Fields you send — title is a string.',
  '  attributes',
  '    string #title min=1',
  '// @belongs: Linked to a list — `listId` arrives with it.',
  '  relationships',
  '    belongs-to=List #list',
  '',
].join('\n');

// The same file split one line late: each section tag is left at the end of the
// previous segment, so every note describes the lines above it.
const oneLineLate = [
  '// @name: Name and table — the entity and its table.',
  'entity #Todo table="todos"',
  '// @fields: Fields you send — title is a string.',
  '  attributes',
  '    string #title min=1',
  '  relationships',
  '// @belongs: Linked to a list — `listId` arrives with it.',
  '    belongs-to=List #list',
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
  expect(parseMxFigure('entity #Todo\n', 'x.md').problems[0]).toContain('starts with code');
  expect(parseMxFigure('// @a: One two three four five — b\nx=1\n', 'x.md').problems[0]).toContain('5-word title');
});

test('the fence renders one grid row per segment, with a highlighted pre and a note', () => {
  const html = renderMxFigure(aligned, 'todo.md');
  expect(html.startsWith('<div class="mx-figure-wrap"><figure class="mx-figure">')).toBe(true);
  expect(html.match(/class="mx-row mx-code"/g)).toHaveLength(3);
  expect(html.match(/class="mx-row mx-note"/g)).toHaveLength(3);
  expect(html).toContain('<pre class="hljs mx-hl">');
  expect(html).toContain('<span class="ts-tag">entity</span>');
  expect(html).toContain('<span class="ts-constant">#Todo</span>');
  expect(html).toContain('<code>listId</code>');
});

// A segment is a slice of one file, not a document: `  attributes` on its own is
// an error tree and colours nothing. The figure parses the file once and reads
// each segment's line range out of it, so a segment that starts at an indented
// section tag is coloured like the same lines in a full-file fence.
test('every segment is coloured, including the ones that start at an indented tag', () => {
  const html = renderMxFigure(aligned, 'todo.md');
  expect(html).toContain('<span class="ts-attribute">table</span>');
  expect(html).toContain('<span class="ts-tag">attributes</span>');
  expect(html).toContain('<span class="ts-tag">string</span>');
  expect(html).toContain('<span class="ts-constant">#title</span>');
  expect(html).toContain('<span class="ts-tag">belongs-to</span>');
  expect(html).toContain('<span class="ts-type">List</span>');
  expect(html).toContain('<span class="ts-constant">#list</span>');
  // The note lines are annotations, never shown, and no segment keeps a newline.
  expect(html).not.toContain('@belongs');
  expect(html).not.toContain('</span>\n</code>');
});

test('a segment matches the same lines highlighted as part of the whole file', () => {
  const html = renderMxFigure(aligned, 'todo.md');
  const last = html.slice(html.lastIndexOf('<div class="mx-row mx-code">'));
  expect(last).toContain('<code class="language-mx">  <span class="ts-tag">relationships</span>');
  expect(last).toContain('    <span class="ts-tag">belongs-to</span><span class="ts-operator">=</span><span class="ts-type">List</span> <span class="ts-constant">#list</span></code>');
});

test('a render failure carries the page, the line and the fence', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mx-figure-'));
  try {
    const error = (() => {
      try { processor().render('```mx-figure\nentity #Todo\n```', { filePath: 'todo.md' }); } catch (cause) { return cause; }
      return null;
    })();
    expect(String(error)).toContain('starts with code');
    expect(String(error)).toContain('```mx-figure');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a render failure is a build failure, not a silent fallback', () => {
  expect(figureStyles).toContain('@container');
  expect(figureStyles).toContain('.mx-figure .mx-code::after');
  expect(() => renderMxFigure('entity #Todo\n', 'todo.md')).toThrow(/todo\.md: mx-figure starts with code/);
  expect(writeFileSync).toBeTypeOf('function');
});