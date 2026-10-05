// The home page's entity file sits outside the Docs sample checks (they read
// docs/docs/*.md only), so this file holds it to the same bar: it is the
// flagship todo file in entity file syntax v3, and the site's own `mx`
// highlighter reads all of it, through the same entry the page's fence uses.
import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { highlightMx, mxParseProblems } from '../plugins/mx-highlight.js';

const page = readFileSync(new URL('../docs/index.md', import.meta.url), 'utf8');
const fences = [...page.matchAll(/^```mx(?:[ \t][^\n]*)?\n([\s\S]*?)^```[ \t]*$/gm)].map((m) => m[1]);

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
    'belongs-to=:List :list', 'create :create accept=[:title, :listId]', 'policy :owner'];
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
