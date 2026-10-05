import { expect, test } from 'bun:test';
import { createRequire } from 'node:module';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  highlightMx,
  installMxHighlight,
  mxParseProblems,
  themeStyles,
  unstyledCaptureNames,
} from '../plugins/mx-highlight.js';

// Resolve docmd's own parser, rather than pinning a second markdown implementation.
const require = createRequire(import.meta.url);
const coreRequire = createRequire(require.resolve('@docmd/core'));
const { createMarkdownProcessor, processContentAsync } = await import(coreRequire.resolve('@docmd/parser'));
const processor = (renderMx) => createMarkdownProcessor({}, (md) => installMxHighlight(md, renderMx));

/**
 * The class of every span whose text is exactly `text`, in document order.
 *
 * Every match is returned, not the first: a token that occurs twice in one
 * fence (the two `self` of a `check`) has to be coloured the same way both
 * times, and a second occurrence left uncoloured must not pass unnoticed.
 *
 * @param {string} source
 * @param {string} text
 * @returns {string[]}
 */
function classesOfText(source, text) {
  const escaped = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const pattern = new RegExp(`<span class="([^"]+)">${escaped.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}</span>`, 'g');
  return [...highlightMx(source).matchAll(pattern)].map((match) => match[1]);
}

/**
 * The error `fn` throws, or `undefined` when it does not throw. The caller
 * asserts on it, so a render that quietly stopped failing fails the test: a
 * bare `try`/`catch` with assertions only inside the `catch` does not.
 *
 * @param {() => unknown} fn
 */
function thrown(fn) {
  try {
    fn();
  } catch (error) {
    return error;
  }
  return undefined;
}

const forms = [
  {
    name: 'a regex literal attribute value',
    code: 'string #number unique match=/^INV-\\d+$/',
    spans: {
      string: 'ts-tag',
      '#number': 'ts-constant',
      unique: 'ts-attribute',
      match: 'ts-attribute',
      '^INV-\\d+$': 'ts-string-special',
    },
  },
  {
    // The name in a destructured parameter and the same name in the body are
    // two different nodes: `variable.parameter` in the pattern, `variable` in
    // the body. Both carry a class, and both are listed here.
    name: 'a check with a label, an expression argument and a code',
    code: 'check :invoiceIsSent [ that=({ self }) => self.status === "sent" code="invalid_state" ]',
    spans: {
      check: 'ts-tag',
      ':invoiceIsSent': 'ts-label',
      that: 'ts-attribute',
      self: ['ts-variable-parameter', 'ts-variable'],
      status: 'ts-property',
      '"sent"': 'ts-string',
      code: 'ts-attribute',
      '"invalid_state"': 'ts-string',
    },
  },
  {
    name: 'a ternary in an attribute value',
    code: 'string #state default=isLate ? "late" : "ok"',
    spans: {
      string: 'ts-tag',
      '#state': 'ts-constant',
      default: 'ts-attribute',
      isLate: 'ts-variable',
      '?': 'ts-operator',
      '"late"': 'ts-string',
      ':': 'ts-operator',
      '"ok"': 'ts-string',
    },
  },
  {
    name: 'a relationship with a tagless reference',
    code: 'belongs-to=Customer #customer',
    spans: { 'belongs-to': 'ts-tag', Customer: 'ts-type', '#customer': 'ts-constant' },
  },
  {
    name: 'a tagless assignment under set',
    code: 'set\n    #status="paid"',
    spans: { set: 'ts-tag', '#status': 'ts-constant', '"paid"': 'ts-string' },
  },
  {
    name: 'a method declared after a name',
    code: 'boolean #isOverdue({ self }) { return self.dueOn < today() }',
    spans: {
      boolean: 'ts-tag',
      '#isOverdue': 'ts-constant',
      self: 'ts-variable',
      return: 'ts-keyword',
      dueOn: 'ts-property',
      today: 'ts-function',
    },
  },
  {
    name: 'actions with auto and on:load',
    code: 'actions auto=["read"] on:load="visible"',
    spans: {
      actions: 'ts-tag',
      auto: 'ts-attribute',
      '"read"': 'ts-string',
      'on:load': 'ts-attribute',
      '"visible"': 'ts-string',
    },
  },
  {
    name: 'a number in an attribute value',
    code: 'string #quantity default=0',
    spans: { string: 'ts-tag', '#quantity': 'ts-constant', default: 'ts-attribute', '0': 'ts-number' },
  },
];

for (const form of forms) {
  test(`${form.name} is coloured, and does not throw`, () => {
    const html = highlightMx(form.code + '\n');
    for (const [text, wanted] of Object.entries(form.spans)) {
      const expected = Array.isArray(wanted) ? wanted : [wanted];
      const classes = classesOfText(form.code, text);
      expect(classes.length).toBeGreaterThan(0);
      expect([...new Set(classes)].sort()).toEqual([...expected].sort());
    }
    expect(html).toContain('<pre class="hljs mx-hl"><code class="language-mx">');
  });
}

test('every capture the queries can produce has a decided colour in both themes', () => {
  expect(unstyledCaptureNames()).toEqual([]);
  // Tags, names, labels, attribute names, strings, numbers, regex literals and the
  // TypeScript inside functions each get their own class, in both themes, from the
  // hexes docmd's own highlight stylesheets use.
  const expected = {
    'ts-tag': '#a626a4',
    'ts-keyword': '#a626a4',
    'ts-label': '#4078f2',
    'ts-constant': '#0184bb',
    'ts-attribute': '#986801',
    'ts-string': '#50a14f',
    'ts-string-special': '#50a14f',
    'ts-number': '#c18401',
    'ts-function': '#4078f2',
    'ts-type': '#c18401',
    'ts-punctuation-bracket': '#a0a1a7',
    'ts-comment': '#a0a1a7',
  };
  for (const [cls, light] of Object.entries(expected)) {
    expect(themeStyles).toContain(`.mx-hl .${cls}{color:${light}`);
    expect(themeStyles).toMatch(
      new RegExp(`:root\\[data-theme="dark"\\] \\.mx-hl \\.${cls}\\{color:#`),
    );
  }
  // A regex is a string in this theme, so the italic is what separates it.
  expect(themeStyles).toContain('.mx-hl .ts-string-special{color:#50a14f;font-style:italic}');
  // A capture whose entry was never written must not slip through the palette.
  // `constructor` is the one that could: it is an `Object.prototype` property,
  // so `name in PALETTE` is true for it whether or not the table decides it, and
  // the table would then read as `Object` and emit `color:undefined`.
  expect(unstyledCaptureNames()).toEqual([]);
  expect(themeStyles).not.toContain('undefined');
  expect(themeStyles).toContain('.mx-hl .ts-constructor{color:#4078f2');
  expect(themeStyles).toContain(':root[data-theme="dark"] .mx-hl .ts-constructor{color:#61aeee}');
  // The box is docmd's: the stylesheet colours spans and sets no background.
  expect(themeStyles).not.toContain('background');
  expect(themeStyles).not.toContain('.shiki');
  expect(highlightMx('entity #Todo\n')).toContain('<pre class="hljs mx-hl">');
});

test('a plain word carries no span, so it reads in the colour docmd gives a pre', () => {
  const html = highlightMx('check :paid [ that=(self) => self.done ]\n');
  expect(html).toContain('<span class="ts-tag">check</span>');
  expect(html).toContain('<span class="ts-label">:paid</span>');
  // `self` is a parameter in the list and a variable in the body. Both are plain
  // words: the span carries its class, and the stylesheet has no rule for it, so
  // the word reads in the pre colour docmd gives every other block.
  expect(html).toContain('<span class="ts-variable-parameter">self</span>');
  expect(html).toContain('<span class="ts-variable">self</span>');
  expect(themeStyles).not.toContain('.ts-variable{');
  expect(themeStyles).not.toContain('.ts-variable-parameter{');
  expect(themeStyles).not.toContain('.ts-property{');
});

// The escaping path is the package's `renderMx`, and a fence is the one
// place an author can write HTML by accident: an attribute value, a comment or a
// string that looks like a tag. Everything that reaches the page is escaped, so
// nothing can close the `code` element early or open a tag.
test('an mx fence escapes the HTML an author wrote', () => {
  const html = highlightMx('string #markup default="<b>&</b>" // </pre><script>alert(1)</script>\n');
  expect(html).toContain('&lt;b&gt;&amp;&lt;/b&gt;');
  expect(html).toContain('&lt;/pre&gt;&lt;script&gt;alert(1)&lt;/script&gt;');
  expect(html).not.toContain('<b>');
  expect(html).not.toContain('<script>');
  // The only elements in the output are the ones the renderer opens itself,
  // and the code element is still the last thing before `</pre>`.
  expect([...new Set([...html.matchAll(/<\/?([a-z]+)/g)].map((match) => match[1]))].sort())
    .toEqual(['code', 'pre', 'span']);
  expect(html.endsWith('</code></pre>')).toBe(true);
  // And the text a reader sees is the text the author wrote.
  const text = html.replace(/<[^>]*>/g, '')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&');
  expect(text).toBe('string #markup default="<b>&</b>" // </pre><script>alert(1)</script>');
});

// The two forms the vendored queries used to leave uncoloured. Both were fixed
// on the MX side and are in @mxlang/tree-sitter-mx 0.1.0-alpha.1, so both are
// pinned here: a downgrade of the package that lost either one fails this.
test('the name in a destructured lambda parameter is coloured, and the body\'s too', () => {
  const html = highlightMx('check :done [ that=({ self }) => self.done ]\n');
  // The pattern's `self` is a bound name (`variable.parameter`), the body's is a
  // read of it (`variable`); both are plain words, and both carry their class.
  expect(html).toContain('<span class="ts-punctuation-bracket">({</span> <span class="ts-variable-parameter">self</span>');
  expect(html).toContain('<span class="ts-variable">self</span><span class="ts-punctuation-delimiter">.</span><span class="ts-property">done</span>');
  expect(classesOfText('check :done [ that=({ self }) => self.done ]', 'self').sort())
    .toEqual(['ts-variable', 'ts-variable-parameter']);
});

test('the ? and the : of a ternary are coloured as operators', () => {
  const code = 'string #state default=isLate ? "late" : "ok"\n';
  const html = highlightMx(code);
  expect(html).toContain('<span class="ts-variable">isLate</span> <span class="ts-operator">?</span>');
  expect(html).toContain('<span class="ts-string">&quot;late&quot;</span> <span class="ts-operator">:</span>');
  // The old grammar gave both no class at all, which left a bare `?` and `:` in
  // the output. Every character of the code the reader sees is inside a span now:
  // strip the spans and what is left is the author's line, escaped and nothing
  // else.
  const inner = /<code class="language-mx">([\s\S]*)<\/code>/.exec(html)[1];
  expect(inner.replace(/<\/?span[^>]*>/g, ''))
    .toBe('string #state default=isLate ? &quot;late&quot; : &quot;ok&quot;');
});

// A fence is a whole `.mx` file, and a line at the left margin ends the root
// tag's block, a comment included. The grammar reports that as an ERROR node, so
// the block would render as plain text with the lines below it uncoloured and no
// error anywhere. It fails the build like any other bad fence instead, naming
// the page and the line, and the line inside the block to fix.
const columnZero = [
  'entity #Todo table="todos"',
  '// @fields: title is a string.',
  '  attributes',
  '    string #title min=1',
].join('\n');

test('mxParseProblems says nothing about a file the grammar read', () => {
  expect(mxParseProblems('entity #Todo\n  attributes\n    string #title min=1\n', 'todo.md')).toEqual([]);
  // A comment indented with the block it sits in is fine, as every fence on the
  // site shows.
  expect(mxParseProblems('entity #Todo\n  // a comment\n  attributes\n    string #title\n', 'todo.md')).toEqual([]);
});

test('mxParseProblems names the line inside the block the grammar could not read', () => {
  const problems = mxParseProblems(columnZero + '\n', 'docs/entities.md');
  expect(problems).toHaveLength(1);
  // Line 1 is the entity, which parsed; line 2 is the comment at the left
  // margin, which is what the author has to indent.
  expect(problems[0]).toContain('docs/entities.md');
  expect(problems[0]).toContain('block line 2 is an ERROR node');
  expect(problems[0]).toContain('a comment inside an entity is indented with the block it sits in');
});

test('an mx fence the grammar cannot read fails the build with the page and the line', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mesh-highlight-error-tree-'));
  try {
    const filePath = join(dir, 'entities.md');
    const source = ['# Todo', '', '```mx', columnZero, '```', ''].join('\n');
    writeFileSync(filePath, source);
    const failure = await processContentAsync(source, processor(), {}, { filePath })
      .then(() => undefined, (error) => error);
    expect(failure).toBeInstanceOf(Error);
    expect(failure.message).toContain(`${filePath}:3:1: Failed to highlight mx block`);
    expect(failure.message).toContain('@mxlang/tree-sitter-mx');
    expect(failure.message).toContain('block line 2 is an ERROR node');
    // The fence itself is quoted, so the author sees what failed.
    expect(failure.message).toContain(columnZero);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a titled mx fence keeps docmd code-block header and copy button markup', () => {
  const html = processor().render('```mx "todo.mesh.mx"\nentity #Todo\n```', { filePath: 'todo.md' });
  expect(html).toContain('docmd-code-block-wrapper');
  expect(html).toContain('docmd-code-block-title');
  expect(html).toContain('todo.mesh.mx');
  expect(html).toContain('<pre class="hljs mx-hl">');
});

test('ts fences are byte-for-byte unchanged from docmd highlighting', () => {
  const source = '```ts "sample.ts"\nconst value: string = "todo";\n```';
  const original = createMarkdownProcessor({});
  expect(processor().render(source)).toBe(original.render(source));
  // docmd, not this plugin, is what highlights every other language: its
  // highlight.js classes, with no Shiki markup anywhere in the output.
  expect(processor().render(source)).not.toContain('shiki');
});

test('highlight failures abort rendering with page, block line and source', () => {
  const md = processor(() => { throw new Error('injected failure'); });
  expect(() => md.render('# Todo\n\n```mx\nresource="todo"\n```', { filePath: 'docs/todo.md' }))
    .toThrow('FrameworkError: docs/todo.md: mx block could not be located in the source (line 3 relative to the page body after frontmatter;');
  const error = thrown(() => md.render('```mx\nresource="todo"\n```', { filePath: 'todo.md' }));
  expect(error).toBeInstanceOf(Error);
  expect(error.message).toContain('```mx\nresource="todo"\n```');
  expect(error.cause.message).toBe('injected failure');
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
    for (const gap of [1, 8]) {
      for (const newline of ['\n', '\r\n']) {
        const filePath = join(dir, 'duplicate.md');
        const block = '```mx\nresource="todo"\n```\n';
        const source = ('---\ntitle: Todo\n---\n\n' + block + '\n'.repeat(gap) + block).replace(/\n/g, newline);
        writeFileSync(filePath, source);
        let calls = 0;
        const md = processor((code) => {
          if (++calls === 2) throw new Error('second block failure');
          return highlightMx(code);
        });
        await expect(processContentAsync(source, md, {}, { filePath }))
          .rejects.toThrow(`${filePath}:${8 + gap}:1: Failed to highlight mx block`);
        expect(calls).toBe(2);
      }
    }
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
      .toThrow(`FrameworkError: ${filePath}: mx block could not be located in the source (line 3 relative to the page body after frontmatter; no matching mx fence with identical block content)`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a transformed body with duplicate matches reports candidates instead of guessing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mesh-highlight-ambiguous-'));
  try {
    const filePath = join(dir, 'duplicate.md');
    const block = '```mx\nresource="todo"\n```\n';
    writeFileSync(filePath, '---\ntitle: Todo\n---\n\n' + block + '\n' + block);
    const md = processor(() => { throw new Error('injected failure'); });
    expect(() => md.render('# Changed body\n\n' + block, { filePath }))
      .toThrow(`FrameworkError: ${filePath}: mx block could not be located in the source (line 3 relative to the page body after frontmatter; ambiguous matching fences; candidate source lines: 5, 9)`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a transformed body with one source match reports that unique fence', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mesh-highlight-unique-'));
  try {
    const filePath = join(dir, 'unique.md');
    const block = '```mx\nresource="todo"\n```\n';
    writeFileSync(filePath, '# Original body\n\n' + block);
    const md = processor(() => { throw new Error('injected failure'); });
    expect(() => md.render('# Changed body\n\n' + block, { filePath }))
      .toThrow(`${filePath}:3:1: Failed to highlight mx block`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

for (const variant of [
  { name: 'indented container fence cannot match a later identical top-level fence', indent: '  ', finalNewline: '\n' },
  { name: 'container fragment suffix without a final newline cannot match a later top-level fence', indent: '', finalNewline: '' },
]) {
  test(variant.name, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mesh-highlight-container-'));
    try {
      const filePath = join(dir, 'callout.md');
      const source = ['---', 'title: Todo', '---', '', '::: callout info "One"',
        `${variant.indent}\`\`\`mx`, `${variant.indent}resource="todo"`, `${variant.indent}\`\`\``,
        ':::', '', '```mx', 'resource="todo"', '```'].join('\n') + variant.finalNewline;
      writeFileSync(filePath, source);
      let calls = 0;
      const md = processor(() => {
        calls++;
        throw new Error('first container block failure');
      });
      const error = await processContentAsync(source, md, {}, { filePath }).catch((failure) => failure);
      expect(error).toBeInstanceOf(Error);
      expect(error.message).toContain(`FrameworkError: ${filePath}: mx block is inside a container (line 1 relative to that container's content)`);
      expect(error.message).not.toContain(`${filePath}:11:1`);
      expect(error.message).toContain('```mx\nresource="todo"\n```');
      expect(error.cause.message).toBe('first container block failure');
      expect(calls).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

test('duplicate setup keeps a single highlighter wrapper', () => {
  const md = processor();
  const highlight = md.options.highlight;
  installMxHighlight(md);
  expect(md.options.highlight).toBe(highlight);
});
