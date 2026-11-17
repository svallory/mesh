// MX's diagnostic codes reach Mesh's output under Mesh's names (MX alpha.23: every error and warning has a stable code; alpha.27:
// the dialect's `diagnosticCodes` renames them, `MX_TO_MESH_CODES`, pinned in `diagnostic-codes.test.ts`). A Mesh hook's `MESH_*`
// code is unchanged; `MESH_SYNTAX` is only the fallback for a diagnostic that arrives with none.
import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { fixture, fixtureDir } from "./helpers.ts";
import { buildModel, meshDiagnostic, parseEntitySource, relationshipValueFix, staticFileFix, type MxDiagnostic } from "../src/front-end/build.ts";
import { build, keyed } from "./v4.ts";

describe("MX codes arrive as Mesh's", () => {
  test("an unknown tag in an entity file is MESH_UNKNOWN_TAG, positioned at the tag", () => {
    const result = buildModel({ root: "/project", files: [{ file: "todo.mesh.mx", source: "entity :Todo\n  mystery :x\n" }] });
    expect(result.document).toBeNull();
    expect(result.diagnostics).toEqual([
      expect.objectContaining({ severity: "error", code: "MESH_UNKNOWN_TAG", position: expect.objectContaining({ file: "todo.mesh.mx", line: 2, column: 2 }) }),
    ]);
  });

  test.each([
    ["an unknown option", keyed + "    boolean :ok min=0\n", "MESH_UNKNOWN_OPTION"],
  ])("%s has Mesh's name for MX's code", (_, source, code) => {
    const found = build(source).diagnostics;
    expect(found.length).toBeGreaterThan(0);
    expect(found[0]!.code).toBe(code);
  });

  test("no diagnostic MX reports for a Mesh source reaches the MESH_SYNTAX fallback", () => {
    for (const source of ["entity :T\n  mystery\n", "let x\n", "entity :T\n  attributes\n    string :a min=\n", "entity\n"]) {
      for (const d of parseEntitySource(source, "t.mesh.mx").diagnostics) expect(d.code, d.message).toBeString();
    }
  });
});

describe("a Mesh hook's own code is unchanged", () => {
  test("MESH_UNSPACED_NAME from the dialect hook", () => {
    const result = buildModel({ root: "/project", files: [{ file: "todo.mesh.mx", source: "entity:Todo\n" }] });
    expect(result.diagnostics.map((d) => d.code)).toEqual(["MESH_UNSPACED_NAME"]);
  });
});

describe("meshDiagnostic", () => {
  const base = { severity: "error", message: "m", line: 3, column: 4, offset: 20 } as const;
  test("a diagnostic with no code is MESH_SYNTAX", () => {
    expect(meshDiagnostic(base as MxDiagnostic, "a.mesh.mx")).toEqual({
      severity: "error", code: "MESH_SYNTAX", message: "m", position: { file: "a.mesh.mx", line: 3, column: 4, offset: 20 }, fix: null,
    });
  });
  test.each(["MESH_UNKNOWN_TAG", "MX_DIALECT_HOOK_ERROR", "MESH_UNSPACED_NAME", "MESH_ANYTHING"])("%s is kept as it is", (code) => {
    expect(meshDiagnostic({ ...base, code } as MxDiagnostic, "a.mesh.mx").code).toBe(code);
  });
  test("a warning keeps its severity and code", () => {
    const d = meshDiagnostic({ ...base, severity: "warning", code: "MESH_DUPLICATE_OPTION" } as MxDiagnostic, "a.mesh.mx");
    expect([d.severity, d.code]).toEqual(["warning", "MESH_DUPLICATE_OPTION"]);
  });
});

// `MX_DIALECT_ERROR` is MX's code for a Mesh hook that fails without naming a code, `MX_DIALECT_HOOK_ERROR` for one that throws.
// Both would present a Mesh error as MX's, so no Mesh fixture may produce either.
describe("no Mesh hook error is reported as MX's", () => {
  const forbidden = /MX_DIALECT_ERROR|MX_DIALECT_HOOK_ERROR/;
  test.each([
    "fixtures/atom-contracts.json",
    "fixtures/mesh-corpus/__golden__/golden.json",
  ])("%s records neither code", (rel) => {
    const text = readFileSync(new URL(rel, import.meta.url), "utf8");
    expect(text).toContain('"code"');
    expect(forbidden.test(text)).toBe(false);
  });
  test("no negative fixture produces either code", () => {
    const files = readdirSync(`${fixtureDir}negative`).filter((f) => f.endsWith(".mesh.mx"));
    expect(files.length).toBeGreaterThan(20);
    for (const f of files) {
      for (const d of build(fixture(`negative/${f}`).source).diagnostics) expect(d.code, f).not.toMatch(forbidden);
    }
  });
});

// A relationship once took its entity as the line's value (`belongs-to=:List :list`, syntax v3); since the operator's ruling
// of 2026-10-08 it is `kind :name entity=Identifier`. MX reports the old form as the unknown option `value`, and Mesh adds a
// `fix:` line beside MX's message, as `staticFileFix` does. Message, code, position and every other diagnostic stay MX's.
describe("the relationship fix line", () => {
  const fixFor = (kind: string) =>
    `a relationship takes no value after \`=\`: write its name after a space and its entity as an option, \`${kind} :<name> entity=<Entity>\``;
  const synthetic = (code: string, message: string) => ({ severity: "error", code, message, line: 1, column: 0, offset: 0 }) as MxDiagnostic;

  test.each(["belongs-to", "has-many", "has-one"])("`%s` with the unknown option `value` gets the fix with its kind", (kind) => {
    expect(relationshipValueFix(synthetic("MESH_UNKNOWN_OPTION", `\`${kind}\`: unknown option \`value\``))).toBe(fixFor(kind));
  });
  test("the message with a suffix (`belongs-to :list=:List`) still gets the fix", () => {
    const d = synthetic("MESH_UNKNOWN_OPTION", "`belongs-to`: unknown option `value` (set by `:list=…`)");
    expect(relationshipValueFix(d)).toBe(fixFor("belongs-to"));
  });
  test.each([
    ["another kind", "MESH_UNKNOWN_OPTION", "`entity`: unknown option `value`"],
    ["another option", "MESH_UNKNOWN_OPTION", "`belongs-to`: unknown option `foo`"],
    ["a kind that only ends like one", "MESH_UNKNOWN_OPTION", "`x-belongs-to`: unknown option `value`"],
    ["the right message under another code", "MESH_OPTION_VALUE", "`belongs-to`: unknown option `value`"],
    ["no code", undefined, "`belongs-to`: unknown option `value`"],
  ])("%s gives no fix", (_, code, message) => {
    expect(relationshipValueFix(synthetic(code as string, message))).toBeNull();
  });
  test("meshDiagnostic carries the fix, and `staticFileFix`'s diagnostic keeps its own", () => {
    expect(meshDiagnostic(synthetic("MESH_UNKNOWN_OPTION", "`has-one`: unknown option `value`"), "a.mesh.mx").fix).toBe(fixFor("has-one"));
    const forLoop = meshDiagnostic(synthetic("MESH_STRUCTURAL_CONSTRUCT", "Mesh files are static, so they do not evaluate `for`"), "a.mesh.mx");
    expect(forLoop.fix).toBe(staticFileFix(synthetic("MESH_STRUCTURAL_CONSTRUCT", "Mesh files are static, so they do not evaluate `for`")));
    expect(forLoop.fix).toStartWith("a Mesh file has no loops");
  });

  const imports = 'import { List } from "./list.mesh.mx"\nimport { Item } from "./item.mesh.mx"\nimport { Profile } from "./profile.mesh.mx"\nimport { Tagging } from "./tagging.mesh.mx"\n';
  const plain = (name: string, extra = "") => `entity :${name}\n  attributes\n    uuid :id primary-key\n${extra}  actions auto=[:read]\n`;
  const back = 'import { Todo } from "./todo.mesh.mx"\n';
  const others = [
    { file: "list.mesh.mx", source: plain("List") },
    // has-many and has-one need a belongs-to back (MESH_NO_INVERSE), so Item and Profile have one
    { file: "item.mesh.mx", source: back + plain("Item", "  relationships\n    belongs-to :todo entity=Todo\n") },
    { file: "profile.mesh.mx", source: back + plain("Profile", "  relationships\n    belongs-to :todo entity=Todo\n") },
    { file: "tagging.mesh.mx", source: plain("Tagging") },
  ];
  /** Every diagnostic of `todo.mesh.mx` as `[code, message, fix, line, column]`; the head adds the imports' 4 lines. */
  const report = (source: string) =>
    buildModel({ root: "/project", files: [{ file: "todo.mesh.mx", source: imports + source }, ...others] })
      .diagnostics.filter((d) => d.position.file === "todo.mesh.mx")
      .map((d) => [d.code, d.message, d.fix, d.position.line, d.position.column]);
  const relationship = (line: string) => keyed + `  relationships\n    ${line}\n`;
  const unknownValue = (kind: string) => `\`${kind}\`: unknown option \`value\``;

  test.each([
    ["belongs-to=:List :list", "belongs-to"],
    ["has-many=:Item :items", "has-many"],
    ["has-one=:Profile :profile", "has-one"],
    ["belongs-to=:List", "belongs-to"],
    ["belongs-to=List", "belongs-to"],
    ["belongs-to=:list entity=List", "belongs-to"],
    ["has-many=:items entity=Item", "has-many"],
    ["belongs-to=:invoice_line :line", "belongs-to"],
  ])("`%s` keeps MX's message and position and gets the fix", (line, kind) => {
    expect(report(relationship(line))).toEqual([["MESH_UNKNOWN_OPTION", unknownValue(kind), fixFor(kind), 9, 4 + kind.length]]);
  });
  test("`belongs-to :list=:List` keeps MX's suffixed message and position and gets the fix", () => {
    expect(report(relationship("belongs-to :list=:List"))).toEqual([
      ["MESH_UNKNOWN_OPTION", "`belongs-to`: unknown option `value` (set by `:list=…`)", fixFor("belongs-to"), 9, 21],
    ]);
  });
  test("a file with another error keeps both diagnostics; only the relationship gets the fix", () => {
    const source = "entity :Todo\n  attributes\n    string=:text :title\n  relationships\n    belongs-to=:List :list\n";
    expect(report(source)).toEqual([
      ["MESH_OPTION_VALUE", "`string`: option `value` must be function, got atom", null, 7, 10],
      ["MESH_UNKNOWN_OPTION", unknownValue("belongs-to"), fixFor("belongs-to"), 9, 14],
    ]);
  });
  test("two old lines in one file give two diagnostics, each with its fix", () => {
    expect(report(keyed + "  relationships\n    belongs-to=:List :list\n    has-many=:Item :items\n")).toEqual([
      ["MESH_UNKNOWN_OPTION", unknownValue("belongs-to"), fixFor("belongs-to"), 9, 14],
      ["MESH_UNKNOWN_OPTION", unknownValue("has-many"), fixFor("has-many"), 10, 12],
    ]);
  });
  test("an old relationship line in an event is MESH_TAG_NOT_ALLOWED with no fix", () => {
    const found = buildModel({ root: "/project", files: [{ file: "moved.mesh.mx", source: "event :Moved\n  uuid :id\n  belongs-to=:List :list\n" }] })
      .diagnostics.map((d) => [d.code, d.fix, d.position.line]);
    expect(found).toEqual([["MESH_TAG_NOT_ALLOWED", null, 3]]);
  });
  test("the legal relationship lines lower with no diagnostic", () => {
    expect(report(relationship("belongs-to :list entity=List\n    has-many :items entity=Item\n    has-one :profile entity=Profile"))).toEqual([]);
  });
  test.each([
    "belongs-to :list entity=:List",
    "has-many :items entity=Item through=:Tagging",
  ])("`%s` stays MESH_ENTITY_REFERENCE with no fix", (line) => {
    const found = report(relationship(line));
    expect(found.map((d) => [d[0], d[2]])).toEqual([["MESH_ENTITY_REFERENCE", null]]);
  });
  test("`entity=:Todo :todo` keeps MX's unknown option `value` with no fix", () => {
    expect(report("entity=:Todo :todo\n  attributes\n    uuid :id primary-key\n")).toEqual([
      ["MESH_UNKNOWN_OPTION", unknownValue("entity"), null, 5, 6],
    ]);
  });
  test.each([
    ["policy=:allow :p", "policy", keyed + "  policies\n    policy=:allow :p\n"],
    ["create=:create :c", "create", keyed + "  actions\n    create=:create :c\n"],
  ])("`%s` keeps MX's unknown option `value` with no fix", (_, kind, source) => {
    expect(report(source)).toEqual([["MESH_UNKNOWN_OPTION", unknownValue(kind), null, 9, 10]]);
  });
  test.each([
    ["belongs-to=List :list", "MESH_EXPECTED_SINGLE_EXPRESSION"],
    ["has-many=:billing.Item :items", "MESH_EXPECTED_SINGLE_EXPRESSION"],
    ["belongs-to=::Foo", "MESH_SYNTAX"],
  ])("`%s` stays MX's parse error with no fix", (line, code) => {
    const found = report(relationship(line));
    expect(found.map((d) => [d[0], d[2]])).toEqual([[code, null]]);
  });
});
