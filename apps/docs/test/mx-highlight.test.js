import { expect, test } from 'bun:test';
import { createRequire } from 'node:module';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { highlightMx, installMxHighlight, themeStyles } from '../plugins/mx-highlight.js';

// Resolve docmd's own parser, rather than pinning a second markdown implementation.
const require = createRequire(import.meta.url);
const coreRequire = createRequire(require.resolve('@docmd/core'));
const { createMarkdownProcessor, processContentAsync } = await import(coreRequire.resolve('@docmd/parser'));
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
    .toThrow('FrameworkError: docs/todo.md: mx block could not be located in the source (line 3 relative to the page body;');
  try {
    md.render('```mx\nresource="todo"\n```', { filePath: 'todo.md' });
  } catch (error) {
    expect(error.message).toContain('```mx\nresource="todo"\n```');
    expect(error.cause.message).toBe('injected failure');
  }
});

test('highlight failures report source-file fence lines after docmd strips frontmatter', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mesh-highlight-lines-'));
  try {
    for (const newline of ['\n', '\r\n']) {
      const filePath = join(dir, 'todo.md');
      const source = ['---', 'title: Todo', 'description: A test page', '---', '', '# Todo', '', '```mx', 'resource="todo"', '```'].join(newline);
      writeFileSync(filePath, source);
      const md = processor(() => { throw new Error('injected failure'); });
      await expect(processContentAsync(source, md, {}, { filePath }))
        .rejects.toThrow(`${filePath}:8:1: Failed to highlight mx block`);
    }
    const filePath = join(dir, 'plain.md');
    const source = '# Todo\n\n```mx\nresource="todo"\n```';
    writeFileSync(filePath, source);
    await expect(processContentAsync(source, processor(() => { throw new Error('injected failure'); }), {}, { filePath }))
      .rejects.toThrow(`${filePath}:3:1: Failed to highlight mx block`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the second identical mx block reports the second source fence', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mesh-highlight-duplicate-'));
  try {
    const filePath = join(dir, 'duplicate.md');
    const block = '```mx\nresource="todo"\n```\n';
    const source = '---\ntitle: Todo\n---\n\n' + block + '\n'.repeat(8) + block;
    writeFileSync(filePath, source);
    let calls = 0;
    const md = processor((code) => {
      if (++calls === 2) throw new Error('second block failure');
      return highlightMx(code);
    });
    await expect(processContentAsync(source, md, {}, { filePath }))
      .rejects.toThrow(`${filePath}:16:1: Failed to highlight mx block`);
    expect(calls).toBe(2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an unmatched source block fails with an explicitly body-relative diagnostic', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mesh-highlight-unmatched-'));
  try {
    const filePath = join(dir, 'different.md');
    writeFileSync(filePath, '```mx\nresource="different"\n```');
    const md = processor(() => { throw new Error('injected failure'); });
    expect(() => md.render('# Todo\n\n```mx\nresource="todo"\n```', { filePath }))
      .toThrow(`FrameworkError: ${filePath}: mx block could not be located in the source (line 3 relative to the page body; no matching mx fence with identical block content)`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('duplicate setup keeps a single highlighter wrapper', () => {
  const md = processor();
  const highlight = md.options.highlight;
  installMxHighlight(md);
  expect(md.options.highlight).toBe(highlight);
});
