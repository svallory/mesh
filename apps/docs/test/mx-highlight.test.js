import { expect, test } from 'bun:test';
import { createRequire } from 'node:module';
import { highlightMx, installMxHighlight, themeStyles } from '../plugins/mx-highlight.js';

// Resolve docmd's own parser, rather than pinning a second markdown implementation.
const require = createRequire(import.meta.url);
const coreRequire = createRequire(require.resolve('@docmd/core'));
const { createMarkdownProcessor } = await import(coreRequire.resolve('@docmd/parser'));
const sample = 'resource="todo"\n  attributes\n    attribute="title" type="string" allow-nil=false public=true\n';
const processor = (renderMx) => createMarkdownProcessor({}, (md) => installMxHighlight(md, renderMx));

test('mx fences render Marko tag and attribute tokens with both theme colors', () => {
  const html = processor().render('```mx\n' + sample + '```', { filePath: 'todo.md' });
  expect(html).toContain('class="shiki shiki-themes github-light github-dark"');
  expect(html).toMatch(/<span style="color:#[A-Fa-f0-9]+;--shiki-dark:#[A-Fa-f0-9]+">resource<\/span>/);
  expect(html).toMatch(/<span style="color:#[A-Fa-f0-9]+;--shiki-dark:#[A-Fa-f0-9]+"> allow-nil<\/span>/);
  expect(html).toMatch(/<span style="[^"]+"> public<\/span>/);
  expect(themeStyles).toContain(':root[data-theme="dark"] .shiki span');
  expect(themeStyles).toContain('color: var(--shiki-dark) !important');
  expect(themeStyles).toContain('background-color: var(--shiki-dark-bg) !important');
  expect(highlightMx(sample)).toContain('--shiki-dark-bg:');
});

test('ts fences are byte-for-byte unchanged from docmd highlighting', () => {
  const source = '```ts "sample.ts"\nconst value: string = "todo";\n```';
  const original = createMarkdownProcessor({});
  expect(processor().render(source)).toBe(original.render(source));
});

test('highlight failures abort rendering with page, block line and source', () => {
  const md = processor(() => { throw new Error('injected failure'); });
  expect(() => md.render('# Todo\n\n```mx\nresource="todo"\n```', { filePath: 'docs/todo.md' }))
    .toThrow('docs/todo.md:3:1: Failed to highlight mx block');
  try {
    md.render('```mx\nresource="todo"\n```', { filePath: 'todo.md' });
  } catch (error) {
    expect(error.message).toContain('```mx\nresource="todo"\n```');
    expect(error.cause.message).toBe('injected failure');
  }
});

test('duplicate setup keeps a single highlighter wrapper', () => {
  const md = processor();
  const highlight = md.options.highlight;
  installMxHighlight(md);
  expect(md.options.highlight).toBe(highlight);
});
