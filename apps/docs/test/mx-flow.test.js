import { expect, test } from 'bun:test';
import { renderMxFlow, FLOW_SECTIONS } from '../plugins/mesh-home.js';

const file = [
  'entity :Todo table="todos"',
  '  attributes',
  '    string :title min=1',
  '',
  '  actions auto=[:read]',
  '    create :create accept=[:title]',
  '',
  '  policies',
  '    policy :owner types=[:read]',
  '      authorize-if=({ actor }) => actor.id !== ""',
  '',
].join('\n');

test('each section of the file is one block, marked with the section it is', () => {
  const html = renderMxFlow(file, 'index.md');
  expect([...html.matchAll(/data-section="([a-z]+)"/g)].map((m) => m[1])).toEqual(['entity', 'attributes', 'actions', 'policies']);
  // Every line, blank ones included, is one block; none is lost or added.
  expect(html.match(/class="mh-l"/g)).toHaveLength(10);
  // Blank lines between sections stay outside them.
  expect(html).toContain('</span></span><span class="mh-l"></span><span class="mh-sec" data-section="actions">');
  expect(html.startsWith('<pre class="hljs mx-hl mh-file-code"><code class="language-mx">')).toBe(true);
  expect(html).toContain('<span class="ts-tag">entity</span>');
});

test('a section name the diagram does not know, or a second root, fails the build', () => {
  expect(() => renderMxFlow('entity :Todo\n  widgets\n    x :y\n', 'index.md')).toThrow(/opens "widgets"/);
  expect(() => renderMxFlow('entity :Todo\nentity :List\n', 'index.md')).toThrow(/second root line/);
  for (const name of ['attributes', 'relationships', 'computed', 'actions', 'policies']) expect(FLOW_SECTIONS).toContain(name);
});

test('the file is escaped like every highlighted fence', () => {
  const html = renderMxFlow('entity :Todo table="<b>&</b>"\n', 'index.md');
  expect(html).toContain('&lt;b&gt;&amp;&lt;/b&gt;');
  expect(html).not.toContain('<b>');
});
