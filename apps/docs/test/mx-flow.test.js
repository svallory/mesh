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
  expect(html).toContain('</span></span><span class="mh-l" style="--i:0"></span><span class="mh-sec" data-section="actions">');
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

// On a wide screen the cards sit around the file, placed on the diagram's own grid.
test('on a wide screen the cards sit around the file, with no build node', async () => {
  const { homeStyles } = await import('../plugins/mesh-home.js');
  const wide = /@media \(min-width:1181px\)\{([\s\S]*?)\n\}/.exec(homeStyles)?.[1];
  expect(wide).toBeDefined();
  expect(wide).toContain('.mh-seam,');
  expect(wide).toMatch(/\.mh-seam,[^{]*\{display:none\}/);
  expect(wide).toContain('>.grid-item:first-child{grid-column:1/3;grid-row:1/6');
  expect(wide).toContain('.mh-box[data-group="Your app"]{grid-column:3/5}');
  for (const [box, place] of [['table', 'grid-column:1;grid-row:7'], ['migrations', 'grid-column:2;grid-row:7'], ['rules', 'grid-column:3;grid-row:7'], ['model', 'grid-column:4;grid-row:7']]) {
    expect(wide).toContain(`.mh-box[data-box=${box}]{${place}}`);
  }
});

// On a phone the diagram is a scroll sequence: the file pins at the top, the cards
// pass one at a time through a slot at the bottom, and all of it is released
// together after the last card. It is CSS (sticky), so it needs no script.
test('on a phone the file pins and the cards pass through one slot, in CSS alone', async () => {
  const { homeStyles } = await import('../plugins/mesh-home.js');
  const deck = /@media screen and \(max-width:900px\) and \(min-height:660px\)\{([\s\S]*?)\n\}/.exec(homeStyles)?.[1];
  expect(deck).toBeDefined();
  // The file's column is a sticky stage as tall as the screen under the top bar,
  // so it is released at the same moment as the last card.
  expect(deck).toContain('>.grid-item:first-child{position:sticky;top:var(--mh-top);z-index:2;height:calc(var(--mh-floor) - var(--mh-top))');
  // Every card sticks in the same slot, with a pause of scrolling between cards.
  expect(deck).toContain('.mh-box{position:sticky;top:var(--mh-slot);height:var(--mh-card);overflow:hidden;margin-top:var(--mh-dwell)');
  expect(deck).toContain('.mh-out::after{content:"";display:block;height:var(--mh-dwell)}');
  // The build rests just above the slot.
  expect(deck).toContain('.mh-seam{position:sticky;top:calc(var(--mh-slot) - 3rem)');
  // Its sticky parents may not be scroll containers.
  expect(homeStyles).toMatch(/\.grids\{position:relative;display:grid;[^}]*overflow:visible/);
});

test('each line of the file carries its indentation, for the hanging wrap on a phone', () => {
  const html = renderMxFlow('entity :Todo\n  attributes\n    string :title\n', 'index.md');
  expect([...html.matchAll(/class="mh-l" style="--i:(\d+)"/g)].map((m) => m[1])).toEqual(['0', '2', '4']);
});
