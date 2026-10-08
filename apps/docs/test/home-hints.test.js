import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { HOME_HINTS, homeHintTokens, renderHintLine, homeHintScript } from '../plugins/mesh-home-hints.js';
import { renderMxFlow } from '../plugins/mesh-home.js';

const page = readFileSync(new URL('../docs/index.md', import.meta.url), 'utf8');
const source = /```mx-flow[^\n]*\n([\s\S]*?)```/.exec(page)[1].trimEnd();
const textOf = (html) => html.replace(/<[^>]*>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&');

// Independent copy of the commissioned wording: changing the registry alone
// must not silently change what readers are taught.
const wording = [
  'Another entity is imported like any TypeScript module. `List` lives in `list.mesh.mx`, next to this file.',
  'Declares the entity. `:Todo` is its name: an atom, a name that stands for itself.',
  'Text is a string. The table this entity is stored in.',
  'A section. Indentation nests; a line is `kind :name options`.',
  'An attribute: its type, its name, its rules. `primary-key` is a flag.',
  'A rule about one field goes on its line. `min=1`: at least one character.',
  'A default, written as in TypeScript.',
  '`:create` is one of a fixed set, so it is an atom. Set when the record is created.',
  'Where this entity connects to others.',
  "`:list` is the relationship's name; `List` the imported entity. Creates the `listId` column; `&list` in `input` is how the caller sets it.",
  'What can be done. `auto` asks Mesh to generate these two actions.',
  'An action: its type and its name. Mesh builds the function `createTodo` from it.',
  'Everything this action takes, one line per field.',
  '`&name` refers to a member of this entity. Takes `title` as declared above: same type, same rules.',
  'Takes the related `List`: the caller sends its id.',
  'An update action; it changes one existing record.',
  'A read action: a query with a name.',
  'A function, ordinary TypeScript. Mesh translates it to SQL when it can.',
  'Order, one field per line.',
  'Who may call what. An action no policy covers is forbidden.',
  'A rule for these action types.',
  'Allowed when the caller owns the list. `actor` is whoever calls.',
];

test('all 22 commissioned explanations match verbatim and are used in the home', () => {
  expect(Object.values(HOME_HINTS)).toEqual(wording);
  const keys = source.split('\n').flatMap(homeHintTokens).map((t) => t.key);
  expect([...new Set(keys)].sort()).toEqual(Object.keys(HOME_HINTS).sort());
});

test('every home construct is a separate focusable token; no whitespace has a hint', () => {
  const html = renderMxFlow(source, 'home.md');
  const code = /<code class="language-mx">([\s\S]*?)<\/code><\/pre>/.exec(html)[1];
  const lines = source.split('\n');
  expect(code.match(/class="mh-l"/g)).toHaveLength(lines.length);
  for (const line of lines) {
    const tokens = homeHintTokens(line);
    expect(tokens.map((t) => line.slice(t.start, t.end)).join('')).toBe(line.replace(/\s+/g, ''));
    for (const token of tokens) {
      expect(token.end).toBeGreaterThan(token.start);
      expect(line.slice(token.start, token.end).trim()).not.toBe('');
    }
    const rendered = renderHintLine(line, 0, (a, b) => line.slice(a, b));
    expect(rendered.match(/tabindex="0"/g)?.length ?? 0).toBe(tokens.length);
    expect(rendered.match(/role="button"/g)?.length ?? 0).toBe(tokens.length);
  }
  for (const blank of ['', '  ', '\t']) expect(homeHintTokens(blank)).toEqual([]);
  // Line wrappers are block elements: the renderer adds no copy-visible text.
  expect(textOf(code)).toBe(lines.join(''));
  expect(html).not.toContain(' title=');
  expect(code).not.toContain('Takes the related');
});

test('declarations, imported entities and member references are independent targets', () => {
  const get = (line) => homeHintTokens(line).map((t) => [line.slice(t.start, t.end), t.key]);
  expect(get('    string :title min=1')).toContainEqual([':title', 'string']);
  expect(get('        &title')).toEqual([['&title', 'title']]);
  expect(get('    belongs-to :list entity=List')).toContainEqual(['List', 'relationship']);
  expect(get('      input')).toEqual([['input', 'input']]);
  expect(get('entity :Todo table="todos"')).toContainEqual(['"todos"', 'table']);
});

test('client is serializable as a standalone script, without imports or a library', () => {
  const js = homeHintScript.replace(/^<script>|<\/script>$/g, '');
  expect(() => new Function(js)).not.toThrow();
  expect(js).not.toContain('import ');
});
