// A name written against its tag (`uuid:id`) is not Mesh syntax: a line is `kind :name` (decisions log, 2026-10-10 18:50).
// Since MX alpha.17 a colon in a tag head is part of the tag name (`uuid:id` is one unknown tag), and a dialect's
// `afterLower` sees only the tags a contract names, so Mesh refuses the form in `lowerMesh` (`src/front-end/lower.ts`), from
// the lowered tag names. Every form lowers through `MESH_DIALECT`.
import type { CustomTag } from "@mxlang/core";
import { describe, expect, test } from "bun:test";
import { MESH_DIALECT } from "../src/front-end/dialect.ts";
import { lowerMesh } from "../src/front-end/lower.ts";

const attrs = { name: { type: "atom" } };
const tags = {
  entity: { attributes: attrs },
  attributes: {},
  string: { attributes: attrs },
  uuid: { attributes: attrs },
  set: { defaultTag: "setter" },
  setter: { attributes: attrs },
} as unknown as Record<string, CustomTag>;

const diagnostics = (source: string) => lowerMesh(source, "/v/x.mesh.mx", { dialect: MESH_DIALECT, customTags: tags }).diagnostics;

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
