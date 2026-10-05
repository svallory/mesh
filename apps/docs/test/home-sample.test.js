// The home page's entity file sits outside the Docs sample checks (they read
// docs/docs/*.md only), so this file holds it to the same bar: it is the
// flagship todo file in entity file syntax v3, and the site's own `mx`
// highlighter reads all of it, through the same entry the page's fence uses.
import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { highlightMx, mxParseProblems } from '../plugins/mx-highlight.js';

const page = readFileSync(new URL('../docs/index.md', import.meta.url), 'utf8');
// The entity file is an `mx-flow` fence (plugins/mesh-home.js), the left half of the build diagram.
const fences = [...page.matchAll(/^```mx(?:-flow)?(?:[ \t][^\n]*)?\n([\s\S]*?)^```[ \t]*$/gm)].map((m) => m[1]);

const SECTIONS = new Set(['attributes', 'relationships', 'computed', 'actions', 'policies']);

test('the home page has one entity file, the todo file in syntax v3', () => {
  expect(fences).toHaveLength(1);
  const lines = fences[0].split('\n').filter((line) => line.trim() !== '');
  expect(lines[0]).toBe('entity :Todo table="todos"');
  // v3: every name is an atom. No `#name` anywhere, and no string where a list of
  // names is expected.
  expect(fences[0]).not.toMatch(/(^|\s)#\w/m);
  expect(fences[0]).not.toMatch(/(accept|auto|types|values|sort|load|require)=\[\s*"/);
  for (const line of lines.slice(1)) {
    const declaration = /^\s+([a-z][a-z-]*)(?:=(\S+))?\s+(\S+)/.exec(line);
    // Section tags (`attributes`, `actions auto=[…]`) and rule lines (`authorize-if=…`) name nothing.
    if (!declaration || line.includes('=>') || SECTIONS.has(declaration[1])) continue;
    // `kind :name`, and a relationship's destination is an atom too.
    expect(declaration[3]).toMatch(/^:\w+$/);
    if (declaration[2] !== undefined && declaration[1].startsWith('belongs-to')) expect(declaration[2]).toMatch(/^:[A-Z]\w*$/);
  }
  // The flagship file's idea, in the order a reader meets it.
  const shape = ['uuid :id primary-key', 'string :title min=1', 'boolean :done default=false',
    'belongs-to=:List :list', 'create :create accept=[:title, :listId]', 'update :rename accept=[:title]',
    'read :pending', 'sort\n        asc :title', 'policy :owner'];
  // A read's order is a `sort` section, never the old `sort=[...]` option.
  expect(fences[0]).not.toContain('sort=');
  let at = -1;
  for (const part of shape) {
    const next = fences[0].indexOf(part);
    expect(next).toBeGreaterThan(at);
    at = next;
  }
});

test("the home page's entity file highlights with no error", () => {
  expect(mxParseProblems(fences[0], 'docs/index.md')).toEqual([]);
  expect(highlightMx(fences[0])).toContain('<span class="ts-tag">entity</span>');
});

// The page quotes facts about its own sample; they must stay true when it changes.
test("the page's claims about its entity file match the file", () => {
  const lines = fences[0].replace(/\n$/, '').split('\n');
  expect(page).toContain(`It writes the ${lines.length} lines of <code>todo.mesh.mx</code> above.`);
  // The build error the agents section shows is the one the build would print for
  // a misspelled `:title` in this file's `accept`: same line, same column.
  const row = lines.findIndex((line) => line.includes('create :create accept=[:title'));
  const column = lines[row].indexOf(':title') + 1;
  expect(page).toContain(`src/domain/todo/todo.mesh.mx:${row + 1}:${column} error \`accept\` names :titel,`);
  // Every box's function names are the actions the file declares.
  for (const name of ['createTodo', 'renameTodo', 'pendingTodo', 'readTodo', 'destroyTodo']) expect(page).toContain(name);
});

test('every card names sections the file has, and its group; the page has no "What you call"', async () => {
  const { FLOW_SECTIONS } = await import('../plugins/mesh-home.js');
  const boxes = [...page.matchAll(/<div class="mh-box" data-box="([a-z]+)" data-from="([a-z ]+)"(?: data-via="[^"]*")? data-group="([^"]+)"/g)];
  expect(boxes.map((m) => m[1])).toEqual(['types', 'functions', 'validation', 'authorization', 'table', 'migrations', 'rules', 'model']);
  for (const [, , from] of boxes) for (const part of from.split(' ')) expect(FLOW_SECTIONS).toContain(part);
  expect([...new Set(boxes.map((m) => m[3]))]).toEqual(['Your app', 'The database', 'For your tools']);
  expect(page).not.toContain('What you call');
  expect(page).not.toContain('```ts');
  expect(page).not.toContain('home-flow.js');
});

// The headline breaks between its two sentences and nowhere else: each is a block.
test('the headline is two sentences, one block each', () => {
  expect(page).toContain('<h1 id="mh-title" class="mh-title"><span>Describe your domain once.</span> <span>Mesh builds the rest.</span></h1>');
});

// The home quotes two things the Docs define: what the rules file says, and what a
// build error says. Both must read as the Docs pages have them, so a change to
// either page fails here until the home follows.
const docsPage = (name) => readFileSync(new URL(`../docs/docs/${name}`, import.meta.url), 'utf8');

test('the rules-file box quotes the rules file as Working with AI agents shows it', () => {
  const agents = docsPage('ai-agents.md');
  const rules = /## The rules file[\s\S]*?```text\n([\s\S]*?)```/.exec(agents)?.[1];
  expect(rules).toBeDefined();
  const box = /data-box="rules"[\s\S]*?<div class="mh-snip"><code>([\s\S]*?)<\/code><\/div>/.exec(page)?.[1];
  expect(box).toBeDefined();
  for (const line of box.split('\n')) expect(rules).toContain(line.trim());
  // Names are atoms there, so they are atoms here: never a quoted name.
  expect(box).not.toMatch(/\("|"[a-z]\w*",/);
});

test('the build error quotes the message as Configuration prints it', () => {
  const sample = /error `accept` names :titel, which is not an attribute of :Todo\. Did you mean :title\?/;
  expect(docsPage('configuration.md')).toMatch(sample);
  const quoted = /<pre><code>(src\/domain\/todo\/todo\.mesh\.mx:[\s\S]*?)<\/code><\/pre>/.exec(page)?.[1];
  expect(quoted?.replace(/\n/g, ' ')).toMatch(sample);
});

test('nothing on the home quotes a name where the entity file would write an atom', () => {
  // A quoted lower-case identifier, outside HTML attributes and the TypeScript
  // sample (where field names are strings at run time, as the Docs say).
  const text = page.replace(/```ts[\s\S]*?```/g, '').replace(/<[^>]+>/g, ' ');
  const quoted = [...text.matchAll(/"([a-z][A-Za-z]*)"/g)].map((m) => m[1]);
  expect(quoted.filter((name) => name !== 'todos')).toEqual([]);
});
