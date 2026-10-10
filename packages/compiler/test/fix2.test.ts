import { expect, test } from "bun:test";
import { buildModel } from "../src/front-end/build.ts";
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

// MX's member-line errors (an input assignment, options after the line) are
// MESH_SYNTAX at MX's position; a `set` line without a value is the builder's
// MESH_MEMBER_LINE_OPTIONS at the line.
test.each([
  ['      input\n        &title="new"\n', "MESH_SYNTAX", 8, 8, 1],
  ["      do\n        set\n          &title=1 min=2\n", "MESH_SYNTAX", 9, 19, 1],
  ["      do\n        set\n          &title\n", "MESH_MEMBER_LINE_OPTIONS", 9, 10, 0],
] as const)("invalid member-line shape: %s", (body, code, line, column, mxErrors) => {
  const source = title + "  actions\n    update :change\n" + body;
  expect(parse(source).diagnostics).toHaveLength(mxErrors);
  const result = build(source);
  expect(result.document).toBeNull();
  expect(result.diagnostics).toEqual([
    expect.objectContaining({ code, position: expect.objectContaining({ line, column }) }),
  ]);
});

test.each([
  "&title=\"new\"",
  "&title=() => \"new\"",
])("a set member line with a value builds: %s", (line) => {
  expect(build(title + `  actions\n    update :change\n      do\n        set\n          ${line}\n`).diagnostics).toEqual([]);
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

test.each([
  ["(() => { &done = true; return true })", [["MESH_MEMBER_ASSIGN", 6, 33]]],
  ["(() => { &done++; return true })", [["MESH_MEMBER_ASSIGN", 6, 33]]],
  ["(() => { &done.x = 1; return true })", [["MESH_MEMBER_ASSIGN", 6, 33]]],
  ["(() => { &done[0] = 1; return true })", [["MESH_MEMBER_ASSIGN", 6, 33]]],
  ["(() => { const o = {}; o[&done] = 1; return true })", []],
  ["(() => &done === true)", []],
  ["(() => { const done = &done; return done })", []],
] as const)("MESH_MEMBER_ASSIGN is positioned on the assignment: %s", (filter, expected) => {
  const source = keyed + `    boolean :done\n  actions\n    read :custom filter=${filter}\n`;
  const result = build(source);
  expect(result.diagnostics.map((d) => [d.code, d.position.line, d.position.column])).toEqual(expected.map((e) => [...e]));
  if (expected.length) expect(result.diagnostics[0]!.message).toBe("`&done` cannot be assigned inside an expression; use a `set` line");
});

test.each([
  ["          &title=\"a\"\n          &title=\"b\"\n", [["MESH_DUPLICATE_SET", 11, 10]]],
  ["          &title=\"a\"\n          &done=true\n", []],
] as const)("MESH_DUPLICATE_SET is positioned on the second line: %s", (lines, expected) => {
  const source = title + "    boolean :done\n  actions\n    update :change\n      do\n        set\n" + lines;
  const result = build(source);
  expect(result.diagnostics.map((d) => [d.code, d.position.line, d.position.column])).toEqual(expected.map((e) => [...e]));
  if (expected.length) expect(result.diagnostics[0]!.message).toBe("`&title` is set twice in this action");
});

test("the same member in two separate set blocks is not a duplicate", () => {
  const source = title + "  actions\n    update :change\n      do\n        when=() => true\n          set\n            &title=\"a\"\n        set\n          &title=\"b\"\n";
  expect(build(source).diagnostics).toEqual([]);
});
