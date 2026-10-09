import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { HOME_FAMILIES, HOME_CONTEXTS, HOME_HINTS, HOME_FRAGMENT_WRAPPERS, homeHintTokens, renderHintLine, renderHintText, renderHintNotes, highlightHintFragment, homeHintScript } from '../plugins/mesh-home-hints.js';
import { renderMxFlow } from '../plugins/mesh-home.js';
import { mxHighlighter } from '../plugins/mx-highlight.js';

const page = readFileSync(new URL('../docs/index.md', import.meta.url), 'utf8');
const source = /```mx-flow[^\n]*\n([\s\S]*?)```/.exec(page)[1].trimEnd();
const textOf = (html) => html.replace(/<[^>]*>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');

// Independent copy of the lead's 01:55 addendum; editing implementation prose
// alone must not silently change what readers are taught.
const families = {
  kind: 'Every line is `kind :name options`. The first word says what the line declares.',
  declaration: ':name is a name. The colon says so: not a string, not a variable, the name itself.',
  'value-atom': ':value picks one option from a fixed list that Mesh defines.',
  member: '&name points at something declared in this file: an attribute, a relationship, an action.',
  'imported-entity': 'List is another entity, imported at the top like any TypeScript module.',
  section: 'A section header. Everything indented under it belongs to it.',
  option: "An option on its line. Rules about a field live on that field's line, so one line tells the whole story.",
  string: 'Plain text, in quotes.',
  literal: 'A number or a boolean, exactly as in TypeScript.',
  function: 'Plain TypeScript. Mesh turns it into SQL when it can and runs it otherwise.',
  import: 'A regular TypeScript import. Entity files import each other by path.',
  direction: 'Sort order: asc or desc, one field per line.',
};
families.kind = families.kind.replaceAll('`', '');
const contexts = {
  entity: 'Declares the entity this file is about: one file, one entity.',
  'entity-name': "The entity's name. It shows up in everything Mesh builds: the `Todo` type, the `createTodo` function.",
  table: 'The database table. Mesh writes its schema and its migrations.',
  attributes: 'What a `Todo` stores: one line per column.',
  uuid: "The attribute's type: `uuid`, which becomes `string` in TypeScript.",
  string: "The attribute's type: `string`, which becomes `string` in TypeScript.",
  boolean: "The attribute's type: `boolean`, which becomes `boolean` in TypeScript.",
  timestamp: "The attribute's type: `timestamp`, which becomes `Date` in TypeScript.",
  id: "The record's id.",
  'primary-key': 'This field identifies the record.',
  'title-name': "The todo's text.",
  min: 'At least one character. An empty title is rejected before your code runs.',
  'done-name': 'Whether the todo is complete.',
  default: 'A new todo starts not done.',
  'insertedAt-name': 'When the record was created.',
  on: 'Filled in when the record is created, never by the caller.',
  'on-create': 'On the `create` action.',
  relationships: 'How a `Todo` connects to other entities.',
  relationship: 'A `Todo` belongs to one `List`. Mesh adds a `listId` column to `todos` for you.',
  'list-name': "The relationship's name. Load it as `todo.list`; refer to it here as `&list`.",
  'entity-option': 'The entity on the other side.',
  'entity-list': 'Imported at the top of the file.',
  'import-list': 'Lives in `list.mesh.mx`, next to this file.',
  actions: 'Everything you can do with a `Todo`. Each action becomes one function.',
  auto: 'Two actions Mesh writes for you: `readTodo` and `destroyTodo`.',
  'auto-read': 'The generated `readTodo`.',
  'auto-destroy': 'The generated `destroyTodo`.',
  create: 'An action that creates one record.',
  'create-name': "The action's name. Call it as `createTodo(input, context)`.",
  input: 'What the caller must send, one line per field. Nothing else gets in.',
  title: 'Takes `title` exactly as declared above: a string, at least one character.',
  list: 'The relationship declared by `belongs-to` above. The caller sends the id of a `List`; Mesh stores it in `listId`.',
  update: 'An action that changes one existing record.',
  'rename-name': "The action's name. Call it as `renameTodo({ id, title }, context)`.",
  read: 'A query with a name.',
  'pending-name': "The action's name. Call it as `pendingTodo(input, context)`; it returns the matching records.",
  filter: 'Which records come back. Mesh turns this into the SQL `WHERE`.',
  done: 'Reads `done` on each record.',
  sort: 'The order of the results.',
  insertedAt: 'Oldest first.',
  policies: 'Who may do what. An action no policy covers is forbidden: Mesh fails closed.',
  policy: 'One rule.',
  'owner-name': "The rule's name. It shows in the breakdown when a call is refused.",
  types: 'The action types this rule applies to.',
  'types-create': 'Actions with type `create`: here, `createTodo`.',
  'types-read': 'Actions with type `read`: here, `readTodo` and `pendingTodo`.',
  'types-update': 'Actions with type `update`: here, `renameTodo`.',
  'types-destroy': 'Actions with type `destroy`: here, `destroyTodo`.',
  authorize: 'Allowed when this returns true. For a read it becomes part of the query, so a caller only ever sees their own lists.',
  actor: 'Whoever is calling. Your app passes it on every call; Mesh never guesses.',
  'list-owner': 'Follows the `list` relationship to its `ownerId`. Mesh writes the join.',
};

const tokens = source.split('\n').flatMap(homeHintTokens);
test('every token has one of 12 families and every context is the commissioned wording', () => {
  expect(HOME_CONTEXTS).toEqual(contexts);
  expect(Object.keys(HOME_FAMILIES)).toEqual(Object.keys(families));
  const usedContexts = new Set();
  for (const token of tokens) {
    expect(token.family in families).toBe(true);
    expect(HOME_HINTS[token.key].family).toBe(token.family);
    if (HOME_HINTS[token.key].context) usedContexts.add(token.key);
  }
  expect([...usedContexts].sort()).toEqual(Object.keys(contexts).sort());
  expect(new Set(tokens.map((t) => t.family)).size).toBe(12);
});

test('each box starts with the identical family sentence, then its context or nothing', () => {
  const html = renderMxFlow(source, 'home.md');
  for (const [key, hint] of Object.entries(HOME_HINTS)) {
    const start = html.indexOf(`id="mh-hint-${key}"`);
    expect(start).toBeGreaterThan(-1);
    const familyHtml = renderHintText(HOME_FAMILIES[hint.family], `family-${hint.family}`);
    expect(textOf(familyHtml)).toBe(families[hint.family]);
    const contextHtml = hint.context ? `<span class="mh-hint-context">${renderHintText(contexts[key], key)}</span>` : '';
    expect(html.slice(start)).toStartWith(`id="mh-hint-${key}"><span class="mh-hint-family">${familyHtml}</span>${contextHtml}</span>`);
  }
});

test('all fragments are highlighted at build time, with exact text and no backticks', () => {
  for (const [key, text] of [...Object.entries(HOME_FAMILIES).map(([key, text]) => [`family-${key}`, text]), ...Object.entries(contexts)]) {
    const html = renderHintText(text, key);
    expect(textOf(html)).toBe(text.replaceAll('`', ''));
    expect(html).not.toContain('`');
    const code = [...html.matchAll(/<code class="mx-hl">([\s\S]*?)<\/code>/g)];
    expect(code.length).toBe([...text.matchAll(/`([^`]+)`/g)].length);
    for (const [, fragment] of code) expect(fragment).toMatch(/<span class="ts-[\w-]+">/);
  }
  expect(highlightHintFragment('&list', 'option-value')).toBe('<span class="ts-member">&amp;list</span>');
  expect(highlightHintFragment(':value', 'option-value')).toContain('class="ts-atom"');
  expect(highlightHintFragment(':name', 'declaration')).toContain('class="ts-name"');
  expect(highlightHintFragment('createTodo', 'call')).toContain('class="ts-function"');
  const file = 'import { List } from "./list.mesh.mx"';
  expect(highlightHintFragment('List', 'import')).toBe(mxHighlighter(file)(9, 13));
  expect(highlightHintFragment('kind :name options', 'line')).toBe(mxHighlighter('kind :name options')(0, 18));
  expect(renderHintText(contexts.timestamp, 'timestamp')).toContain(highlightHintFragment('Date', 'type'));
});

test('declared wrappers cover exactly the authored fragments and contextual occurrence counts', () => {
  const texts = { ...HOME_CONTEXTS, ...Object.fromEntries(Object.entries(HOME_FAMILIES).map(([key, text]) => [`family-${key}`, text])) };
  const fragments = new Set(Object.values(texts).flatMap((text) => [...text.matchAll(/`([^`]+)`/g)].map((match) => match[1])));
  expect(Object.keys(HOME_FRAGMENT_WRAPPERS).sort()).toEqual([...fragments].sort());
  for (const [fragment, annotation] of Object.entries(HOME_FRAGMENT_WRAPPERS)) {
    expect(() => highlightHintFragment(fragment, annotation.default)).not.toThrow();
    for (const [key, wrappers] of Object.entries(annotation.byContext || {})) {
      expect(Object.hasOwn(texts, key)).toBe(true);
      const count = [...texts[key].matchAll(/`([^`]+)`/g)].filter((match) => match[1] === fragment).length;
      expect(count).toBeGreaterThan(0);
      expect(wrappers).toHaveLength(count);
      for (const wrapper of wrappers) expect(() => highlightHintFragment(fragment, wrapper, key)).not.toThrow();
    }
  }
});

test('unknown fragments fail note rendering with the fragment and context key', () => {
  for (const fragment of ['newTodo', 'newCall()', 'constructor']) {
    expect(() => renderHintText(`New fragment: \`${fragment}\``, 'new-context'))
      .toThrow(`Unmapped home hint fragment "${fragment}" in context "new-context"`);
  }
  for (const [texts, key, contextKey] of [[HOME_HINTS.entity, 'context', 'entity'], [HOME_FAMILIES, 'kind', 'family-kind']]) {
    const original = texts[key];
    try {
      texts[key] += ' `unmapped`';
      expect(() => renderHintNotes()).toThrow(`Unmapped home hint fragment "unmapped" in context "${contextKey}"`);
    } finally { texts[key] = original; }
  }
});

test('contextual annotations reject missing or excess occurrences rather than guessing', () => {
  for (const [text, count] of [['No code.', 0], ['`string`', 1], ['`string` `string` `string`', 3]]) {
    expect(() => renderHintText(text, 'string'))
      .toThrow(`Home hint fragment "string" in context "string" has ${count} occurrences; expected 2`);
  }
  // The occurrence is per fragment, not its position among other fragments.
  expect(renderHintText('`Todo` `string` `Todo` `string`', 'string'))
    .toContain('<code class="mx-hl"><span class="ts-type-builtin">string</span></code>');
  expect(() => highlightHintFragment('Todo', 'missing-wrapper', 'entity-name'))
    .toThrow('Unknown home hint wrapper "missing-wrapper" for fragment "Todo" in context "entity-name"');
});

// Capture every occurrence before replacing wrapper inference, including the
// different MX/TypeScript roles of repeated `string` and `boolean` fragments.
test('every authored fragment retains its pre-refactor highlighted HTML', () => {
  const rendered = {};
  for (const [group, texts] of [['family', HOME_FAMILIES], ['context', HOME_CONTEXTS]]) {
    for (const [key, text] of Object.entries(texts)) {
      const fragments = [...text.matchAll(/`([^`]+)`/g)].map((match) => match[1]);
      const html = [...renderHintText(text, group === 'family' ? `family-${key}` : key).matchAll(/<code class="mx-hl">([\s\S]*?)<\/code>/g)];
      if (fragments.length) rendered[`${group}:${key}`] = fragments.map((fragment, i) => ({ fragment, html: html[i][1] }));
    }
  }
  expect(rendered).toMatchSnapshot();
});

test('every construct is independently targetable, with one tab stop per nonblank line', () => {
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
    expect(rendered.match(/tabindex="0"/g)?.length ?? 0).toBe(tokens.length ? 1 : 0);
    expect(rendered.match(/tabindex="-1"/g)?.length ?? 0).toBe(Math.max(0, tokens.length - 1));
    expect(rendered.match(/role="button"/g)?.length ?? 0).toBe(tokens.length);
  }
  for (const blank of ['', '  ', '\t']) expect(homeHintTokens(blank)).toEqual([]);
  expect(textOf(code)).toBe(lines.join(''));
  expect(html).not.toContain(' title=');
  expect(code).not.toContain('relationship declared');
});

test('families distinguish declarations, option names, imported entities, values and functions', () => {
  const get = (line) => homeHintTokens(line).map((t) => [t.text, t.family, t.key]);
  expect(get('    string :title min=1')).toEqual([
    ['string', 'kind', 'string'], [':title', 'declaration', 'title-name'], ['min=', 'option', 'min'], ['1', 'literal', 'family-literal'],
  ]);
  expect(get('        &title')).toEqual([['&title', 'member', 'title']]);
  expect(get('    belongs-to :list entity=List')).toContainEqual(['List', 'imported-entity', 'entity-list']);
  expect(get('entity :Todo table="todos"')).toContainEqual(['"todos"', 'string', 'family-string']);
  expect(get('timestamp :insertedAt on=:create')).toContainEqual([':create', 'value-atom', 'on-create']);
  expect(get('create :create')).toContainEqual([':create', 'declaration', 'create-name']);
  const fn = get('authorize-if=({ actor }) => &list.ownerId === actor.id');
  expect(fn).toContainEqual(['actor', 'function', 'actor']);
  expect(fn).toContainEqual(['&list', 'member', 'list-owner']);
  expect(fn).toContainEqual(['=>', 'function', 'family-function']);
});

test('all 15 reference occurrences connect to existing unique targets from the brief', () => {
  const connections = tokens.filter((t) => t.to).map((t) => [t.key, t.to]);
  expect(connections).toEqual([
    ['import-list', 'entity-option'], ['on-create', 'action-create'], ['entity-list', 'import'],
    ['auto-read', 'actions'], ['auto-destroy', 'actions'], ['title', 'attribute-title'], ['list', 'relationship'],
    ['title', 'attribute-title'], ['done', 'attribute-done'], ['insertedAt', 'attribute-insertedAt'],
    ['types-create', 'action-create'], ['types-read', 'actions'], ['types-update', 'action-update'], ['types-destroy', 'actions'],
    ['list-owner', 'relationship'],
  ]);
  const html = renderMxFlow(source, 'home.md');
  for (const [, to] of connections) expect(html.split(`data-hint-anchor="${to}"`).length - 1).toBe(1);
  expect(html).toContain('data-hint-anchor="entity-option"><span class="mh-hint"');
  expect(html).toContain('data-hint-anchor="relationship"');
});

test('client is serializable without imports or a runtime highlighter', () => {
  const js = homeHintScript.replace(/^<script>|<\/script>$/g, '');
  expect(() => new Function(js)).not.toThrow();
  expect(js).not.toContain('import ');
  expect(js).not.toContain('mxHighlighter');
  expect(js).not.toContain('highlightHintFragment');
});
