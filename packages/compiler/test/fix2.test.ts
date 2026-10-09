import { expect, test } from "bun:test";
import { parse } from "./helpers.ts";
import { build, keyed } from "./v4.ts";

const title = keyed + "    string :title\n";

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
