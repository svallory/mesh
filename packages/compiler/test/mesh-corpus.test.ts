// Mesh's golden parse corpus (see fixtures/mesh-corpus/README.md): every entity file in Mesh's repository
// and every `mx` block in its docs, lowered as `parseEntitySource` lowers them (Mesh's closed contracts as
// they were when the corpus was made, `tagRules: "none"`, `structural: "reject"`, `unknownTags: "reject"`,
// `imports: "pass"`) with `MESH_DIALECT`. The whole `LowerSourceResult` (the IR with its tags, attributes,
// atoms, members, imports and spans, the Babel nodes reduced to their shape and marks, and the
// diagnostics) is compared with `__golden__/golden.json`, which MX's reference module produced.
//
//   MESH_CORPUS_UPDATE=1 bun test packages/compiler/test/mesh-corpus.test.ts
//
// rewrites the golden; review its diff like any other change.
import { lowerSource, type LowerSourceResult } from "@mxlang/core";
import { describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { MESH_DIALECT } from "../src/front-end/dialect.ts";
import { CORPUS, GOLDEN, corpusFiles, parseEntity } from "./mesh-corpus.ts";

const FILES = corpusFiles();

/** The IR keys that hold a parser (Babel) node, or a list of them. */
const NODE_KEYS = new Set(["node", "paramNodes", "declaration"]);

/**
 * A Babel node as the golden holds it: its shape (`type` and every semantic field) and the `mx*` marks a
 * dialect sets on `extra` (`mxAtom`, `mxMember`, `mxTrigger`), without the node's positions (`start`, `end`,
 * `loc`, `range`) or the rest of `extra`. The positions are already in the IR where Mesh reads them.
 */
function babelNode(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(babelNode);
  if (value === null || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (key === "start" || key === "end" || key === "loc" || key === "range") continue;
    if (key === "extra") {
      const marks = Object.entries(child as object).filter(([name]) => name.startsWith("mx"));
      if (marks.length > 0) out.extra = Object.fromEntries(marks);
      continue;
    }
    out[key] = babelNode(child);
  }
  return out;
}

/** A file's lowering as plain JSON, under a stable virtual path so the golden names no machine's directory. */
function snapshot(rel: string): unknown {
  const result = parseEntity(readFileSync(join(CORPUS, rel), "utf8"), `/mesh-corpus/${rel}`);
  return JSON.parse(
    JSON.stringify(result, (key, value) => (key === "loc" ? undefined : NODE_KEYS.has(key) ? babelNode(value) : value)),
  );
}

describe("Mesh's golden parse corpus", () => {
  test("holds 41 entity files and 22 doc blocks", () => {
    expect(FILES.filter((rel) => rel.startsWith("entities/"))).toHaveLength(41);
    expect(FILES.filter((rel) => rel.startsWith("docs/"))).toHaveLength(22);
  });

  test("every file lowers to the golden IR through MESH_DIALECT", () => {
    const actual = Object.fromEntries(FILES.map((rel) => [rel, snapshot(rel)]));
    if (process.env.MESH_CORPUS_UPDATE === "1") writeFileSync(GOLDEN, `${JSON.stringify(actual, null, 1)}\n`);
    const golden = JSON.parse(readFileSync(GOLDEN, "utf8"));
    expect(Object.keys(golden)).toEqual(FILES);
    for (const rel of FILES) expect(actual[rel], rel).toEqual(golden[rel]);
  });

  // The column-21 refusal (`Expected a single expression, but found `:` after it.` at 5:21) is what a
  // dialect with no value row gives: the default value `:List :list` runs on as one expression. The
  // `atom-value` row claims `:List`, and the claimed default ends at the spaced `:list`.
  test("the old-relationship fixture is the unknown attribute `value` at 5:14", () => {
    const golden = JSON.parse(readFileSync(GOLDEN, "utf8"));
    expect(golden["entities/packages/compiler/test/fixtures/negative/old-relationship.mesh.mx"]).toEqual({
      diagnostics: [{ severity: "error", message: "`<belongs-to>`: unknown attribute `value`", line: 5, column: 14, offset: 81 }],
    });
  });

  test("the golden holds real lowerings (not a vacuous pass): atoms, members and diagnostics", () => {
    const text = readFileSync(GOLDEN, "utf8");
    for (const mark of ['"mxAtom"', '"mxMember"','"atom"', '"member"', '"diagnostics"']) {
      expect(text).toContain(mark);
    }
  });
});

describe("`async` before a `:name` method under Mesh's contracts", () => {
  test("is refused at `:l`, naming the form", () => {
    expect(parseEntity('entity :T\n  computed\n    string async :l() { return "x" }\n', "/v/x.mesh.mx")).toEqual({
      diagnostics: [
        {
          severity: "error",
          message: "`async :l(…) { … }` is not supported: a `:name` method value cannot be async; remove `async`",
          line: 3,
          column: 17,
          offset: 38,
        },
      ],
    } as LowerSourceResult);
  });

  test("`async` with no method after it is a plain boolean attribute", () => {
    const { ir, diagnostics } = lowerSource("<a async/>\n<b async x=1/>\nc async\n", "/v/y.mesh.mx", { dialect: MESH_DIALECT });
    expect(diagnostics).toEqual([]);
    const tags = (ir?.body ?? []).flatMap((node) => (node.kind === "DelegatedTag" ? [node.tag] : []));
    expect(tags.map((tag) => tag.attrs[0])).toMatchObject(
      [3, 14, 28].map((at) => ({ kind: "boolean", name: "async", nameSpan: { sourceStart: at, sourceEnd: at + 5 } })),
    );
  });
});
