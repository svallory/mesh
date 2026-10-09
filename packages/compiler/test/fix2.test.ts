import { expect, test } from "bun:test";
import { buildModel } from "../src/build.ts";
import { parse } from "./helpers.ts";
import { build, keyed } from "./v4.ts";

const title = keyed + "    string :title\n";

test("diagnostics follow authored positions, not validation phase order", () => {
  const result = build(title + "  actions\n    update :change\n      input\n        &titel\n      do\n        set\n          &title=foo\n");
  expect(result.diagnostics.map((d) => [d.code, d.position.line, d.position.column])).toEqual([
    ["MESH_UNKNOWN_MEMBER", 8, 8], ["MESH_MODEL_SHAPE", 11, 10],
  ]);
});

test("diagnostics are ordered by file before source position", () => {
  const source = keyed + "    mystery :field\n";
  const result = buildModel({ root: "/project", files: [
    { file: "z.mesh.mx", source }, { file: "a.mesh.mx", source },
  ] });
  expect(result.diagnostics.map((d) => d.position.file)).toEqual(["a.mesh.mx", "z.mesh.mx"]);
});

test.each([
  ["      input\n        member name=\"title\"\n", 8, 8],
  ["      do\n        set\n          member name=\"title\" value=\"new\"\n", 9, 10],
] as const)("authored member has one positioned error: %s", (body, line, column) => {
  const result = build(title + "  actions\n    update :change\n" + body);
  expect(result.document).toBeNull();
  expect(result.diagnostics).toEqual([
    expect.objectContaining({ code: "MESH_SYNTAX", message: expect.stringContaining("not a known tag"), position: expect.objectContaining({ line, column }) }),
  ]);
});

test("deduplication preserves distinct failures at the same position", () => {
  const result = build(keyed + "    string :title min=-1 max=-2\n");
  expect(result.diagnostics.map((d) => d.message)).toEqual([
    "min cannot exceed max", "String bounds must be non-negative integers",
  ]);
  expect(result.diagnostics[0]!.position).toEqual(result.diagnostics[1]!.position);
});

test.each([
  ['      input\n        &title="new"\n', "MESH_SYNTAX"],
  ["      do\n        set\n          &title\n", "MESH_MEMBER_LINE_OPTIONS"],
])("wildcard contracts reject invalid member-line shape: %s", (body, code) => {
  const source = title + "  actions\n    update :change\n" + body;
  expect(parse(source).diagnostics).toHaveLength(1);
  const result = build(source);
  expect(result.document).toBeNull();
  expect(result.diagnostics).toEqual([
    expect.objectContaining({ code }),
  ]);
});

test.each([
  "boolean :flag values=[:yes]",
  "boolean :flag min=0",
  "boolean :flag max=1",
  "boolean :flag match=/yes/",
  "string :label on=:create",
])("wrong-type options are rejected by contracts: %s", (field) => {
  const source = keyed + `    ${field}\n`;
  expect(parse(source).diagnostics).toHaveLength(1);
  expect(build(source).diagnostics).toEqual([
    expect.objectContaining({ code: "MESH_SYNTAX" }),
  ]);
});

// build.ts picks MESH_MEMBER_LINE_OPTIONS by matching MX's message text because
// alpha.11 diagnostics expose no code. Fail here, naming the cause, if MX rewords it.
test.each([
  ["      do\n        set\n          &title\n", "`<&title>` (inline contract): missing required attribute `value`"],
  ["      do\n        set\n          &title=1 min=2\n", "unknown attribute"],
])("MX message wording that build.ts matches for member-line options: %s", (body, wording) => {
  const messages = parse(title + "  actions\n    update :change\n" + body).diagnostics.map((d) => d.message);
  expect(messages).toHaveLength(1);
  expect(messages[0]).toContain(wording);
  expect(messages[0]).toMatch(/`<&[A-Za-z_][A-Za-z0-9_]*>`.*(?:unknown attribute|missing required attribute)/);
});
