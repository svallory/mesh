// The atom contract checks (`values`, `pattern`, `ref`, `declares`) as Mesh's dialect runs them (ported from MX's
// `lowered-unit.test.ts`, `ir-entry/contract-fields.test.ts` and `ir-entry/lower-source.test.ts` at MX commit 750c80ec1).
// `MESH_DIALECT` claims those contract keys (`contractFields`) and checks them in `checkContract` and `afterLower`.
// The reference is core's built-in path (`tagRules: "none"`, no dialect), which runs the same checks itself: the
// diagnostics must be equal field for field (message, line, column, offset, code). Both paths are public API.
import { lowerSource, type CustomTag, type Dialect, type LowerSourceOptions } from "@mxlang/core";
import { describe, expect, test } from "bun:test";
import { MESH_DIALECT } from "../src/front-end/dialect.ts";
import { FAILING, PASSING, REGISTRATION, vocab } from "./atom-contract-cases.ts";

const BUILT_IN: LowerSourceOptions = { tagRules: "none" } as LowerSourceOptions;
const MESH: LowerSourceOptions = { dialect: MESH_DIALECT };

const diagnosticsOf = (source: string, tags: Record<string, CustomTag>, options: LowerSourceOptions, file = "/v/x.mx") =>
  lowerSource(source, file, { ...options, customTags: tags }).diagnostics;

describe("the dialect's contract checks match core's built-in path", () => {
  test.each(FAILING.map((s) => [s]))("rejects like the built-in path: %s", (source) => {
    const expected = diagnosticsOf(source, vocab, BUILT_IN);
    expect(expected.length).toBeGreaterThan(0);
    expect(expected[0]?.severity).toBe("error");
    expect(diagnosticsOf(source, vocab, MESH)).toEqual(expected);
  });

  test.each(PASSING.map((s) => [s]))("accepts like the built-in path: %s", (source) => {
    expect(diagnosticsOf(source, vocab, BUILT_IN)).toEqual([]);
    expect(diagnosticsOf(source, vocab, MESH)).toEqual([]);
  });

  test.each(REGISTRATION.map(([name, tags]) => [name, tags] as const))("registration: %s", (_, tags) => {
    // The tag is never called: `checkContract` runs at registration, as core's own check does.
    const expected = diagnosticsOf("<div/>", tags, BUILT_IN);
    expect(expected).toHaveLength(1);
    expect(expected[0]).toMatchObject({ line: 1, column: 0, offset: 0 });
    expect(diagnosticsOf("<div/>", tags, MESH)).toEqual(expected);
    expect(diagnosticsOf("<box/>", tags, MESH)).toEqual(diagnosticsOf("<box/>", tags, BUILT_IN));
  });

  test("a duplicate declaration names both places", () => {
    const [d] = diagnosticsOf("<node#a/>\n<node#a/>", vocab, MESH);
    expect(d?.message).toBe("`a` is already declared as `node` at 1:7");
    expect([d?.line, d?.column]).toEqual([2, 6]);
  });
});

const customTags: Record<string, CustomTag> = {
  entity: { attributes: { name: { type: "atom" } } },
  attributes: {},
  actions: {},
  arguments: {},
  string: {
    attributes: { name: { type: "atom" } },
    declares: [
      { kind: "attribute", from: "name", under: "attributes" },
      { kind: "argument", from: "name", under: "arguments", scope: "action" },
    ],
  },
  action: { attributes: { name: { type: "atom" } }, declares: { kind: "action", from: "name" } },
  policy: {
    attributes: {
      accept: { type: "atom", ref: "attribute" },
      require: { type: "atom", ref: ["attribute", "argument"] },
      types: { type: "atom", values: ["create", "read", "update", "destroy"] },
      slug: { type: "atom", pattern: "^[a-z]+$" },
    },
  },
} as unknown as Record<string, CustomTag>;

const ENTITY_FAILING: readonly string[] = [
  "entity :Invoice\n  attributes\n    string :title\n    string :body\n  policy accept=[:title, :bdy]\n",
  'entity :Invoice\n  attributes\n    string :title\n  policy accept="title"\n',
  "entity :Invoice\n  policy types=:craete\n",
  "entity :Invoice\n  policy slug=:Upper\n",
  "entity :Invoice\n  attributes\n    string :title\n    string :title\n",
  "entity :Invoice\n  actions\n    action :rename\n      arguments\n        string :newTitle\n    action :other\n      policy require=:newTitle\n",
  "entity :Invoice\n  arguments\n    string :orphan\n",
];

const ENTITY_PASSING =
  "entity :Invoice\n  attributes\n    string :title\n  actions\n    action :rename\n      arguments\n        string :newTitle\n      policy require=[:title, :newTitle] types=:update slug=:abc\n";

describe("an entity file through the dialect and the built-in path", () => {
  test.each(ENTITY_FAILING.map((s) => [s]))("same single error: %s", (source) => {
    const expected = diagnosticsOf(source, customTags, BUILT_IN, "/v/invoice.mx");
    expect(expected).toHaveLength(1);
    expect(expected[0]?.severity).toBe("error");
    expect(diagnosticsOf(source, customTags, MESH, "/v/invoice.mx")).toEqual(expected);
  });

  test("accepts what the built-in path accepts", () => {
    expect(diagnosticsOf(ENTITY_PASSING, customTags, BUILT_IN)).toEqual([]);
    expect(diagnosticsOf(ENTITY_PASSING, customTags, MESH)).toEqual([]);
  });

  test.each([
    ["called", "box\n"],
    ["never called", "other\n"],
  ])("a malformed claimed key is a file-level registration error on a tag %s", (_, source) => {
    const tags = { other: {}, box: { attributes: { a: { type: "string", values: ["a"] } } } } as unknown as Record<string, CustomTag>;
    const expected = {
      severity: "error" as const,
      message: 'Invalid "a" attribute declaration of tag "box": `values` requires `type: "atom"`',
      line: 1,
      column: 0,
      offset: 0,
    };
    expect(diagnosticsOf(source, tags, BUILT_IN)).toEqual([expected]);
    expect(diagnosticsOf(source, tags, MESH)).toEqual([expected]);
  });
});

describe("a dialect's own contract key", () => {
  test("passes registration and reaches `afterLower`, whose `fail` is a positioned, coded diagnostic", () => {
    const source = "entity :Invoice\n  index on=:title\n";
    const tags = {
      entity: { attributes: { name: { type: "atom" } } },
      index: { attributes: { on: { type: "atom", unique: true } }, relations: "many" },
    } as unknown as Record<string, CustomTag>;
    // Without a dialect that claims it, `unique` is an unknown key.
    expect(diagnosticsOf(source, tags, MESH)[0]?.message).toMatch(/Unknown key "unique"/);

    const seen: unknown[] = [];
    const extended: Dialect = {
      ...MESH_DIALECT,
      contractFields: { attribute: ["unique"], tag: ["relations"] },
      afterLower(unit) {
        for (const call of unit.calls) {
          if (call.tag !== "index") continue;
          seen.push([call.tag, call.contract.relations]);
          const on = call.attrs.find((attr) => !("spread" in attr) && attr.name === "on");
          // The unit view names an atom `mx:Atom` whatever dialect claims it (the IR node says `mesh:Atom`).
          const value = on && !("spread" in on) ? on.value : null;
          if (value?.type === "mx:Atom" && call.contract.attributes?.on?.unique) {
            unit.fail(`\`:${(value as { name: string }).name}\` is not unique`, { at: value.span, code: "MESH_UNIQUE" });
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
