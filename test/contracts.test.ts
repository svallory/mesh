import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { parseData } from "@mxlang/data";
import {
  createTargetLookup,
  getCustomTags,
} from "@mxlang/core";
import descriptor from "@mxlang/data/descriptor";
import contracts from "../src/contracts.ts";
import { fixture, fixtureDir, parse, parseFixture } from "./helpers.ts";

/** The 25 distinct tag names the Ash resource fixture uses (31 tag calls), plus `destroy`
 * (declared with `create`, `update` and `read`; the fixture only lists it in `defaults`). */
const TAG_NAMES = [
  "actions",
  "aggregates",
  "attribute",
  "attributes",
  "authorize-if",
  "belongs-to",
  "calculate",
  "calculations",
  "change",
  "count",
  "create",
  "defaults",
  "destroy",
  "filter",
  "has-many",
  "policies",
  "policy",
  "read",
  "relationships",
  "resource",
  "sort",
  "timestamps",
  "update",
  "uuid-primary-key",
  "validate",
  "value",
];

describe("the contract module", () => {
  test("declares one contract per tag name (the fixture's 25 plus `destroy`), and no others", () => {
    expect(Object.keys(contracts).sort()).toEqual(TAG_NAMES);
  });

  test("declares only contract keys: no transform, finalize or template (decision 142)", () => {
    const allowed = ["parseOptions", "attributes", "attributeTags", "children", "parents", "analyze"];
    for (const [name, tag] of Object.entries(contracts)) {
      for (const key of Object.keys(tag)) {
        expect(allowed, `${name}.${key}`).toContain(key);
      }
    }
  });

  test("every contract is closed: attributes, attributeTags and children are all declared", () => {
    for (const [name, tag] of Object.entries(contracts)) {
      expect(tag.attributes, `${name}.attributes`).toBeDefined();
      expect(tag.attributeTags, `${name}.attributeTags`).toEqual({});
      expect(tag.children, `${name}.children`).toBeDefined();
    }
  });

  test("every string-valued attribute is literalOnly; only `function` attributes are not", () => {
    for (const [name, tag] of Object.entries(contracts)) {
      for (const [attr, decl] of Object.entries(tag.attributes ?? {})) {
        if (decl.type === "function") continue;
        expect(decl.literalOnly, `${name}.${attr}`).toBe(true);
      }
    }
  });

  test("package.json#mx.contracts loads the same module through MX's own scan", () => {
    const targets = createTargetLookup([descriptor]);
    const loaded = getCustomTags(`${fixtureDir}post.mx`, { targets, host: null });
    expect(Object.keys(loaded).sort()).toEqual(TAG_NAMES);
    const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    expect(manifest.mx.contracts).toBe("./src/contracts.ts");
  });
});

describe("the positive fixture", () => {
  test("post.mx parses with zero diagnostics and yields a tree", () => {
    const result = parseFixture("post.mx");
    expect(result.diagnostics).toEqual([]);
    expect(result.tree?.children).toHaveLength(1);
  });

  test("an empty `attributes` section is a valid resource body", () => {
    const result = parse('resource="post"\n  attributes\n    timestamps\n');
    expect(result.diagnostics).toEqual([]);
  });

  test("each optional section may appear alone", () => {
    const src = [
      'resource="post" table="posts" domain="blog"',
      "  attributes",
      '    uuid-primary-key="id"',
      "  aggregates",
      '    count="n" relationship="comments"',
      "",
    ].join("\n");
    expect(parse(src).diagnostics).toEqual([]);
  });

  test("destroy takes a name and change/validate children, like update", () => {
    const src = [
      'resource="post"',
      "  attributes",
      '    uuid-primary-key="id"',
      "  actions",
      '    destroy="remove"',
      "      change=({ post }) => { post.deleted = true }",
      '      validate=({ post }) => post.draft message="only drafts"',
      "",
    ].join("\n");
    expect(parse(src).diagnostics).toEqual([]);
  });

  test("defaults may name any built-in action kind", () => {
    const src = 'resource="post"\n  attributes\n    timestamps\n  actions\n    defaults=["create", "read", "update", "destroy"]\n';
    expect(parse(src).diagnostics).toEqual([]);
  });

  test("a literal default that fits the type is accepted", () => {
    const attrs = [
      'attribute="s" type="string" default="x"',
      'attribute="n" type="number" default=3',
      'attribute="m" type="number" default=-1',
      'attribute="b" type="boolean" default=false',
      'attribute="e" type="enum" values=["a", "b"] default="b"',
    ];
    const src = `resource="post"\n  attributes\n${attrs.map((a) => `    ${a}`).join("\n")}\n`;
    expect(parse(src).diagnostics).toEqual([]);
  });

  test("empty sections are allowed: attributes, relationships, actions may hold nothing", () => {
    const src = 'resource="post"\n  attributes\n  relationships\n  actions\n';
    expect(parse(src).diagnostics).toEqual([]);
  });

  test("a repeatable tag may repeat", () => {
    const src = [
      'resource="post"',
      "  attributes",
      '    attribute="a" type="string"',
      '    attribute="b" type="number"',
      '    attribute="c" type="boolean"',
      "",
    ].join("\n");
    expect(parse(src).diagnostics).toEqual([]);
  });
});

interface Case {
  /** Negative fixture file, `test/fixtures/negative/<file>.mx`. */
  file: string;
  line: number;
  column: number;
  message: string;
}

const CALC_TYPE_MESSAGE = (got: string) =>
  `\`<calculate>\`: attribute \`type\` must be one of "string", "number", "boolean", "uuid", "datetime", got "${got}"`;

const ALLOWED_RESOURCE =
  "`<attributes>`, `<relationships>`, `<actions>`, `<policies>`, `<calculations>`, `<aggregates>`";

const RULE_CLASSES: Record<string, Case[]> = {
  "unknown tag (not in the declared children)": [
    {
      file: "unknown-tag",
      line: 4,
      column: 4,
      message:
        "`<attributes>`: `<bogus>` is not allowed here; allowed children: `<uuid-primary-key>`, `<attribute>`, `<timestamps>`",
    },
  ],
  "wrong parent": [
    {
      file: "wrong-parent-top-level",
      line: 1,
      column: 0,
      message: "`<attribute>` must be inside `<attributes>`; found at the top level",
    },
    {
      file: "wrong-parent-nested",
      line: 5,
      column: 4,
      message:
        "`<relationships>`: `<attribute>` is not allowed here; allowed children: `<belongs-to>`, `<has-many>`",
    },
    {
      file: "wrong-parent-change-in-read",
      line: 6,
      column: 6,
      message: "`<read>`: `<change>` is not allowed here; allowed children: `<filter>`, `<sort>`",
    },
    {
      file: "nested-resource",
      line: 4,
      column: 2,
      message: `\`<resource>\`: \`<resource>\` is not allowed here; allowed children: ${ALLOWED_RESOURCE}`,
    },
  ],
  "missing required attribute": [
    {
      file: "missing-required-attr",
      line: 3,
      column: 4,
      message: "`<attribute>`: missing required attribute `type`",
    },
    {
      file: "missing-resource-value",
      line: 1,
      column: 0,
      message: "`<resource>`: missing required attribute `value`",
    },
    {
      file: "missing-belongs-to-resource",
      line: 5,
      column: 4,
      message: "`<belongs-to>`: missing required attribute `resource`",
    },
  ],
  "unknown attribute": [
    {
      file: "unknown-attribute",
      line: 1,
      column: 16,
      message: "`<resource>`: unknown attribute `schema`",
    },
  ],
  "wrong attribute type": [
    {
      file: "wrong-type-boolean",
      line: 3,
      column: 36,
      message: "`<attribute>`: attribute `required` must be boolean, got string",
    },
    {
      file: "wrong-type-array",
      line: 3,
      column: 34,
      message: "`<attribute>`: attribute `values` must be array, got string",
    },
    {
      file: "wrong-type-array-items",
      line: 3,
      column: 51,
      message: "`<attribute>`: attribute `values` item 2 must be string, got number",
    },
    {
      file: "wrong-type-function",
      line: 6,
      column: 12,
      message: "`<change>`: attribute `value` must be function, got string",
    },
    {
      file: "wrong-type-string",
      line: 1,
      column: 16,
      message: "`<resource>`: attribute `table` must be string, got number",
    },
  ],
  "attribute value outside its enum": [
    {
      file: "bad-enum-value",
      line: 3,
      column: 22,
      message:
        '`<attribute>`: attribute `type` must be one of "string", "number", "boolean", "enum", "uuid", "datetime", got "text"',
    },
    {
      file: "bad-action-type",
      line: 5,
      column: 11,
      message:
        '`<policy>`: attribute `action-type` must be one of "create", "read", "update", "destroy", got "explode"',
    },
  ],
  "bad cardinality": [
    {
      file: "cardinality-missing-attributes",
      line: 1,
      column: 0,
      message: "`<resource>`: missing required child `<attributes>`",
    },
    {
      file: "cardinality-empty-resource",
      line: 1,
      column: 0,
      message: "`<resource>`: missing required child `<attributes>`",
    },
    {
      file: "cardinality-duplicate-section",
      line: 4,
      column: 2,
      message: "`<resource>`: `<attributes>` may not be repeated",
    },
    {
      file: "cardinality-duplicate-timestamps",
      line: 4,
      column: 4,
      message: "`<attributes>`: `<timestamps>` may not be repeated",
    },
    {
      file: "cardinality-duplicate-filter",
      line: 7,
      column: 6,
      message: "`<read>`: `<filter>` may not be repeated",
    },
    {
      file: "cardinality-policy-without-authorize",
      line: 5,
      column: 4,
      message: "`<policy>`: missing required child `<authorize-if>`",
    },
    {
      file: "cardinality-calculate-without-value",
      line: 5,
      column: 4,
      message: "`<calculate>`: missing required child `<value>`",
    },
  ],
  "analyze: `values` only with an enum type": [
    {
      file: "analyze-values-on-non-enum",
      line: 3,
      column: 36,
      message: '`<attribute>`: `values` is only allowed when `type` is "enum", not "string"',
    },
    {
      file: "analyze-enum-without-values",
      line: 3,
      column: 4,
      message: "`<attribute>`: type `enum` requires `values`",
    },
  ],
  "analyze: a policy takes `action` or `action-type`": [
    {
      file: "analyze-policy-neither",
      line: 5,
      column: 4,
      message: "`<policy>`: requires `action` or `action-type`",
    },
    {
      file: "analyze-policy-both",
      line: 5,
      column: 28,
      message: "`<policy>`: takes `action` or `action-type`, not both",
    },
  ],
  "attribute tag where none is declared": [
    { file: "attribute-tag-on-leaf", line: 4, column: 6, message: "`<attribute>`: unknown attribute tag `<@foo>`" },
    { file: "attribute-tag-on-section", line: 3, column: 4, message: "`<attributes>`: unknown attribute tag `<@foo>`" },
  ],
  "identifier where a literal is required (`literalOnly`)": [
    { file: "literal-only-value", line: 1, column: 8, message: "`<resource>`: attribute `value` must be a literal" },
    { file: "literal-only-array", line: 3, column: 30, message: "`<attribute>`: attribute `values` must be a literal" },
    { file: "literal-only-boolean", line: 3, column: 32, message: "`<attribute>`: attribute `required` must be a literal" },
    { file: "literal-only-accept", line: 5, column: 15, message: "`<create>`: attribute `accept` must be a literal" },
  ],
  "closed contracts (no children, no attributes by omission)": [
    { file: "attribute-with-child", line: 4, column: 6, message: "`<attribute>`: `<timestamps>` is not allowed here; allowed children: none" },
    { file: "section-unknown-attribute", line: 2, column: 13, message: "`<attributes>`: accepts no attributes" },
    { file: "timestamps-unknown-attribute", line: 3, column: 15, message: "`<timestamps>`: accepts no attributes" },
  ],
  "calculation type": [
    { file: "calculate-bad-type", line: 5, column: 24, message: CALC_TYPE_MESSAGE("strnig") },
    { file: "calculate-enum-type", line: 5, column: 24, message: CALC_TYPE_MESSAGE("enum") },
  ],
  "destroy action": [
    { file: "destroy-missing-value", line: 5, column: 4, message: "`<destroy>`: missing required attribute `value`" },
    { file: "destroy-bad-child", line: 6, column: 6, message: "`<destroy>`: `<filter>` is not allowed here; allowed children: `<change>`, `<validate>`" },
  ],
  "analyze: `defaults` items name built-in actions": [
    { file: "defaults-bad-item", line: 5, column: 12, message: '`<defaults>`: `defaults` item "reed" must be one of "create", "read", "update", "destroy"' },
  ],
  "analyze: enums need values, and a literal default must fit the type": [
    { file: "enum-empty-values", line: 3, column: 30, message: "`<attribute>`: an enum needs at least one value in `values`" },
    { file: "enum-default-not-in-values", line: 3, column: 43, message: '`<attribute>`: `default` must be one of "a", got "zzz"' },
    { file: "boolean-default-not-boolean", line: 3, column: 33, message: '`<attribute>`: `default` must be true or false, got "zzz"' },
    { file: "number-default-not-number", line: 3, column: 32, message: '`<attribute>`: `default` must be a number, got "1"' },
    { file: "string-default-not-string", line: 3, column: 32, message: '`<attribute>`: `default` must be a string for type "string", got 1' },
  ],
  "analyze: defaults must be a string, number or boolean literal": [
    { file: "default-negative-on-string", line: 3, column: 32, message: '`<attribute>`: `default` must be a string for type "string", got -1' },
    { file: "default-null", line: 3, column: 32, message: "`<attribute>`: `default` must be a string, number or boolean literal" },
    { file: "default-array", line: 3, column: 32, message: "`<attribute>`: `default` must be a string, number or boolean literal" },
    { file: "default-object", line: 3, column: 32, message: "`<attribute>`: `default` must be a string, number or boolean literal" },
    { file: "enum-default-negative", line: 3, column: 43, message: '`<attribute>`: `default` must be one of "a", got -1' },
  ],
  "analyze: lists have no repeated items and are not empty": [
    { file: "enum-repeated-values", line: 3, column: 30, message: '`<attribute>`: `values` has a repeated item "a"' },
    { file: "defaults-repeated-item", line: 5, column: 12, message: '`<defaults>`: `defaults` has a repeated item "read"' },
    { file: "defaults-empty", line: 5, column: 12, message: "`<defaults>`: `defaults` may not be empty" },
    { file: "sort-empty", line: 6, column: 10, message: "`<sort>`: `sort` may not be empty" },
    { file: "sort-repeated-item", line: 6, column: 10, message: '`<sort>`: `sort` has a repeated item "a"' },
    { file: "accept-repeated-item", line: 5, column: 15, message: '`<create>`: `accept` has a repeated item "a"' },
    { file: "update-accept-repeated-item", line: 5, column: 15, message: '`<update>`: `accept` has a repeated item "a"' },
    { file: "enum-blank-value", line: 3, column: 30, message: "`<attribute>`: `values` has a blank item" },
    { file: "sort-blank-item", line: 6, column: 10, message: "`<sort>`: `sort` has a blank item" },
    { file: "accept-blank-item", line: 5, column: 15, message: "`<create>`: `accept` has a blank item" },
    { file: "defaults-blank-item", line: 5, column: 12, message: "`<defaults>`: `defaults` has a blank item" },
  ],
  "analyze: names may not be empty": [
    { file: "empty-name-attribute", line: 3, column: 13, message: "`<attribute>`: `value` may not be empty" },
    { file: "validate-empty-message", line: 6, column: 37, message: "`<validate>`: `message` may not be empty" },
    { file: "whitespace-name", line: 3, column: 13, message: "`<attribute>`: `value` may not be empty" },
    { file: "empty-policy-action", line: 5, column: 11, message: "`<policy>`: `action` may not be empty" },
  ],
  "declarations run before analyze": [
    { file: "policy-declaration-before-analyze", line: 5, column: 4, message: "`<policy>`: missing required child `<authorize-if>`" },
  ],
  "text where it is not allowed (`#text` is declared nowhere)": [
    {
      file: "text-in-resource",
      line: 4,
      column: 5,
      message: `\`<resource>\`: text is not allowed here; it accepts only the child tags ${ALLOWED_RESOURCE}`,
    },
    {
      file: "text-interpolation",
      line: 4,
      column: 7,
      message:
        "`<attributes>`: text is not allowed here; it accepts only the child tags `<uuid-primary-key>`, `<attribute>`, `<timestamps>`",
    },
    {
      file: "text-in-leaf",
      line: 6,
      column: 9,
      message: "`<belongs-to>`: text is not allowed here; it accepts no child tags",
    },
  ],
  "structural tags are rejected (`structural: \"reject\"`)": [
    {
      file: "structural-if",
      line: 4,
      column: 2,
      message: "the data tree is static; this file's consumer does not evaluate `<if>`",
    },
  ],
  "unknown tags are rejected (`unknownTags: \"reject\"`)": [
    {
      file: "unknown-tag-top-level",
      line: 1,
      column: 0,
      message: "`<widget>` is not a known tag: it has no contract in `customTags`",
    },
    {
      // Near miss: the nearest declared name is offered as a hint.
      file: "unknown-tag-near-miss",
      line: 1,
      column: 0,
      message: "`<resourse>` is not a known tag: it has no contract in `customTags`; did you mean `<resource>`?",
    },
    {
      // Realistic typo: the misspelt root has a body. The ordering is MX's: existing
      // tag-rule errors come before the unknown-tag check, so no hint is given here.
      // Lead has asked the MX lead whether the unknown root tag should be reported first.
      file: "unknown-tag-near-miss-with-body",
      line: 2,
      column: 2,
      message: "`<attributes>` must be inside `<resource>`; found inside `<resourse>`",
    },
  ],
  "syntax error": [
    {
      file: "syntax-error",
      line: 4,
      column: 4,
      message: "Line indentation does match indentation of previous line",
    },
  ],
};

describe("negative fixtures: one specific diagnostic each, with position", () => {
  for (const [rule, cases] of Object.entries(RULE_CLASSES)) {
    describe(rule, () => {
      for (const c of cases) {
        test(c.file, () => {
          const { source } = fixture(`negative/${c.file}.mx`);
          const result = parse(source, `${fixtureDir}negative/${c.file}.mx`);
          expect(result.tree).toBeUndefined();
          expect(result.diagnostics).toHaveLength(1);
          expect(result.diagnostics[0]).toMatchObject({
            severity: "error",
            line: c.line,
            column: c.column,
            message: c.message,
          });
          // `offset` is UTF-16 and must agree with line/column.
          const lines = source.split("\n");
          const expected =
            lines.slice(0, c.line - 1).reduce((n, l) => n + l.length + 1, 0) + c.column;
          expect(result.diagnostics[0]?.offset).toBe(expected);
        });
      }
    });
  }

  test("every negative fixture file is covered by a case", () => {
    const covered = new Set(
      Object.values(RULE_CLASSES).flatMap((cases) => cases.map((c) => c.file)),
    );
    const onDisk = readdirSync(`${fixtureDir}negative`)
      .filter((f) => f.endsWith(".mx"))
      .map((f) => f.replace(/\.mx$/, ""));
    const uncovered = onDisk.filter((f) => !covered.has(f));
    // These parse cleanly or warn; they have dedicated tests below.
    expect(uncovered.sort()).toEqual(["duplicate-attribute"]);
  });
});

describe("analyze rules run under a direct parseData call with customTags, structural: reject and unknownTags: reject", () => {
  // The MX lead gates `mx.contracts` on this: analyze must run when customTags
  // are handed straight to parseData (no scan, no package.json lookup).
  test("analyze: `values` on a non-enum attribute is reported by the hook", () => {
    const source = fixture("negative/analyze-values-on-non-enum.mx").source;
    const result = parseData(source, "direct.mx", {
      customTags: contracts,
      structural: "reject",
      unknownTags: "reject",
    });
    expect(result.tree).toBeUndefined();
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0]).toMatchObject({
      severity: "error",
      line: 3,
      column: 36,
      message: '`<attribute>`: `values` is only allowed when `type` is "enum", not "string"',
    });
  });

  test("analyze: the policy rule is reported by the hook", () => {
    const source = fixture("negative/analyze-policy-neither.mx").source;
    const result = parseData(source, "direct.mx", {
      customTags: contracts,
      structural: "reject",
      unknownTags: "reject",
    });
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0]).toMatchObject({
      line: 5,
      column: 4,
      message: "`<policy>`: requires `action` or `action-type`",
    });
  });

  test("declarations run before analyze: a policy breaking both reports only the declaration error", () => {
    // `policy-declaration-before-analyze.mx` has neither `action` nor `action-type`
    // (analyze would fail) and no `authorize-if` (declaration fails).
    const source = fixture("negative/policy-declaration-before-analyze.mx").source;
    const result = parseData(source, "direct.mx", {
      customTags: contracts,
      structural: "reject",
      unknownTags: "reject",
    });
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0]).toMatchObject({
      line: 5,
      column: 4,
      message: "`<policy>`: missing required child `<authorize-if>`",
    });
  });

  test("without the contracts the same files parse (so the diagnostics above come from analyze)", () => {
    // Control call: no `customTags`, so `unknownTags: "reject"` is left off (it would reject every tag).
    const source = fixture("negative/analyze-values-on-non-enum.mx").source;
    const result = parseData(source, "direct.mx", { structural: "reject" });
    expect(result.diagnostics).toEqual([]);
  });
});

describe("analyze rules, edge cases", () => {
  const wrap = (body: string) =>
    `resource="post"\n  attributes\n${body
      .split("\n")
      .map((l) => `    ${l}`)
      .join("\n")}\n`;

  test("`type` given as an expression is rejected by the declaration, before analyze can misjudge it", () => {
    const result = parse(wrap('attribute="x" type=kind values=["a"]'));
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0]).toMatchObject({ line: 3, column: 18 });
    expect(result.diagnostics[0]?.message).toBe("`<attribute>`: attribute `type` must be a literal");
  });

  test("enum with values is accepted", () => {
    expect(parse(wrap('attribute="s" type="enum" values=["a", "b"]')).diagnostics).toEqual([]);
  });

  test("an empty `values` array on an enum is rejected", () => {
    const result = parse(wrap('attribute="s" type="enum" values=[]'));
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0]).toMatchObject({
      line: 3,
      column: 30,
      message: "`<attribute>`: an enum needs at least one value in `values`",
    });
  });

  test("`values` on a non-enum is rejected even when it is the first attribute written", () => {
    const result = parse(wrap('attribute="s" values=["a"] type="number"'));
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0]?.message).toBe(
      '`<attribute>`: `values` is only allowed when `type` is "enum", not "number"',
    );
  });

  test("the rule runs on every attribute, and reports the first failure in file order", () => {
    const result = parse(
      wrap('attribute="a" type="string"\nattribute="b" type="string" values=["x"]\nattribute="c" type="enum"'),
    );
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0]).toMatchObject({ line: 4, column: 32 });
  });

  test("policy with `action-type` alone is accepted, and so is `action` alone", () => {
    const body = (attr: string) =>
      `resource="post"\n  attributes\n    timestamps\n  policies\n    policy ${attr}\n      authorize-if=({ actor }) => actor.admin\n`;
    expect(parse(body('action-type="read"')).diagnostics).toEqual([]);
    expect(parse(body('action="publish"')).diagnostics).toEqual([]);
  });
});

describe("edge cases", () => {
  test("duplicate attribute: MX keeps the last and warns; the tree still builds", () => {
    const { source } = fixture("negative/duplicate-attribute.mx");
    const result = parse(source, "dup.mx");
    expect(result.tree).toBeDefined();
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0]).toMatchObject({
      severity: "warning",
      line: 3,
      column: 22,
      message: "duplicate attribute `type`: the later one at 3:37 wins, so this one is dropped",
    });
  });

  test("a `-- text` line in a resource is rejected, not ignored", () => {
    const result = parse('resource="post"\n  attributes\n    timestamps\n  -- note\n');
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0]).toMatchObject({
      line: 4,
      column: 5,
      message: `\`<resource>\`: text is not allowed here; it accepts only the child tags ${ALLOWED_RESOURCE}`,
    });
  });

  test("a comment is rejected under structural: reject, like any non-tag node", () => {
    const result = parse('resource="post"\n  attributes\n    // identity\n    timestamps\n');
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0]).toMatchObject({
      line: 3,
      column: 4,
      message: "the data tree is static; this file's consumer does not evaluate comments",
    });
  });

  test("a top-level <for> is rejected under structural: reject", () => {
    const result = parse('for|x| of=[1]\n  resource="post"\n    attributes\n      timestamps\n');
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0]).toMatchObject({
      line: 1,
      column: 0,
      message: "the data tree is static; this file's consumer does not evaluate `<for>`",
    });
  });
});

describe("known gap: root cardinality", () => {
  // A file should hold exactly one `resource`. MX contracts have no cardinality
  // at `#root`, so parseData accepts both cases below. Mesh's model-build stage
  // must reject them; these tests pin today's behaviour so a change is noticed.
  test("MX accepts an empty file; Mesh model-build stage must reject (known gap)", () => {
    expect(parse("").diagnostics).toEqual([]);
  });

  test("MX accepts two resources in one file; Mesh model-build stage must reject (known gap)", () => {
    const one = 'resource="post"\n  attributes\n    timestamps\n';
    expect(parse(one + one.replace("post", "comment")).diagnostics).toEqual([]);
  });
});
