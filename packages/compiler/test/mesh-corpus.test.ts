// Mesh's golden parse corpus (see fixtures/mesh-corpus/README.md): every entity file in Mesh's repository
// and every `mx` block in its docs, lowered as `parseEntitySource` lowers them (Mesh's closed contracts as
// they were when the corpus was made, `tagRules: "none"`, `structural: "reject"`, `unknownTags: "reject"`,
// `imports: "pass"`) with `MESH_DIALECT`. The whole `LowerSourceResult` (the IR with its tags, attributes,
// atoms, members, imports and spans, the Babel nodes reduced to their shape and marks, and the
// diagnostics) is compared with `__golden__/golden.json`, which MX's reference module produced.
//
//   MESH_CORPUS_UPDATE=1 bun test packages/compiler/test/mesh-corpus.test.ts
//
// rewrites the golden (with MX's codes, through the dialect without its code map); review its diff like any other change.
//
// Since MX alpha.27 `MESH_DIALECT` renames MX's codes (`diagnosticCodes`, `src/front-end/diagnostic-codes.ts`). The golden is
// MX's file and records MX's codes, so the comparison renames the golden's codes through the same map (`meshCodes`): a code is
// still compared, under the name a Mesh user sees.
import { lowerSource, type Dialect, type LowerSourceResult } from "@mxlang/core";
import { describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { deepFreeze } from "../src/front-end/deep-freeze.ts";
import { MX_TO_MESH_CODES } from "../src/front-end/diagnostic-codes.ts";
import { MESH_DIALECT } from "../src/front-end/dialect.ts";
import { SYNTAX_DIALECT } from "./syntax-dialect.ts";
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

/** `MESH_DIALECT` without its code map: what `MESH_CORPUS_UPDATE=1` writes, since the golden records MX's own codes. */
const UNMAPPED: Dialect = deepFreeze((({ diagnosticCodes: _, ...rest }: Dialect) => rest)(MESH_DIALECT));

/** A file's lowering as plain JSON, under a stable virtual path so the golden names no machine's directory. */
function snapshot(rel: string, dialect: Dialect = MESH_DIALECT): unknown {
  const result = parseEntity(readFileSync(join(CORPUS, rel), "utf8"), `/mesh-corpus/${rel}`, dialect);
  return JSON.parse(
    JSON.stringify(result, (key, value) => (key === "loc" ? undefined : NODE_KEYS.has(key) ? babelNode(value) : value)),
  );
}

/** A golden entry with each MX code its diagnostics carry under the name `MESH_DIALECT` gives it; any other code stays. */
function meshCodes(entry: { diagnostics: { code?: string; message?: string }[] }): unknown {
  const map: Readonly<Record<string, string>> = MX_TO_MESH_CODES;
  const rename = (code: string | undefined) => (code !== undefined && Object.hasOwn(map, code) ? map[code] : code);
  return { ...entry, diagnostics: entry.diagnostics.map((d) => ("code" in d ? { ...d, code: rename(d.code) } : d)) };
}

describe("Mesh's golden parse corpus", () => {
  test("Mesh's explainUnknownTag never throws on a corpus tag", () => {
    const golden = JSON.parse(readFileSync(GOLDEN, "utf8"));
    for (const rel of FILES) {
      const codes = (golden[rel].diagnostics as { code?: string }[]).map((d) => d.code);
      expect(codes, rel).not.toContain("MX_DIALECT_HOOK_ERROR");
    }
  });

  test("holds 41 entity files and 22 doc blocks", () => {
    expect(FILES.filter((rel) => rel.startsWith("entities/"))).toHaveLength(41);
    expect(FILES.filter((rel) => rel.startsWith("docs/"))).toHaveLength(22);
  });

  test("every file lowers to the golden IR through MESH_DIALECT", () => {
    const actual = Object.fromEntries(FILES.map((rel) => [rel, snapshot(rel)]));
    if (process.env.MESH_CORPUS_UPDATE === "1") {
      const recorded = Object.fromEntries(FILES.map((rel) => [rel, snapshot(rel, UNMAPPED)]));
      writeFileSync(GOLDEN, `${JSON.stringify(recorded, null, 1)}\n`);
    }
    const golden = JSON.parse(readFileSync(GOLDEN, "utf8"));
    expect(Object.keys(golden)).toEqual(FILES);
    for (const rel of FILES) expect(actual[rel], rel).toEqual(meshCodes(golden[rel]));
  });

  // The column-21 refusal (`Expected a single expression, but found `:` after it.` at 5:21) is what a
  // dialect with no value row gives: the default value `:List :list` runs on as one expression. The
  // `atom-value` row claims `:List`, and the claimed default ends at the spaced `:list`.
  test("the old-relationship fixture is the unknown option `value` at 5:14", () => {
    const golden = JSON.parse(readFileSync(GOLDEN, "utf8"));
    expect(golden["entities/packages/compiler/test/fixtures/negative/old-relationship.mesh.mx"]).toEqual({
      diagnostics: [
        {
          severity: "error",
          code: "MX_UNKNOWN_ATTRIBUTE",
          message: "`belongs-to`: unknown option `value`",
          line: 5,
          column: 14,
          offset: 81,
          end: { line: 5, column: 20, offset: 87 },
        },
      ],
    });
  });

  test("the golden holds real lowerings (not a vacuous pass): atoms, members and diagnostics", () => {
    const text = readFileSync(GOLDEN, "utf8");
    for (const mark of ['"mxAtom"', '"mxMember"','"mesh:Atom"', '"member"', '"diagnostics"']) {
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
          code: "MESH_SYNTAX",
          message: "`async :l(…) { … }` is not supported: a `:name` method value cannot be async; remove `async`",
          line: 3,
          column: 17,
          offset: 38,
          end: { line: 3, column: 19, offset: 40 },
        },
      ],
    } as LowerSourceResult);
  });

  test("`async` with no method after it is a plain boolean attribute", () => {
    const { ir, diagnostics } = lowerSource("<a async/>\n<b async x=1/>\nc async\n", "/v/y.mesh.mx", { dialect: SYNTAX_DIALECT });
    expect(diagnostics).toEqual([]);
    const tags = (ir?.body ?? []).flatMap((node) => (node.kind === "DelegatedTag" ? [node.tag] : []));
    expect(tags.map((tag) => tag.attrs[0])).toMatchObject(
      [3, 14, 28].map((at) => ({ kind: "boolean", name: "async", nameSpan: { sourceStart: at, sourceEnd: at + 5 } })),
    );
  });
});
