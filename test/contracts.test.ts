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

/** The 25 distinct tag names the Ash resource fixture uses (31 tag calls). */
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
  test("declares one contract per tag name the fixture uses, and no others", () => {
    expect(Object.keys(contracts).sort()).toEqual(TAG_NAMES);
  });

  test("declares no transform, finalize or template (decision 142: declarations and analyze only)", () => {
    for (const [name, tag] of Object.entries(contracts)) {
      expect(Object.keys(tag).filter((k) => k === "transform" || k === "finalize"), name).toEqual([]);
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
    expect(uncovered.sort()).toEqual(["duplicate-attribute", "unknown-tag-top-level"]);
  });
});

describe("analyze rules run under a direct parseData call with customTags and structural: reject", () => {
  // The MX lead gates `mx.contracts` on this: analyze must run when customTags
  // are handed straight to parseData (no scan, no package.json lookup).
  test("analyze: `values` on a non-enum attribute is reported by the hook", () => {
    const source = fixture("negative/analyze-values-on-non-enum.mx").source;
    const result = parseData(source, "direct.mx", {
      customTags: contracts,
      structural: "reject",
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

  test("analyze: the policy rule is reported by the hook, and only when declarations pass first", () => {
    const source = fixture("negative/analyze-policy-neither.mx").source;
    const result = parseData(source, "direct.mx", {
      customTags: contracts,
      structural: "reject",
    });
    expect(result.diagnostics.map((d) => d.message)).toEqual([
      "`<policy>`: requires `action` or `action-type`",
    ]);
  });

  test("without the contracts the same files parse (so the diagnostics above come from analyze)", () => {
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
    expect(result.diagnostics[0]?.message).toContain("`type` must be a static value from");
  });

  test("enum with values is accepted", () => {
    expect(parse(wrap('attribute="s" type="enum" values=["a", "b"]')).diagnostics).toEqual([]);
  });

  test("an empty `values` array on an enum is accepted (presence, not content, is the rule)", () => {
    expect(parse(wrap('attribute="s" type="enum" values=[]')).diagnostics).toEqual([]);
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

  test("an empty file parses (no resource is not a contract violation)", () => {
    const result = parse("");
    expect(result.diagnostics).toEqual([]);
  });

  test("a `-- text` line in a resource is rejected, not ignored", () => {
    const result = parse('resource="post"\n  attributes\n    timestamps\n  -- note\n');
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0]?.message).toContain("text is not allowed here");
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
    expect(result.diagnostics[0]?.message).toContain("does not evaluate `<for>`");
  });
});

describe("known gap in MX (reported to the lead; scratch/mx-bugs/data-unknown-root-tag.md)", () => {
  // Expected: an unknown tag at the top level is an error. Got: no diagnostic,
  // because no contract exists for the name and the data target delegates every
  // name. `test.failing` flips to red the day MX closes the gap, so this test
  // gets rewritten into a normal one then.
  test.failing("an unknown top-level tag is rejected", () => {
    const { source } = fixture("negative/unknown-tag-top-level.mx");
    const result = parse(source, "unknown-root.mx");
    expect(result.diagnostics.filter((d) => d.severity === "error")).toHaveLength(1);
  });
});
