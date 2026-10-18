// The atom contract checks (`values`, `pattern`, `ref`, `declares`) as Mesh's dialect runs them (ported from MX's
// `lowered-unit.test.ts`, `ir-entry/contract-fields.test.ts` and `ir-entry/lower-source.test.ts` at MX commit 750c80ec1).
// `SYNTAX_DIALECT` claims those contract keys (`contractFields`) and checks them in `checkContract` and `afterLower`.
// The expected diagnostics are literal data in `fixtures/atom-contracts.json` (message, line, column, offset, code, one
// entry per source), generated once from the output MX's reference module and core's built-in path agreed on. Nothing
// here lowers without `SYNTAX_DIALECT`, so the tests do not depend on core's own Mesh behaviour (core is dropping it).
//
//   MESH_CONTRACTS_UPDATE=1 bun test packages/compiler/test/atom-contracts.test.ts
//
// rewrites the data; review its diff like any other change.
import { lowerSource, type CustomTag, type Dialect, type LowerSourceOptions } from "@mxlang/core";
import { afterAll, describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SYNTAX_DIALECT } from "./syntax-dialect.ts";
import { FAILING, PASSING, REGISTRATION, vocab } from "./atom-contract-cases.ts";

const MESH: LowerSourceOptions = { dialect: SYNTAX_DIALECT };
/**
 * The matrix below sets a `node`'s `id` with MX's `#id` shorthand (`<node#a/>`), as the data was recorded. Mesh's dialect has no
 * tag shorthands since MX 0.1.0-alpha.28 (`tagShorthands: false`, `src/front-end/syntax/mesh.ts`), where `<node#a/>` is
 * `MESH_NO_TAG_SHORTHAND`. The cases check the contract hooks, not the line head, so they run with the shorthands on and the
 * recorded data stays as it was; `id="a"` under Mesh's own table declares the same (the last test of the block).
 */
const SHORTHANDS: LowerSourceOptions = {
  dialect: Object.freeze({ ...SYNTAX_DIALECT, table: Object.freeze({ ...SYNTAX_DIALECT.table, tagShorthands: true }) }) as Dialect,
};

const DATA = join(import.meta.dir, "fixtures/atom-contracts.json");
const update = process.env.MESH_CONTRACTS_UPDATE === "1";
const recorded: Record<string, unknown> = update ? {} : JSON.parse(readFileSync(DATA, "utf8"));
if (update) afterAll(() => writeFileSync(DATA, `${JSON.stringify(recorded, null, 1)}\n`));

/** `actual` equals the diagnostics recorded under `key` (when updating, `actual` is recorded instead). */
function expectRecorded(key: string, actual: unknown): void {
  if (update) recorded[key] = actual;
  expect(Object.hasOwn(recorded, key), `no recorded data for ${key}`).toBe(true);
  expect(actual).toEqual(recorded[key]);
}

// Deliberately `customTags`: these cases pin what the dialect's contract hooks do with a contract MX is handed per call. A malformed
// contract in `Dialect.contracts` instead stops the whole dialect (`MX_INVALID_DIALECT_CONTRACT`: a dialect that fails to load renames no code), pinned in `dialect-contracts.test.ts`.
const diagnosticsOf = (source: string, tags: Record<string, CustomTag>, options: LowerSourceOptions, file = "/v/x.mx") =>
  lowerSource(source, file, { ...options, customTags: tags }).diagnostics;

describe("the dialect's contract checks", () => {
  test.each(FAILING.map((s) => [s]))("rejects: %s", (source) => {
    const found = diagnosticsOf(source, vocab, SHORTHANDS);
    expect(found.length).toBeGreaterThan(0);
    expect(found[0]?.severity).toBe("error");
    expectRecorded(`vocab|${source}`, found);
  });

  test.each(PASSING.map((s) => [s]))("accepts: %s", (source) => {
    expect(diagnosticsOf(source, vocab, SHORTHANDS)).toEqual([]);
  });

  test.each(REGISTRATION.map(([name, tags]) => [name, tags] as const))("registration: %s", (name, tags) => {
    // The tag is never called: `checkContract` runs at registration, file-level.
    const found = diagnosticsOf("<div/>", tags, MESH);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ severity: "error", line: 1, column: 0, offset: 0 });
    expectRecorded(`registration|${name}`, found);
    expect(diagnosticsOf("<box/>", tags, MESH)).toEqual(found);
  });

  test("a duplicate declaration names both places", () => {
    const [d] = diagnosticsOf("<node#a/>\n<node#a/>", vocab, SHORTHANDS);
    expect(d?.message).toBe("`a` is already declared as `node` at 1:7");
    expect([d?.line, d?.column]).toEqual([2, 6]);
  });

  test("under Mesh's own table `id=` declares as the shorthand did, and the shorthand is MESH_NO_TAG_SHORTHAND", () => {
    const [d] = diagnosticsOf('<node id="a"/>\n<node id="a"/>', vocab, MESH);
    expect(d?.message).toBe("`a` is already declared as `node` at 1:10");
    expect([d?.line, d?.column]).toEqual([2, 9]);
    expect(diagnosticsOf('<node id="a"/><link to=:a/>', vocab, MESH)).toEqual([]);
    expect(diagnosticsOf("<node#a/>", vocab, MESH).map((x) => [x.code, x.line, x.column])).toEqual([["MESH_NO_TAG_SHORTHAND", 1, 5]]);
  });
});

const customTags: Record<string, CustomTag> = {
  entity: { attributes: { name: { type: "mesh:Atom" } } },
  attributes: {},
  actions: {},
  arguments: {},
  string: {
    attributes: { name: { type: "mesh:Atom" } },
    declares: [
      { kind: "attribute", from: "name", under: "attributes" },
      { kind: "argument", from: "name", under: "arguments", scope: "action" },
    ],
  },
  action: { attributes: { name: { type: "mesh:Atom" } }, declares: { kind: "action", from: "name" } },
  policy: {
    attributes: {
      // MX's `atom` type took one atom or a list; a node-type slot is one or the other, so the slots written as lists are lists.
      accept: { type: "array", items: "mesh:Atom", ref: "attribute" },
      require: { type: "array", items: "mesh:Atom", ref: ["attribute", "argument"] },
      types: { type: "mesh:Atom", values: ["create", "read", "update", "destroy"] },
      slug: { type: "mesh:Atom", pattern: "^[a-z]+$" },
    },
  },
} as unknown as Record<string, CustomTag>;

const ENTITY_FAILING: readonly string[] = [
  "entity :Invoice\n  attributes\n    string :title\n    string :body\n  policy accept=[:title, :bdy]\n",
  'entity :Invoice\n  attributes\n    string :title\n  policy accept="title"\n',
  "entity :Invoice\n  policy types=:craete\n",
  "entity :Invoice\n  policy slug=:Upper\n",
  "entity :Invoice\n  attributes\n    string :title\n    string :title\n",
  "entity :Invoice\n  actions\n    action :rename\n      arguments\n        string :newTitle\n    action :other\n      policy require=[:newTitle]\n",
  "entity :Invoice\n  arguments\n    string :orphan\n",
];

const ENTITY_PASSING =
  "entity :Invoice\n  attributes\n    string :title\n  actions\n    action :rename\n      arguments\n        string :newTitle\n      policy require=[:title, :newTitle] types=:update slug=:abc\n";

describe("an entity file through the dialect", () => {
  test.each(ENTITY_FAILING.map((s) => [s]))("one error: %s", (source) => {
    const found = diagnosticsOf(source, customTags, MESH, "/v/invoice.mx");
    expect(found).toHaveLength(1);
    expect(found[0]?.severity).toBe("error");
    expectRecorded(`entity|${source}`, found);
  });

  test("accepts a file that uses every check correctly", () => {
    expect(diagnosticsOf(ENTITY_PASSING, customTags, MESH)).toEqual([]);
  });

  test.each([
    ["called", "box\n"],
    ["never called", "other\n"],
  ])("a malformed claimed key is a file-level registration error on a tag %s", (_, source) => {
    const tags = { other: {}, box: { attributes: { a: { type: "string", values: ["a"] } } } } as unknown as Record<string, CustomTag>;
    const expected = {
      severity: "error" as const,
      code: "MESH_SYNTAX",
      message: 'Invalid "a" attribute declaration of tag "box": `values` requires `type: "mesh:Atom"` (or `type: "array"` with `items: "mesh:Atom"`)',
      line: 1,
      column: 0,
      offset: 0,
    };
    expect(diagnosticsOf(source, tags, MESH)).toEqual([expected]);
  });
});

describe("a dialect's own contract key", () => {
  test("passes registration and reaches `afterLower`, whose `fail` is a positioned, coded diagnostic", () => {
    const source = "entity :Invoice\n  index on=:title\n";
    const tags = {
      entity: { attributes: { name: { type: "mesh:Atom" } } },
      index: { attributes: { on: { type: "mesh:Atom", unique: true } }, relations: "many" },
    } as unknown as Record<string, CustomTag>;
    // Without a dialect that claims it, `unique` is an unknown key.
    expect(diagnosticsOf(source, tags, MESH)[0]?.message).toMatch(/Unknown key "(relations|unique)"/);

    const seen: unknown[] = [];
    const extended: Dialect = {
      ...SYNTAX_DIALECT,
      contractFields: { attribute: ["unique"], tag: ["relations"] },
      afterLower(unit) {
        for (const call of unit.calls) {
          if (call.tag !== "index") continue;
          seen.push([call.tag, call.contract.relations]);
          const on = call.attrs.find((attr) => !("spread" in attr) && attr.name === "on");
          // The unit view hands a whole-value atom over as the `mesh:Atom` node itself.
          const value = on && !("spread" in on) ? on.value : null;
          if (value?.type === "mesh:Atom" && call.contract.attributes?.on?.unique) {
            unit.fail(`\`:${(value as unknown as { name: string }).name}\` is not unique`, { at: value.span, code: "MESH_UNIQUE" });
          }
        }
      },
    };
    expect(diagnosticsOf(source, tags, { dialect: extended })).toEqual([
      { severity: "error", message: "`:title` is not unique", line: 2, column: 11, offset: source.indexOf(":title"), code: "MESH_UNIQUE" },
    ]);
    expect(seen).toEqual([["index", "many"]]);
  });
});

// MX 0.1.0-alpha.33 takes atoms out of core: a contract names Mesh's node type (`mesh:Atom`), or a list of it.
describe("the atom attribute type after core dropped it", () => {
  test("`type: \"atom\"` is refused, and the message names the node type to declare instead", () => {
    const tags = { entity: { attributes: { name: { type: "atom" } } } } as unknown as Record<string, CustomTag>;
    const found = diagnosticsOf("entity :Todo\n", tags, MESH);
    // Handed per call, the contract is renamed to Mesh's code; inside `Dialect.contracts` it stops the dialect (`MX_INVALID_DIALECT_CONTRACT`).
    expect(found.map((each) => each.code)).toEqual(["MESH_INVALID_CONTRACT"]);
    expect(found[0]?.message).toContain('`type: "atom"` was removed');
    expect(found[0]?.message).toContain("mesh:Atom");
  });
  test("a single atom where the contract asks for a list says to write it as a list", () => {
    const tags = {
      entity: { attributes: { name: { type: "mesh:Atom" } } },
      actions: { attributes: { auto: { type: "array", items: "mesh:Atom" } } },
    } as unknown as Record<string, CustomTag>;
    const source = "entity :Todo\n  actions auto=:read\n";
    const found = diagnosticsOf(source, tags, MESH);
    expect(found).toHaveLength(1);
    expect(found[0]?.message).toContain("must be array, got mesh:Atom");
    expect(found[0]?.message).toContain("`[:read]`");
    expect(diagnosticsOf("entity :Todo\n  actions auto=[:read]\n", tags, MESH)).toEqual([]);
  });
});

describe("a static attribute's `valueSpan` under the dialect", () => {
  const slice = (source: string, span: { sourceStart: number; sourceEnd: number }) => source.slice(span.sourceStart, span.sourceEnd);

  test("plain, empty and atom values, and the default attribute", () => {
    const values = (source: string) => {
      const result = lowerSource(source, "/t.mx", MESH);
      expect(result.diagnostics).toEqual([]);
      const first = result.ir?.body[0];
      if (first?.kind !== "DelegatedTag") throw new Error("expected a tag");
      return first.tag.attrs.flatMap((attr) => (attr.kind === "static" ? [[attr.name, slice(source, attr.valueSpan)]] : []));
    };
    expect(values(`<a x="s" e="" m=:strict/>`)).toEqual([["x", `"s"`], ["e", `""`], ["m", ":strict"]]);
    expect(values(`<a="post"/>`)).toEqual([["value", `"post"`]]);
  });
});
