import { expect, test } from "bun:test";
import { parse } from "./helpers.ts";
import { build, keyed } from "./v4.ts";

const title = keyed + "    string :title\n";

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
