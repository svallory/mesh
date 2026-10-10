// ADR-0067: every Docs fence is a complete syntax-v4 entity. Only the compiler
// test helper may call the MX parser (ADR-0043); fences parse as authored.
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  checkDocsSyntaxV4, checkDocsSamples, oldSpellingInV4, parseV4,
} from "../../../packages/compiler/test/repository-checks.ts";

const docs = new URL("../docs/docs/", import.meta.url).pathname;

test("every Docs and ADR-0050 MX sample is a syntax v4 entity file that parses", () => {
  const checked = checkDocsSyntaxV4(docs);
  expect(checked.errors).toEqual([]);
  expect(checked.checked).toBe(20);
  expect(checked).not.toHaveProperty("deferred");
});

test("ADR-0050's Invoice equals Entities' larger example, apart from its path comment", () => {
  const entities = readFileSync(join(docs, "entities.md"), "utf8").split("## A larger example")[1]!;
  const adr = readFileSync(join(docs, "../architecture/decisions/0050-entity-file-syntax.md"), "utf8");
  const invoice = (page: string) => /```mx[^\n]*\n([\s\S]*?)```/.exec(page)![1]!
    .replace(/^\/\/ src\/domain\/billing\/invoice\.mesh\.mx\r?\n/, "");
  expect(invoice(adr)).toBe(invoice(entities));
});

test("both walkers inspect a planted failure in ADR-0050, not only user pages", () => {
  const root = mkdtempSync(join(tmpdir(), "mesh-v4-adr-"));
  try {
    const dir = join(root, "docs");
    mkdirSync(dir);
    mkdirSync(join(root, "architecture/decisions"), { recursive: true });
    writeFileSync(join(dir, "valid.md"), "```mx\nentity :Todo\n```\n");
    writeFileSync(join(root, "architecture/decisions/0050-entity-file-syntax.md"),
      "```mx\nentity :Todo\n  actions\n    create :create\n      input\n        &titel\n```\n");
    for (const check of [checkDocsSyntaxV4, checkDocsSamples]) {
      const errors = check(dir).errors.join("\n");
      expect(errors).toContain("0050-entity-file-syntax.md");
      expect(errors).toContain("&titel is not a declared member");
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
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
];
for (const planted of oldForms) {
  test(`rejects planted old or invalid input spelling: ${planted.trim()}`, () => {
    const dir = mkdtempSync(join(tmpdir(), "mesh-v4-"));
    try {
      writeFileSync(join(dir, "planted.md"), `\`\`\`mx\nentity :Todo\n  actions\n${planted}\n\`\`\`\n`);
      expect(checkDocsSyntaxV4(dir).errors.join("\n")).toContain("is not written in syntax v4");
      expect(checkDocsSamples(dir).errors.join("\n")).toContain("is not written in syntax v4");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
}

const members = `import { List } from "./list.mesh.mx"
entity :Todo
  attributes
    string :title
  relationships
    belongs-to :list entity=List
`;
const memberFailures = [
  ["misspelled input", "  actions\n    create :create\n      input\n        &titel", "&titel is not a declared member"],
  ["generated key is not a member", "  actions\n    create :create\n      input\n        &listId", "&listId is not a declared member"],
  ["unknown sort member", "  actions\n    read :read\n      sort\n        asc &zzz", "&zzz is not a declared member"],
  ["unimported entity", "  relationships\n    belongs-to :other entity=Nope", "entity=Nope must name an import"],
  ["unknown dotted head", "  actions\n    read :read\n      filter=() => &missing.id === &list.id", "&missing is not a declared member"],
  ["input argument is not a member", "  actions\n    update :update\n      input\n        uuid :localId\n      do\n        set\n          &title=() => &localId", "&localId is not a declared member"],
  ["self not destructured", "  computed\n    string :label() {\n      return self.title\n    }", "self. requires self destructured"],
  ["plain self parameter is not destructuring", "  computed\n    string :label(self) {\n      return self.title\n    }", "self. requires self destructured"],
  ["self binding cannot leak from sibling", "  computed\n    string :bound({ self }) {\n      return self.title\n    }\n    string :unbound() {\n      return self.title\n    }", "self. requires self destructured"],
  ["nested function needs its own self binding", "  actions\n    read :read\n      filter=({ self }) => some(() => self.title)", "self. requires self destructured"],
  ["single-parameter arrow cannot inherit self", "  actions\n    read :read\n      filter=({ self }) => some(item => self.title)", "self. requires self destructured"],
  ["inline inner binding cannot leak outward", "  actions\n    read :read\n      filter=() => some(({ self }) => self.title) + self.title", "self. requires self destructured"],
] as const;
for (const [rule, planted, message] of memberFailures) {
  test(`the text guard, in both walkers, rejects ${rule}`, () => {
    const dir = mkdtempSync(join(tmpdir(), "mesh-v4-member-"));
    try {
      writeFileSync(join(dir, "planted.md"), `\`\`\`mx\n${members}${planted}\n\`\`\`\n`);
      for (const check of [checkDocsSyntaxV4, checkDocsSamples]) {
        const errors = check(dir).errors.join("\n");
        expect(errors).toContain("is not written in syntax v4");
        expect(errors).toContain(message);
      }
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
}

test("the member guard allows forward declarations, explicit Id names and function-local self", () => {
  const source = `import { List as TodoList } from "./list.mesh.mx"
entity :Todo
  actions on:load=&visible
    create :create
      input
        &title
        &listId
        &list
    read :visible
      filter=({ self }) => self.title === &title && (&flags & mask) === 0
      sort
        asc &label
    update :update
      do
        set
          &title=() => &label
  computed
    string :label({ self }) {
      return self.title + "&notAMember self.notARead"
    }
  attributes
    string :title match=/&notAMember/
    integer :flags
    uuid :listId
  relationships
    belongs-to :list entity=TodoList
  policies
    policy :owner actions=[&update]
      authorize-if=() => &list.ownerId === &listId
`;
  expect(oldSpellingInV4(source)).toBeNull();
  expect(parseV4(source, "positive.mx")).toEqual([]);
  expect(oldSpellingInV4(`${members}  actions\n    read :read\n      filter=({ self }) => some(item => item.title) + self.title\n`)).toBeNull();
  expect(oldSpellingInV4(`${members}  actions\n    read :read\n      filter=() => some(({ self }) => self.title)\n`)).toBeNull();
});

// Member placement is the parse's job now: MX lowers `&name` through MESH_SYNTAX
// and the production contracts refuse a member line out of place.
const placementFailures = [
  ["input assignment", "  actions\n    create :create\n      input\n        &title=1", "unknown attribute `value`"],
  ["input member options", "  actions\n    create :create\n      input\n        &title min=2", "only whitespace may follow it"],
  ["bare member in computed", "  computed\n    &title", "`<member>`"],
  ["member nested beneath input argument", "  actions\n    create :create\n      input\n        string :argument\n          &title", "`<member>`"],
  ["sort member outside sort", "  actions\n    read :read\n      asc &title", "`<asc>`"],
] as const;
for (const [rule, planted, message] of placementFailures) {
  test(`the parse, in both walkers, rejects ${rule}`, () => {
    const dir = mkdtempSync(join(tmpdir(), "mesh-v4-placement-"));
    try {
      writeFileSync(join(dir, "planted.md"), `\`\`\`mx\n${members}${planted}\n\`\`\`\n`);
      for (const check of [checkDocsSyntaxV4, checkDocsSamples]) {
        const errors = check(dir).errors.join("\n");
        expect(errors).toContain("MX block");
        expect(errors).toContain(message);
      }
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
}

test("fences parse as authored: comments, members and atoms need no adapting", () => {
  const source = '// todo.mesh.mx\nimport { List } from "./list.mesh.mx"\nentity :Todo\n  attributes\n    string :title\n    boolean :done\n    integer :flags\n  actions\n    create :create\n      input\n        &title\n    update :rename\n      do\n        set\n          &title=() => &title + "&title"\n    read :pending\n      filter=() => !&done && (&flags & mask) === 0\n      sort\n        asc &title\n';
  expect(oldSpellingInV4(source)).toBeNull();
  expect(parseV4(source, "todo.mx")).toEqual([]);
});

test("structural rejection stays on", () => {
  expect(parseV4('entity :Invoice\n// unindented\n  attributes\n    uuid :id\n', 'bad.mx').length).toBeGreaterThan(0);
});

test("syntax and static-file errors fail", () => {
  for (const code of [
    'entity :Todo\n  attributes\n    string :title min=\n',
    'entity :Todo\n  if=true\n    attributes\n      string :title\n',
  ]) expect(parseV4(code, "bad.mx").length).toBeGreaterThan(0);
});
