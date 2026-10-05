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

// The wires are computed when the page is built, from the boxes column's fixed rows.
import { WIRE, outRows, wiresFor, wireOut } from '../plugins/mesh-home.js';

const column = [
  '<div class="mh-out">',
  '<p class="mh-group">A</p>',
  '<div class="mh-box" data-box="one" data-from="actions"><h3>One</h3></div>',
  '<div class="mh-box" data-box="two" data-from="actions" data-via="x"><h3>Two</h3></div>',
  '<p class="mh-group">B</p>',
  '<div class="mh-box" data-box="three" data-from="policies"><h3>Three</h3></div>',
  '</div>',
].join('\n');

test('one wire per box, from the build to the middle of its left side, through the middle of the gap', () => {
  expect(outRows(column).map((row) => row.kind === 'box' ? row.id : 'label')).toEqual(['label', 'one', 'two', 'label', 'three']);
  const { svg, total } = wiresFor(column);
  expect(total).toBe(2 * WIRE.label + 3 * WIRE.box + 4 * WIRE.rowGap);
  const paths = [...svg.matchAll(/data-box="([a-z]+)" d="M([\d.]+) ([\d.]+)C([\d.]+) ([\d.]+) ([\d.]+) ([\d.]+) ([\d.]+) ([\d.]+)"/g)];
  expect(paths.map((m) => m[1])).toEqual(['one', 'two', 'three']);
  const rem = (n) => n * 16;
  let top = 0;
  const mids = [];
  for (const h of [WIRE.label, WIRE.box, WIRE.box, WIRE.label, WIRE.box]) { mids.push(top + h / 2); top += h + WIRE.rowGap; }
  const expected = [mids[1], mids[2], mids[4]];
  paths.forEach((m, i) => {
    const [x0, y0, c1x, c1y, c2x, c2y, x1, y1] = m.slice(2).map(Number);
    // Every wire starts at the build's right side, level with its middle...
    expect(x0).toBe(rem(WIRE.chipX + WIRE.chipW));
    expect(y0).toBeCloseTo(rem(total / 2), 1);
    // ...leaves it and enters its box horizontally, turning in the middle of the gap...
    expect(c1y).toBe(y0);
    expect(c2y).toBe(y1);
    expect(c1x).toBe(c2x);
    expect(c1x).toBeCloseTo((x0 + x1) / 2, 1);
    // ...and ends at the box's left side, at its middle.
    expect(x1).toBe(rem(WIRE.gap));
    expect(y1).toBeCloseTo(rem(expected[i]), 1);
  });
  expect(svg).toContain('mh-wire mh-wire-via" data-box="two"');
});

test('the wires go into the page once, with the rule that lights each box\'s own wire', () => {
  const once = wireOut(column);
  expect(wireOut(once)).toBe(once);
  expect(once.match(/<svg class="mh-wires"/g)).toHaveLength(1);
  expect(once).toContain('<div class="mh-out" data-wired>');
  for (const id of ['one', 'two', 'three']) expect(once).toContain(`:has(.mh-box[data-box="${id}"]:hover) .mh-wire[data-box="${id}"]`);
  expect(once).toContain(`--mh-rows:${WIRE.label}rem ${WIRE.box}rem ${WIRE.box}rem ${WIRE.label}rem ${WIRE.box}rem`);
  expect(wireOut('<div class="other"></div>')).toBe('<div class="other"></div>');
});
