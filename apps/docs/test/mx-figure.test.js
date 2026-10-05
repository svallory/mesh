import { expect, test } from 'bun:test';
import { createRequire } from 'node:module';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import figurePlugin, { parseMxFigure, renderMxFigure, figureStyles, figureScript, noScriptStyles, installMxFigure } from '../plugins/mx-figure.js';

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

test('the fence renders the whole file as one pre, one block per segment', () => {
  const html = renderMxFigure(aligned, 'todo.md');
  expect(html.startsWith('<div class="mx-figure-wrap"><figure class="mx-figure" id="mxf-')).toBe(true);
  expect(html.match(/<pre /g)).toHaveLength(1);
  expect(html).toContain('<pre class="hljs mx-hl"><code class="language-mx">');
  expect(html.match(/class="mx-seg"/g)).toHaveLength(3);
  // Every line of the file except the annotations, in file order.
  expect(html.match(/class="mx-line"/g)).toHaveLength(5);
  expect(html).toContain('<span class="ts-tag">entity</span>');
  expect(html).toContain('<span class="ts-constant">#Todo</span>');
  expect(html).toContain('<code>listId</code>');
});

test('there is one marker per note, and each marker names, describes and controls its own note', () => {
  const html = renderMxFigure(aligned, 'todo.md');
  const markers = [...html.matchAll(/<button type="button" class="mx-mark" id="([^"]+)" data-n="(\d+)" aria-label="([^"]+)" aria-describedby="([^"]+)" aria-controls="([^"]+)" aria-expanded="false"><\/button>/g)];
  const notes = [...html.matchAll(/<li class="mx-note" id="([^"]+)" data-n="(\d+)">/g)];
  expect(markers).toHaveLength(3);
  expect(notes).toHaveLength(markers.length);
  expect(html.match(/<button/g)).toHaveLength(markers.length);
  markers.forEach((marker, index) => {
    const note = notes[index];
    expect(marker[2]).toBe(String(index + 1));
    expect(note[2]).toBe(String(index + 1));
    expect(marker[4]).toBe(note[1]);
    expect(marker[5]).toBe(note[1]);
  });
  expect(markers.map((marker) => marker[3])).toEqual(['Note 1: Name and table', 'Note 2: Fields you send', 'Note 3: Linked to a list']);
  // Each segment says which note it opens, so hovering its lines finds it.
  expect([...html.matchAll(/class="mx-seg" data-note="([^"]+)"/g)].map((m) => m[1])).toEqual(notes.map((note) => note[1]));
  // Ids are unique on the page.
  const ids = [...html.matchAll(/ id="([^"]+)"/g)].map((m) => m[1]);
  expect(new Set(ids).size).toBe(ids.length);
});

test('a marker sits at the end of the first line of its segment, inside the code', () => {
  const html = renderMxFigure(aligned, 'todo.md');
  const lines = [...html.matchAll(/<span class="mx-line" style="--i:(\d+)">([\s\S]*?)<\/span>(?=<span class="mx-line"|<\/span>|<\/code>)/g)];
  expect(lines.map((m) => m[1])).toEqual(['0', '2', '4', '2', '4']);
  const marked = lines.map((m) => /class="mx-mark"/.test(m[2]));
  expect(marked).toEqual([true, true, false, true, false]);
  for (const [, , body] of lines.filter((_, i) => marked[i])) expect(body.endsWith('aria-expanded="false"></button>')).toBe(true);
});

test('two figures on one page get different ids, and the same figure always gets the same ones', () => {
  const one = renderMxFigure(aligned, 'todo.md');
  const again = renderMxFigure(aligned, 'todo.md');
  const other = renderMxFigure(oneLineLate.replace(/^  relationships\n\/\/ @belongs.*\n/m, ''), 'todo.md');
  const idOf = (html) => /<figure class="mx-figure" id="([^"]+)"/.exec(html)[1];
  expect(idOf(one)).toBe(idOf(again));
  expect(idOf(one)).not.toBe(idOf(other));
});

// Without JavaScript, and in print, the notes are a numbered list under the code:
// nothing in the markup depends on the script to be read.
test('the notes are an ordered list after the code, readable without the script', () => {
  const html = renderMxFigure(aligned, 'todo.md');
  expect(html).toMatch(/<\/code><\/pre><ol class="mx-notes"><li class="mx-note"/);
  expect(html.endsWith('</li></ol></figure></div>')).toBe(true);
  expect(html).toContain('<li class="mx-note" id="');
  expect(html).toContain('<strong>Name and table</strong> the entity and its table.</li>');
  expect(html).not.toMatch(/hidden|display:none|aria-hidden/);
  expect(figureStyles).toContain('@media print');
  expect(figureStyles).toMatch(/\.mx-fig-js \.mx-figure \.mx-note\{position:absolute/);
  // The popover styles apply only once the script has marked the page.
  expect(figureStyles).not.toMatch(/(^|\})\.mx-figure \.mx-note\{position:absolute/m);
  expect(figureScript).toContain("R.classList.add('mx-fig-js')");
  expect(noScriptStyles).toBe('<noscript><style>html{visibility:visible!important}</style></noscript>');
});

test('the script is inline, small and dependency-free, and the motion respects reduced motion', () => {
  expect(figureScript.startsWith('<script>')).toBe(true);
  expect(figureScript).not.toMatch(/\bsrc=|import\(|fetch\(|XMLHttpRequest/);
  expect(figureScript.length).toBeLessThan(4096);
  for (const key of ["'Escape'", "'pointerover'", "'focusin'", "'focusout'", "'click'", "'keydown'"]) expect(figureScript).toContain(key);
  expect(figureStyles).toContain('prefers-reduced-motion:reduce');
  // 120 to 180 ms for the entrance.
  const timings = [...figureStyles.matchAll(/(opacity|transform) \.(\d+)s/g)].map((m) => Number(`0.${m[2]}`) * 1000);
  expect(Math.max(...timings)).toBeLessThanOrEqual(180);
  expect(timings.some((ms) => ms >= 120)).toBe(true);
});

// A segment is a slice of one file, not a document: `  attributes` on its own is
// an error tree and colours nothing. The figure parses the file once and reads
// each line's range out of it, so every line is coloured like the same line in a
// full-file fence.
test('every segment is coloured, including the ones that start at an indented tag', () => {
  const html = renderMxFigure(aligned, 'todo.md');
  expect(html).toContain('<span class="ts-attribute">table</span>');
  expect(html).toContain('<span class="ts-tag">attributes</span>');
  expect(html).toContain('<span class="ts-tag">string</span>');
  expect(html).toContain('<span class="ts-constant">#title</span>');
  expect(html).toContain('<span class="ts-tag">belongs-to</span>');
  expect(html).toContain('<span class="ts-type">List</span>');
  expect(html).toContain('<span class="ts-constant">#list</span>');
  // The note lines are annotations, never shown, and no line keeps a newline.
  expect(html).not.toContain('@belongs');
  expect(html).not.toContain('\n');
});

test('a line is the same markup as the same line highlighted as part of the whole file', () => {
  const html = renderMxFigure(aligned, 'todo.md');
  expect(html).toContain('<span class="mx-line" style="--i:4">    <span class="ts-tag">belongs-to</span><span class="ts-operator">=</span><span class="ts-type">List</span> <span class="ts-constant">#list</span></span>');
});

// Blank lines between segments are part of the file and stay where the author
// put them, but outside the segment before them, so an open note tints only its
// own code; and a file does not end with a blank line.
test('blank lines stay in the file, outside the segments, and none trails the file', () => {
  for (const tail of ['', '\n', '\n\n\n']) {
    const html = renderMxFigure(
      `// @a: First — one.\nentity #Todo\n  attributes\n    string #a\n\n// @b: Second — two.\n    string #b${tail}`,
      'todo.md',
    );
    expect(html).toContain('<span class="ts-constant">#a</span></span></span><span class="mx-line" style="--i:0"></span><span class="mx-seg"');
    expect(html).toMatch(/<span class="ts-constant">#b<\/span><button [^>]*><\/button><\/span><\/span><\/code>/);
  }
});

// The escaping path is ours here too: the code and the notes are built by string
// concatenation in this file rather than by the package's renderer. Nothing an
// author writes may open a tag or close the `code` early.
test('a figure escapes the HTML in its code, its notes and its marker labels', () => {
  const html = renderMxFigure(
    '// @a: <i>Tags</i> & "x" — `<b>bold</b>` & "quotes" in a note.\nentity #Todo default="<i>&</i>"\n',
    'todo.md',
  );
  expect(html).toContain('<strong>&lt;i&gt;Tags&lt;/i&gt; &amp; &quot;x&quot;</strong> <code>&lt;b&gt;bold&lt;/b&gt;</code> &amp; &quot;quotes&quot; in a note.</li>');
  expect(html).toContain('aria-label="Note 1: &lt;i&gt;Tags&lt;/i&gt; &amp; &quot;x&quot;"');
  expect(html).toContain('<span class="ts-string">&quot;&lt;i&gt;&amp;&lt;/i&gt;&quot;</span>');
  expect(html).not.toContain('<b>');
  expect(html).not.toContain('<i>');
  expect([...new Set([...html.matchAll(/<\/?([a-z]+)/g)].map((m) => m[1]))].sort())
    .toEqual(['button', 'code', 'div', 'figure', 'li', 'ol', 'pre', 'span', 'strong']);
});

test('a figure with CRLF line endings renders the same segments and notes', () => {
  const crlf = aligned.replace(/\n/g, '\r\n');
  expect(parseMxFigure(crlf, 'todo.md').problems).toEqual([]);
  const fromCrlf = renderMxFigure(crlf, 'todo.md');
  const fromLf = renderMxFigure(aligned, 'todo.md');
  expect(fromCrlf).toBe(fromLf);
  expect(fromCrlf).toContain('<span class="ts-constant">#title</span>');
  expect(fromCrlf).not.toContain('\r');
});

test('a figure whose file the grammar cannot read fails on the same terms', () => {
  // The figure blanks its own `// @key:` notes before it parses, so the
  // annotated figure on the Introduction page parses whole; an author who writes
  // a `//` line at the left margin inside the entity is the case that fails here,
  // exactly as it fails an ordinary fence.
  const source = ['// @fields: Fields — title is a string.', 'entity #Todo',
    '// a comment at the left margin', '  attributes', '    string #title', ''].join('\n');
  const error = (() => {
    try { renderMxFigure(source, 'index.md'); } catch (cause) { return cause; }
    return null;
  })();
  expect(error).toBeInstanceOf(Error);
  expect(error.message).toContain('index.md');
  expect(error.message).toContain('block line 3 is an ERROR node');
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
  expect(() => renderMxFigure('entity #Todo\n', 'todo.md')).toThrow(/todo\.md: mx-figure starts with code/);
  expect(writeFileSync).toBeTypeOf('function');
});
// docmd 0.9.7 hides <html> until its theme script runs, so without JavaScript every
// page would be blank. The fix rides in this plugin's head output, which docmd adds
// to every page of the site.
test('every page gets the rule that shows the page without JavaScript', () => {
  const head = figurePlugin.generateMetaTags();
  expect(head).toContain(noScriptStyles);
  expect(head).toContain(figureStyles);
  expect(head).toContain(figureScript);
});
