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
  expect(page).toContain(`src/domain/todo/todo.mesh.mx:${row + 1}:${column} error \`accept\` names "titel"`);
  // Every box's function names are the actions the file declares.
  for (const name of ['createTodo', 'renameTodo', 'pendingTodo', 'readTodo', 'destroyTodo']) expect(page).toContain(name);
});

test('every box names sections the file has, and the island is loaded from where the build writes it', async () => {
  const { FLOW_SECTIONS } = await import('../plugins/mesh-home.js');
  const boxes = [...page.matchAll(/<div class="mh-box" data-box="([a-z]+)" data-from="([a-z ]+)"/g)];
  expect(boxes.map((m) => m[1])).toEqual(['types', 'functions', 'validation', 'authorization', 'table', 'migrations', 'rules', 'model']);
  for (const [, , from] of boxes) for (const part of from.split(' ')) expect(FLOW_SECTIONS).toContain(part);
  const build = readFileSync(new URL('../island/build.ts', import.meta.url), 'utf8');
  expect(build).toContain("'../site/assets/home-flow.js'");
  expect(page).toContain("import((window.DOCMD_BASE || '/') + 'assets/home-flow.js')");
  expect(page).toContain("matchMedia('(prefers-reduced-motion: reduce)')");
});
