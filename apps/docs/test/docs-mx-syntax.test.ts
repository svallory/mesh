// ADR-0067: every Docs fence is a complete syntax-v4 entity. Only the compiler
// test helper may call the MX parser (ADR-0043); the spelling bridge lives there.
import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  checkDocsSyntaxV4, checkDocsSamples, normaliseV4, oldSpellingInV4, parseV4,
} from "../../../packages/compiler/test/repository-checks.ts";

const docs = new URL("../docs/docs/", import.meta.url).pathname;

test("every MX sample on the Docs pages is a syntax v4 entity file that parses", () => {
  const checked = checkDocsSyntaxV4(docs);
  expect(checked.errors).toEqual([]);
  expect(checked.checked).toBeGreaterThan(10);
});

// Planted failures go through the actual fence walker, not just its regex helper.
const oldForms = [
  "    create :create accept=[:title]",
  "    create :create\n      arguments\n        string :title",
  "    update :rename\n      validate\n        require=[:title]",
  "    belongs-to=:List :list",
  "    has-many=:Todo :todos",
  "    has-one=:Payment :payment",
  "    update :send\n      do\n        load=[:list]",
  "    read :read\n      sort\n        asc :title",
  "    update :rename\n      do\n        set\n          :title=\"new\"",
  "    policy :owner actions=[:rename]",
  "    actions on:load=:visible",
  "    create :create\n      input\n        &title min=2",
];
for (const planted of oldForms) {
  test(`rejects planted old or invalid input spelling: ${planted.trim()}`, () => {
    const dir = mkdtempSync(join(tmpdir(), "mesh-v4-"));
    try {
      writeFileSync(join(dir, "planted.md"), `\`\`\`mx\nentity :Todo\n  actions\n${planted}\n\`\`\`\n`);
      expect(checkDocsSyntaxV4(dir).errors.length).toBeGreaterThan(0);
      expect(checkDocsSamples(dir).errors.length).toBeGreaterThan(0);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
}

test("normalisation bridges only the spellings pending the syntax table", () => {
  const source = 'import { List } from "./list.mesh.mx"\nentity :Todo\n  actions\n    create :create\n      input\n        &title\n    update :rename\n      do\n        set\n          &title=() => &title + "&title"\n    read :pending\n      filter=() => !&done && (&flags & mask) === 0\n      sort\n        asc &title\n';
  const normal = normaliseV4(source);
  expect(normal.split("\n").length).toBe(source.split("\n").length);
  expect(normal).toContain('import { List } from "./list.mesh.mx"');
  expect(normal).toContain("        :title");
  expect(normal).toContain('          :title=() => self.title + "&title"');
  expect(normal).toContain("!self.done && (self.flags & mask)");
  expect(normal).toContain("asc :title");
  expect(oldSpellingInV4(source)).toBeNull();
  expect(parseV4(source, "todo.mx")).toEqual([]);
  expect(normaliseV4('// &title\nentity :Todo\n  attributes\n    string :title match=/&title/\n')).toContain('match=/&title/');
  expect(normaliseV4('filter=() => flags &mask')).toBe('filter=() => flags &mask');
  expect(normaliseV4('      return &status === :sent && &dueOn < today()')).toBe('      return self.status === :sent && self.dueOn < today()');
  expect(normaliseV4('value=`first\n&title\nlast`')).toBe('value=`first\n&title\nlast`');
});

test("leading comments are bridged but structural rejection stays on", () => {
  expect(normaliseV4('// invoice.mesh.mx\nentity :Invoice\n')).toBe('\nentity :Invoice\n');
  expect(parseV4('// invoice.mesh.mx\nentity :Invoice\n', 'invoice.mx')).toEqual([]);
  expect(parseV4('entity :Invoice\n// unindented\n  attributes\n    uuid :id\n', 'bad.mx').length).toBeGreaterThan(0);
});

test("syntax and static-file errors still fail after normalisation", () => {
  for (const code of [
    'entity :Todo\n  attributes\n    string :title min=\n',
    'entity :Todo\n  if=true\n    attributes\n      string :title\n',
  ]) expect(parseV4(code, "bad.mx").length).toBeGreaterThan(0);
});
