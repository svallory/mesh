// A name written against its tag (`uuid:id`) is not Mesh syntax: a line is `kind :name` (decisions log, 2026-10-10 18:50).
// Since MX alpha.17 a colon in a tag head is part of the tag name (`uuid:id` is one unknown tag), and a dialect's
// `afterLower` sees only the tags a contract names, so Mesh refuses the form in the dialect's `explainUnknownTag`
// (`src/front-end/dialect.ts`, MX hook). Every form lowers through `MESH_DIALECT`.
import { lowerSource, type CustomTag } from "@mxlang/core";
import { describe, expect, test } from "bun:test";
import { MESH_DIALECT } from "../src/front-end/dialect.ts";

const attrs = { name: { type: "mesh:Atom" } };
const tags = {
  entity: { attributes: attrs },
  attributes: {},
  string: { attributes: attrs },
  uuid: { attributes: attrs },
  set: { defaultTag: "setter" },
  setter: { attributes: attrs },
} as unknown as Record<string, CustomTag>;

const diagnostics = (source: string) => lowerSource(source, "/v/x.mesh.mx", { dialect: { ...MESH_DIALECT, contracts: tags } }).diagnostics;

describe("the unspaced tag-head name is refused, showing the spaced spelling", () => {
  test.each([
    ["concise kind:name", "entity :T\n  attributes\n    uuid:id\n", "uuid:id", "uuid :id", 3, 4],
    ["concise entity:Todo", "entity:Todo\n", "entity:Todo", "entity :Todo", 1, 0],
    ["a hyphenated name", "entity :T\n  attributes\n    string:first-name\n", "string:first-name", "string :first-name", 3, 4],
    ["an html tag", "<entity :T>\n  <attributes><string:title/></attributes>\n</entity>", "string:title", "string :title", 2, 15],
    ["an html entity", "<entity:Todo/>", "entity:Todo", "entity :Todo", 1, 1],
    ["an empty tag head", "<set>\n  <:x/>\n</set>", ":x", "setter :x", 2, 3],
  ])("%s", (_, source, written, spaced, line, column) => {
    const found = diagnostics(source);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({
      severity: "error",
      code: "MESH_UNSPACED_NAME",
      message: `\`${written}\` writes the name against the tag; Mesh writes a name after a space: \`${spaced}\``,
      line,
      column,
    });
  });

  test("the spaced forms are accepted", () => {
    expect(diagnostics("entity :T\n  attributes\n    uuid :id\n    string :first-name\n")).toEqual([]);
    expect(diagnostics("<entity :T><attributes><string :title/></attributes></entity>")).toEqual([]);
    expect(diagnostics("<set><setter :x/></set>")).toEqual([]);
  });
});

describe("Mesh's explainUnknownTag leaves every other unknown tag to MX", () => {
  test("a plain unknown tag keeps MX's own code", () => {
    const found = lowerSource("<entity :T><bogus/></entity>", "/v/x.mesh.mx", { dialect: { ...MESH_DIALECT, contracts: tags } }).diagnostics;
    expect(found.map((d) => d.code)).toEqual(["MESH_UNKNOWN_TAG"]);
  });
  test("in reject mode inside a closed parent, an unspaced tag still gives one Mesh error", () => {
    const found = lowerSource("<entity :T>\n  <attributes><string:title/></attributes>\n</entity>", "/v/x.mesh.mx", {
      dialect: { ...MESH_DIALECT, contracts: tags },
    }).diagnostics;
    expect(found.map((d) => d.code)).toEqual(["MESH_UNSPACED_NAME"]);
  });
});

describe("an unnamed tag in a closed parent (the nearest parent's defaultTag)", () => {
  test.each(["reject", "allow"] as const)("<set><#a/></set> reports exactly one error in %s mode", (unknownTags) => {
    const found = lowerSource("<set><#a/></set>", "/v/x.mesh.mx", { dialect: { ...MESH_DIALECT, contracts: tags }, unknownTags }).diagnostics;
    expect(found.filter((d) => d.severity === "error")).toHaveLength(1);
  });
});
