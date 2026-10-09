import { expect, test } from 'bun:test';
import plugin, { cleanTitleLabels, figureStyles } from '../plugins/mx-figure.js';

test('heading code is inline and scales with the heading in both themes', () => {
  expect(figureStyles).toContain('.docmd-heading:is(h1,h2,h3,h4):has(code){display:block}');
  expect(figureStyles).toContain(':is(h1,h2,h3,h4) code{display:inline;font-size:.85em;font-weight:inherit;');
  expect(figureStyles).toContain('.sidebar-header h1 a{color:var(--text-color,inherit)}');
});

test('docmd plain-text title labels lose paired backticks at build time', () => {
  const title = 'One domain at `src/domain/`; `&lt;safe&gt;`';
  const plain = 'One domain at src/domain/; &lt;safe&gt;';
  for (const [tag, className] of [
    ['span', 'nav-item-title'], ['span', 'header-title'],
    ['h1', 'docmd-focus-title'], ['a', 'toc-link'], ['a', 'active toc-link'],
  ]) {
    const before = `<${tag} class="${className}">${title}</${tag}>`;
    expect(cleanTitleLabels(before)).toBe(`<${tag} class="${className}">${plain}</${tag}>`);
  }
  expect(cleanTitleLabels(`<title>${title}</title>`)).toBe(`<title>${plain}</title>`);
  expect(cleanTitleLabels(`<li class="breadcrumb-item active" aria-current="page"><span>${title}</span></li>`))
    .toBe(`<li class="breadcrumb-item active" aria-current="page"><span>${plain}</span></li>`);
  const page = { html: `<span class="nav-item-title">${title}</span>` };
  plugin.onPageReady(page);
  expect(page.html).toBe(`<span class="nav-item-title">${plain}</span>`);
  expect(plugin.plugin.capabilities).toContain('build');
});

test('title cleanup leaves authored content, HTML escaping and targets intact', () => {
  const untouched = [
    '<pre><code>const text = `template`;</code></pre>',
    '<h1>One domain at <code>src/domain/</code></h1>',
    '<span class="not-nav-item-title">`literal`</span>',
    '<a class="toc-link"><code>src/domain/</code></a>',
    '<p>Keep `these` literal backticks</p>',
    '<span class="nav-item-title">an unmatched ` delimiter</span>',
  ].join('\n');
  expect(cleanTitleLabels(untouched)).toBe(untouched);
  const source = '<a class="toc-link" href="#`target`" title="`attribute`">`&lt;script&gt;` &amp; `x`</a>';
  const result = '<a class="toc-link" href="#`target`" title="`attribute`">&lt;script&gt; &amp; x</a>';
  expect(cleanTitleLabels(source)).toBe(result);
  expect(cleanTitleLabels(result)).toBe(result);
});

test('social titles clean only their content attribute without decoding HTML entities', () => {
  const source = [
    '<meta property="og:title" content="Use `&quot;x&quot; &amp; &lt;y&gt;`" data-note="`keep`">',
    "<meta content='Use `&#39;x&#39;`' name='twitter:title'>",
    '<meta property="og:url" content="https://example.test/`path`">',
    '<meta name="description" content=\'property="og:title" `keep`\'>',
    '<meta data-property="og:title" content="`keep`">',
    '<meta property="og:title" data-note=\' content="`keep`"\' content="`title`">',
  ].join('\n');
  const expected = [
    '<meta property="og:title" content="Use &quot;x&quot; &amp; &lt;y&gt;" data-note="`keep`">',
    "<meta content='Use &#39;x&#39;' name='twitter:title'>",
    '<meta property="og:url" content="https://example.test/`path`">',
    '<meta name="description" content=\'property="og:title" `keep`\'>',
    '<meta data-property="og:title" content="`keep`">',
    '<meta property="og:title" data-note=\' content="`keep`"\' content="title">',
  ].join('\n');
  expect(cleanTitleLabels(source)).toBe(expected);
  expect(cleanTitleLabels(expected)).toBe(expected);
});

test('BreadcrumbList names clean safely while other JSON values retain their meaning', () => {
  const name = '`src/domain/` and `"quoted"` and `</script><script>alert(1)</script>` and `\\\\path` & \u2028\u2029';
  const url = 'https://example.test/`keep`?x="quoted"&y=1';
  const data = {
    '@context': 'https://schema.org', '@type': 'BreadcrumbList', name: '`keep root name`',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name, item: url, description: '`keep description`' },
      { '@type': 'Thing', name: '`keep other type`' },
      null,
    ],
  };
  const script = (value) => '<script type="application/ld+json">' +
    JSON.stringify(value).replace(/</g, '\\u003c') + '</script>';
  const result = cleanTitleLabels(script(data));
  const body = result.slice(result.indexOf('>') + 1, result.lastIndexOf('</script>'));
  const parsed = JSON.parse(body);
  expect(parsed).toEqual({ ...data, itemListElement: [
    { ...data.itemListElement[0], name: name.replace(/`([^`\n]+)`/g, '$1') },
    data.itemListElement[1], null,
  ] });
  expect(body).not.toMatch(/[<>&\u2028\u2029]/);
  expect(cleanTitleLabels(result)).toBe(result);
  const unrelated = script({ '@type': 'Article', name: '`keep`', url });
  expect(cleanTitleLabels(unrelated)).toBe(unrelated);
  const malformed = '<script type="application/ld+json">{"@type":"BreadcrumbList", bad}</script>';
  expect(cleanTitleLabels(malformed)).toBe(malformed);
});
