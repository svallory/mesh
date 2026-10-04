import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { parseData } from "@mxlang/data";
import {
  createTargetLookup,
  getCustomTags,
} from "@mxlang/core";
import descriptor from "@mxlang/data/descriptor";
import type { CustomTag } from "@mxlang/core";
import contracts, { ATTRIBUTE_TYPES } from "../src/contracts.ts";
import { fixture, fixtureDir, parse, parseFixture } from "./helpers.ts";

/** Every tag name on main, kebab-case (the mapping page's section 0). The fixture uses all of
 * them except `destroy`, which it only names in `defaults`. */
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
  "create-timestamp",
  "destroy",
  "filter",
  "has-many",
  "policies",
  "policy",
  "read",
  "relationships",
  "resource",
  "sort",
  "update",
  "update-timestamp",
  "uuid-primary-key",
  "validate",
  "value",
];

describe("the contract module", () => {
  test("declares one contract per tag name, and no others", () => {
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

  test("every non-code attribute is literalOnly; only `function` attributes and the policy condition (a check call) are not", () => {
    for (const [name, tag] of Object.entries(contracts)) {
      for (const [attr, decl] of Object.entries(tag.attributes ?? {})) {
        if (decl.type === "function") continue;
        if (name === "policy" && attr === "value") continue;
        expect(decl.literalOnly, `${name}.${attr}`).toBe(true);
      }
    }
  });

  test("every tag and attribute name obeys the naming rule: kebab-case, no `_`, no `?` (mapping page, section 0)", () => {
    const kebab = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;
    for (const [tagName, tag] of Object.entries(contracts)) {
      expect(tagName, `tag ${tagName}`).toMatch(kebab);
      for (const attr of Object.keys(tag.attributes ?? {})) {
        expect(attr, `${tagName}.${attr}`).toMatch(kebab);
      }
    }
  });

  test("no tag name and no attribute name ends in `?` or contains `_` (ruling of 2026-10-04)", () => {
    const names = Object.entries(contracts).flatMap(([tagName, tag]) => [
      tagName,
      ...Object.keys(tag.attributes ?? {}),
    ]);
    for (const name of names) {
      expect(name.endsWith("?"), name).toBe(false);
      expect(name.includes("_"), name).toBe(false);
    }
  });

  test("the naming rule rejects what it should (the check is not vacuous)", () => {
    const kebab = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;
    for (const bad of ["allow_nil", "allow-nil?", "belongsTo", "-x", "x-", "a--b", ""]) {
      expect(kebab.test(bad), bad).toBe(false);
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
    const result = parse('resource="post"\n  attributes\n    create-timestamp="insertedAt"\n');
    expect(result.diagnostics).toEqual([]);
  });

  test("each optional section may appear alone", () => {
    const src = [
      'resource="post" table="posts" domain="blog"',
      "  attributes",
      '    uuid-primary-key="id"',
      "  aggregates",
      '    count="n" relationship-path="comments"',
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
    const src = 'resource="post"\n  attributes\n    update-timestamp="updatedAt"\n  actions defaults=["create", "read", "update", "destroy"]\n';
    expect(parse(src).diagnostics).toEqual([]);
  });

  test("a literal default that fits the type is accepted", () => {
    const attrs = [
      'attribute="s" type="string" default="x"',
      'attribute="n" type="integer" default=3',
      'attribute="m" type="integer" default=-1',
      'attribute="f" type="float" default=1.5',
      'attribute="g" type="float" default=2',
      'attribute="b" type="boolean" default=false',
      'attribute="e" type="atom" constraints={ one_of: ["a", "b"] } default="b"',
    ];
    const src = `resource="post"\n  attributes\n${attrs.map((a) => `    ${a}`).join("\n")}\n`;
    expect(parse(src).diagnostics).toEqual([]);
  });

  test("empty sections are allowed: attributes, relationships, actions may hold nothing", () => {
    const src = 'resource="post"\n  attributes\n  relationships\n  actions\n  policies\n  calculations\n  aggregates\n';
    expect(parse(src).diagnostics).toEqual([]);
  });

  test("a repeatable tag may repeat", () => {
    const src = [
      'resource="post"',
      "  attributes",
      '    attribute="a" type="string"',
      '    attribute="b" type="integer"',
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

const TYPES = '"string", "integer", "float", "boolean", "atom", "uuid", "datetime"';
const TYPE_MESSAGE = (got: string) =>
  `\`<attribute>\`: attribute \`type\` must be one of ${TYPES}, got "${got}"`;
const CALC_TYPE_MESSAGE = (got: string) =>
  `\`<calculate>\`: attribute \`type\` must be one of "string", "integer", "float", "boolean", "uuid", "datetime", got "${got}"`;

const ALLOWED_RESOURCE =
  "`<attributes>`, `<relationships>`, `<actions>`, `<policies>`, `<calculations>`, `<aggregates>`";
const ALLOWED_ATTRIBUTES =
  "`<uuid-primary-key>`, `<attribute>`, `<create-timestamp>`, `<update-timestamp>`";
const ACTION_TYPE_LIST = '"create", "read", "update", "destroy"';
const POLICY_AUTHORIZE = "`<policy>`: missing required child `<authorize-if>`";

const RULE_CLASSES: Record<string, Case[]> = {
  "unknown tag (not in the declared children)": [
    {
      file: "unknown-tag",
      line: 4,
      column: 4,
      message: `\`<attributes>\`: \`<bogus>\` is not allowed here; allowed children: ${ALLOWED_ATTRIBUTES}`,
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
      message:
        "`<read>`: `<change>` is not allowed here; allowed children: `<filter>`, `<sort>`, `<validate>`",
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
      file: "missing-belongs-to-destination",
      line: 5,
      column: 4,
      message: "`<belongs-to>`: missing required attribute `destination`",
    },
    {
      file: "count-missing-relationship-path",
      line: 5,
      column: 4,
      message: "`<count>`: missing required attribute `relationship-path`",
    },
    {
      file: "policy-missing-condition",
      line: 5,
      column: 4,
      message: "`<policy>`: missing required attribute `value`",
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
      message: "`<attribute>`: attribute `allow-nil` must be boolean, got string",
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
    { file: "bad-enum-value", line: 3, column: 22, message: TYPE_MESSAGE("text") },
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
      file: "cardinality-duplicate-create-timestamp",
      line: 4,
      column: 4,
      message: "`<attributes>`: `<create-timestamp>` may not be repeated",
    },
    {
      file: "cardinality-duplicate-update-timestamp",
      line: 4,
      column: 4,
      message: "`<attributes>`: `<update-timestamp>` may not be repeated",
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
      message: POLICY_AUTHORIZE,
    },
    {
      file: "cardinality-calculate-without-value",
      line: 5,
      column: 4,
      message: "`<calculate>`: missing required child `<value>`",
    },
  ],
  "analyze: `constraints` belong to atom attributes, and an atom needs `one_of`": [
    {
      file: "analyze-constraints-on-non-atom",
      line: 3,
      column: 36,
      message: '`<attribute>`: `constraints` is only allowed when `type` is "atom", not "string"',
    },
    {
      file: "analyze-atom-without-constraints",
      line: 3,
      column: 4,
      message: "`<attribute>`: type `atom` requires `constraints`",
    },
    {
      file: "constraints-not-object",
      line: 3,
      column: 34,
      message: "`<attribute>`: `constraints` must be an object literal with `one_of`",
    },
    {
      file: "constraints-no-one-of",
      line: 3,
      column: 30,
      message: "`<attribute>`: `constraints` must name `one_of`, the list of allowed values",
    },
    {
      file: "constraints-unknown-constraint",
      line: 3,
      column: 30,
      message:
        '`<attribute>`: `constraints` has an unknown constraint "max_length"; only `one_of` is known',
    },
    {
      file: "one-of-not-array",
      line: 3,
      column: 30,
      message: "`<attribute>`: `one_of` must be a list of strings",
    },
    {
      file: "one-of-non-string-item",
      line: 3,
      column: 34,
      message: "`<attribute>`: `one_of` item 2 must be a string",
    },
    {
      file: "one-of-empty",
      line: 3,
      column: 30,
      message: "`<attribute>`: an atom needs at least one value in `one_of`",
    },
  ],
  "analyze: a policy's condition is a check call or a list of them": [
    { file: "bad-action-type", line: 5, column: 10, message: `\`<policy>\`: \`action_type\` must be one of ${ACTION_TYPE_LIST}, got "explode"` },
    { file: "policy-list-bad-item", line: 5, column: 10, message: `\`<policy>\`: \`action_type\` must be one of ${ACTION_TYPE_LIST}, got "explode"` },
    { file: "policy-unknown-check", line: 5, column: 10, message: '`<policy>`: unknown policy check `bogus`; the checks are "action", "action_type"' },
    { file: "policy-not-a-call", line: 5, column: 10, message: '`<policy>`: takes a check call, for example `action_type("read")` or `action("publish")`' },
    { file: "policy-check-without-argument", line: 5, column: 10, message: "`<policy>`: `action_type` takes exactly one string argument" },
    { file: "policy-check-number-argument", line: 5, column: 10, message: "`<policy>`: `action` takes exactly one string argument" },
    { file: "policy-empty-list", line: 5, column: 10, message: "`<policy>`: a policy needs at least one check call" },
  ],
  "attribute tag where none is declared": [
    { file: "attribute-tag-on-leaf", line: 4, column: 6, message: "`<attribute>`: unknown attribute tag `<@foo>`" },
    { file: "attribute-tag-on-section", line: 3, column: 4, message: "`<attributes>`: unknown attribute tag `<@foo>`" },
  ],
  "identifier where a literal is required (`literalOnly`)": [
    { file: "literal-only-value", line: 1, column: 8, message: "`<resource>`: attribute `value` must be a literal" },
    { file: "literal-only-constraints", line: 3, column: 30, message: "`<attribute>`: attribute `constraints` must be a literal" },
    { file: "literal-only-boolean", line: 3, column: 32, message: "`<attribute>`: attribute `allow-nil` must be a literal" },
    { file: "literal-only-accept", line: 5, column: 15, message: "`<create>`: attribute `accept` must be a literal" },
  ],
  "closed contracts (no children, no attributes by omission)": [
    { file: "attribute-with-child", line: 4, column: 6, message: "`<attribute>`: `<create-timestamp>` is not allowed here; allowed children: none" },
    { file: "section-unknown-attribute", line: 2, column: 13, message: "`<attributes>`: accepts no attributes" },
    { file: "create-timestamp-unknown-attribute", line: 3, column: 34, message: "`<create-timestamp>`: unknown attribute `foo`" },
  ],
  "calculation type": [
    { file: "calculate-bad-type", line: 5, column: 24, message: CALC_TYPE_MESSAGE("strnig") },
    { file: "calculate-atom-type", line: 5, column: 24, message: CALC_TYPE_MESSAGE("atom") },
  ],
  "destroy action": [
    { file: "destroy-missing-value", line: 5, column: 4, message: "`<destroy>`: missing required attribute `value`" },
    { file: "destroy-bad-child", line: 6, column: 6, message: "`<destroy>`: `<filter>` is not allowed here; allowed children: `<change>`, `<validate>`" },
    { file: "destroy-accept-repeated-item", line: 5, column: 21, message: '`<destroy>`: `accept` has a repeated item "a"' },
    { file: "destroy-accept-blank-item", line: 5, column: 21, message: "`<destroy>`: `accept` has a blank item" },
  ],
  "validate in create and read": [
    { file: "validate-in-create-bad-parent", line: 6, column: 6, message: "`<create>`: `<filter>` is not allowed here; allowed children: `<change>`, `<validate>`" },
    { file: "create-validate-empty-message", line: 6, column: 34, message: "`<validate>`: `message` may not be empty" },
    { file: "read-validate-empty-message", line: 6, column: 34, message: "`<validate>`: `message` may not be empty" },
  ],
  "the pre-alignment names are gone (renamed, not aliased)": [
    { file: "old-timestamps-tag", line: 3, column: 4, message: `\`<attributes>\`: \`<timestamps>\` is not allowed here; allowed children: ${ALLOWED_ATTRIBUTES}` },
    { file: "old-defaults-child", line: 5, column: 4, message: "`<actions>`: `<defaults>` is not allowed here; allowed children: `<create>`, `<update>`, `<read>`, `<destroy>`" },
    { file: "old-policy-action-attribute", line: 5, column: 11, message: "`<policy>`: unknown attribute `action`" },
    { file: "attribute-old-required-flag", line: 3, column: 32, message: "`<attribute>`: unknown attribute `required`" },
    { file: "attribute-old-type-number", line: 3, column: 18, message: TYPE_MESSAGE("number") },
    { file: "attribute-old-type-enum", line: 3, column: 18, message: TYPE_MESSAGE("enum") },
    { file: "count-old-relationship-attribute", line: 5, column: 14, message: "`<count>`: unknown attribute `relationship`" },
    { file: "old-belongs-to-resource-attribute", line: 5, column: 24, message: "`<belongs-to>`: unknown attribute `resource`" },
    { file: "old-has-many-resource-attribute", line: 5, column: 24, message: "`<has-many>`: unknown attribute `resource`" },
    { file: "attribute-old-values-attribute", line: 3, column: 30, message: "`<attribute>`: unknown attribute `values`" },
  ],
  "array-typed attributes: the array and its item type are declared (MX `array` + `items`)": [
    { file: "sort-not-array", line: 6, column: 10, message: "`<sort>`: attribute `value` must be array, got string" },
    { file: "sort-item-not-string", line: 6, column: 17, message: "`<sort>`: attribute `value` item 2 must be string, got number" },
  ],
  "analyze: `defaults` items name built-in actions": [
    { file: "defaults-bad-item", line: 4, column: 10, message: `\`<actions>\`: \`defaults\` item "reed" must be one of ${ACTION_TYPE_LIST}` },
  ],
  "analyze: a literal default must fit the type": [
    { file: "atom-default-not-in-one-of", line: 3, column: 60, message: '`<attribute>`: `default` must be one of "a", got "zzz"' },
    { file: "boolean-default-not-boolean", line: 3, column: 33, message: '`<attribute>`: `default` must be true or false, got "zzz"' },
    { file: "integer-default-not-integer", line: 3, column: 33, message: '`<attribute>`: `default` must be an integer, got "1"' },
    { file: "float-default-not-number", line: 3, column: 31, message: '`<attribute>`: `default` must be a number, got "1"' },
    { file: "string-default-not-string", line: 3, column: 32, message: '`<attribute>`: `default` must be a string for type "string", got 1' },
  ],
  "analyze: defaults must be a string, number or boolean literal": [
    { file: "default-negative-on-string", line: 3, column: 32, message: '`<attribute>`: `default` must be a string for type "string", got -1' },
    { file: "default-null", line: 3, column: 32, message: "`<attribute>`: `default` must be a string, number or boolean literal" },
    { file: "default-array", line: 3, column: 32, message: "`<attribute>`: `default` must be a string, number or boolean literal" },
    { file: "default-object", line: 3, column: 32, message: "`<attribute>`: `default` must be a string, number or boolean literal" },
    { file: "atom-default-negative", line: 3, column: 60, message: '`<attribute>`: `default` must be one of "a", got -1' },
  ],
  "analyze: lists have no repeated items and are not empty": [
    { file: "one-of-repeated-values", line: 3, column: 30, message: '`<attribute>`: `one_of` has a repeated item "a"' },
    { file: "defaults-repeated-item", line: 4, column: 10, message: '`<actions>`: `defaults` has a repeated item "read"' },
    { file: "defaults-empty", line: 4, column: 10, message: "`<actions>`: `defaults` may not be empty" },
    { file: "sort-empty", line: 6, column: 10, message: "`<sort>`: `sort` may not be empty" },
    { file: "sort-repeated-item", line: 6, column: 10, message: '`<sort>`: `sort` has a repeated item "a"' },
    { file: "accept-repeated-item", line: 5, column: 15, message: '`<create>`: `accept` has a repeated item "a"' },
    { file: "update-accept-repeated-item", line: 5, column: 15, message: '`<update>`: `accept` has a repeated item "a"' },
    { file: "one-of-blank-value", line: 3, column: 30, message: "`<attribute>`: `one_of` has a blank item" },
    { file: "sort-blank-item", line: 6, column: 10, message: "`<sort>`: `sort` has a blank item" },
    { file: "accept-blank-item", line: 5, column: 15, message: "`<create>`: `accept` has a blank item" },
    { file: "defaults-blank-item", line: 4, column: 10, message: "`<actions>`: `defaults` has a blank item" },
  ],
  "analyze: names may not be empty": [
    { file: "empty-name-attribute", line: 3, column: 13, message: "`<attribute>`: `value` may not be empty" },
    { file: "validate-empty-message", line: 6, column: 37, message: "`<validate>`: `message` may not be empty" },
    { file: "whitespace-name", line: 3, column: 13, message: "`<attribute>`: `value` may not be empty" },
    { file: "empty-policy-action", line: 5, column: 10, message: "`<policy>`: `action` may not be empty" },
  ],
  "declarations run before analyze": [
    { file: "policy-declaration-before-analyze", line: 5, column: 4, message: POLICY_AUTHORIZE },
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
      message: `\`<attributes>\`: text is not allowed here; it accepts only the child tags ${ALLOWED_ATTRIBUTES}`,
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
      // MX reports the unknown parent before its children's errors (MX 7a40491).
      file: "unknown-tag-near-miss-with-body",
      line: 1,
      column: 0,
      message: "`<resourse>` is not a known tag: it has no contract in `customTags`; did you mean `<resource>`?",
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
  const direct = (name: string) =>
    parseData(fixture(`negative/${name}.mx`).source, "direct.mx", {
      customTags: contracts,
      structural: "reject",
      unknownTags: "reject",
    });

  test("analyze: `constraints` on a non-atom attribute is reported by the hook", () => {
    const result = direct("analyze-constraints-on-non-atom");
    expect(result.tree).toBeUndefined();
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0]).toMatchObject({
      severity: "error",
      line: 3,
      column: 36,
      message: '`<attribute>`: `constraints` is only allowed when `type` is "atom", not "string"',
    });
  });

  test("analyze: the policy rule is reported by the hook", () => {
    const result = direct("policy-unknown-check");
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0]).toMatchObject({
      line: 5,
      column: 10,
      message: '`<policy>`: unknown policy check `bogus`; the checks are "action", "action_type"',
    });
  });

  test("declarations run before analyze: a policy breaking both reports only the declaration error", () => {
    // `policy-declaration-before-analyze.mx` has an unknown check (analyze would
    // fail) and no `authorize-if` (declaration fails).
    const result = direct("policy-declaration-before-analyze");
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0]).toMatchObject({
      line: 5,
      column: 4,
      message: POLICY_AUTHORIZE,
    });
  });

  test("without the contracts the same files parse (so the diagnostics above come from analyze)", () => {
    // Control call: no `customTags`, so `unknownTags: "reject"` is left off (it would reject every tag).
    const source = fixture("negative/analyze-constraints-on-non-atom.mx").source;
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
    const result = parse(wrap('attribute="x" type=kind constraints={ one_of: ["a"] }'));
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0]).toMatchObject({ line: 3, column: 18 });
    expect(result.diagnostics[0]?.message).toBe("`<attribute>`: attribute `type` must be a literal");
  });

  test("an atom with `one_of` is accepted, with the key quoted or not", () => {
    expect(parse(wrap('attribute="s" type="atom" constraints={ one_of: ["a", "b"] }')).diagnostics).toEqual([]);
    expect(parse(wrap('attribute="s" type="atom" constraints={ "one_of": ["a"] }')).diagnostics).toEqual([]);
  });

  test("an empty `one_of` on an atom is rejected", () => {
    const result = parse(wrap('attribute="s" type="atom" constraints={ one_of: [] }'));
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0]).toMatchObject({
      line: 3,
      column: 30,
      message: "`<attribute>`: an atom needs at least one value in `one_of`",
    });
  });

  test("`constraints` on a non-atom is rejected even when it is the first attribute written", () => {
    const result = parse(wrap('attribute="s" constraints={ one_of: ["a"] } type="integer"'));
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0]?.message).toBe(
      '`<attribute>`: `constraints` is only allowed when `type` is "atom", not "integer"',
    );
  });

  test("the rule runs on every attribute, and reports the first failure in file order", () => {
    const result = parse(
      wrap(
        'attribute="a" type="string"\nattribute="b" type="string" constraints={ one_of: ["x"] }\nattribute="c" type="atom"',
      ),
    );
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0]).toMatchObject({ line: 4, column: 32 });
  });

  const policy = (condition: string) =>
    `resource="post"\n  attributes\n    create-timestamp="insertedAt"\n  policies\n    policy=${condition}\n      authorize-if=({ actor }) => actor.admin\n`;

  test("a policy takes `action_type(...)` alone, `action(...)` alone, or a list of checks", () => {
    expect(parse(policy('action_type("read")')).diagnostics).toEqual([]);
    expect(parse(policy('action("publish")')).diagnostics).toEqual([]);
    expect(parse(policy('[action_type("update"), action("publish")]')).diagnostics).toEqual([]);
  });

  test("every action type is accepted by `action_type`", () => {
    for (const kind of ["create", "read", "update", "destroy"]) {
      expect(parse(policy(`action_type("${kind}")`)).diagnostics, kind).toEqual([]);
    }
  });

  test("a check call with two arguments is rejected", () => {
    const result = parse(policy('action("a", "b")'));
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0]?.message).toBe("`<policy>`: `action` takes exactly one string argument");
  });

  test("a list holding something that is not a call is rejected", () => {
    const result = parse(policy('[action("a"), "read"]'));
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0]?.message).toBe(
      '`<policy>`: takes a check call, for example `action_type("read")` or `action("publish")`',
    );
  });

  const actionsOf = (body: string) =>
    `resource="post"\n  attributes\n    uuid-primary-key="id"\n  actions\n${body}\n`;

  test("`validate` is accepted in create, update, destroy and read", () => {
    for (const [kind, name] of [["create", "open"], ["update", "close"], ["destroy", "remove"], ["read", "all"]]) {
      const src = actionsOf(`    ${kind}="${name}"\n      validate=({ post }) => post.ok message="not ok"`);
      expect(parse(src).diagnostics, kind).toEqual([]);
    }
  });

  test("`accept` is accepted on create, update and destroy, and `accept=[]` is valid on each", () => {
    for (const [kind, name] of [["create", "open"], ["update", "close"], ["destroy", "remove"]]) {
      expect(parse(actionsOf(`    ${kind}="${name}" accept=["title"]`)).diagnostics, kind).toEqual([]);
      expect(parse(actionsOf(`    ${kind}="${name}" accept=[]`)).diagnostics, `${kind} []`).toEqual([]);
    }
  });

  test("`read` takes no `accept`", () => {
    const result = parse(actionsOf('    read="all" accept=["title"]'));
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0]?.message).toBe("`<read>`: unknown attribute `accept`");
  });

  test("`defaults` is an attribute of `actions` and sits beside the action children", () => {
    const src = actionsOf('  ').replace("  actions\n", '  actions defaults=["read"]\n') + '    create="open"\n';
    expect(parse(src).diagnostics).toEqual([]);
  });

  test("both timestamp tags together, either alone", () => {
    const attrs = (...lines: string[]) => wrap(lines.join("\n"));
    expect(parse(attrs('create-timestamp="a"', 'update-timestamp="b"')).diagnostics).toEqual([]);
    expect(parse(attrs('update-timestamp="b"')).diagnostics).toEqual([]);
    expect(parse(attrs('create-timestamp="a"')).diagnostics).toEqual([]);
  });

  test("a timestamp needs a name", () => {
    const result = parse(wrap("create-timestamp"));
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0]?.message).toBe("`<create-timestamp>`: missing required attribute `value`");
  });

  test("`allow-nil=false` and a bare `allow-nil` are both booleans", () => {
    expect(parse(wrap('attribute="a" type="string" allow-nil=false')).diagnostics).toEqual([]);
    expect(parse(wrap('attribute="a" type="string" allow-nil')).diagnostics).toEqual([]);
  });

  test("every attribute type on main is accepted", () => {
    const lines = ATTRIBUTE_TYPES.filter((t) => t !== "atom").map((t) => `attribute="a_${t}" type="${t}"`);
    expect(parse(wrap(lines.join("\n"))).diagnostics).toEqual([]);
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
    const result = parse('resource="post"\n  attributes\n    create-timestamp="insertedAt"\n  -- note\n');
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0]).toMatchObject({
      line: 4,
      column: 5,
      message: `\`<resource>\`: text is not allowed here; it accepts only the child tags ${ALLOWED_RESOURCE}`,
    });
  });

  test("a comment is rejected under structural: reject, like any non-tag node", () => {
    const result = parse('resource="post"\n  attributes\n    // identity\n    create-timestamp="insertedAt"\n');
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0]).toMatchObject({
      line: 3,
      column: 4,
      message: "the data tree is static; this file's consumer does not evaluate comments",
    });
  });

  test("a top-level <for> is rejected under structural: reject", () => {
    const result = parse('for|x| of=[1]\n  resource="post"\n    attributes\n      create-timestamp="insertedAt"\n');
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
    const one = 'resource="post"\n  attributes\n    create-timestamp="insertedAt"\n';
    expect(parse(one + one.replace("post", "comment")).diagnostics).toEqual([]);
  });
});

describe("roadmap M1 acceptance test 7: every row of the mapping page marked 'on main' has a contract and a fixture that match it", () => {
  // The rows come from the mapping page itself, never from a list kept here:
  // section 3 of apps/docs/docs/architecture/roadmap/vocabulary-mapping.md.
  // Its last column, "Contract check", is machine-readable (see the page, the
  // paragraph before 3.1): `tag: attr attr >child attr=v1,v2; tag: ...`.
  // A row whose status says "on main" with a cell that does not parse fails.
  const page = readFileSync(
    new URL("../../../apps/docs/docs/architecture/roadmap/vocabulary-mapping.md", import.meta.url),
    "utf8",
  );
  const section3 = page.slice(page.indexOf("## 3. The mapping"), page.indexOf("## 4. Deviations"));

  interface Spec {
    tag: string;
    attrs: string[];
    children: string[];
    values: { attr: string; values: string[] }[];
  }
  interface PageRow {
    row: number;
    onMain: boolean;
    check: string;
  }

  const rows: PageRow[] = section3
    .split("\n")
    .filter((line) => /^\| \d+ \|/.test(line))
    .map((line) => {
      const cells = line.split(/(?<!\\)\|/).map((c) => c.trim());
      // ["", "#", ash, source, mesh, today, status, check, ""]
      if (cells.length !== 9) throw new Error(`mapping row has ${cells.length - 2} cells, expected 7: ${line.slice(0, 60)}`);
      return { row: Number(cells[1]), onMain: cells[6]!.includes("on main"), check: cells[7]! };
    });

  /** `n/a (reason)`: an on-main row that is not about a tag or an attribute. */
  const naReason = (row: PageRow) => /^`?n\/a \((.*\S.*)\)`?$/.exec(row.check)?.[1];

  function parseCheck(row: PageRow): Spec[] {
    if (naReason(row) !== undefined) return [];
    const m = /^`([^`]+)`$/.exec(row.check);
    if (!m) throw new Error(`row ${row.row} is on main and its Contract check cell is not one backticked spec: "${row.check}"`);
    return m[1]!.split(";").map((part) => {
      const [tag, tokens, ...rest] = part.split(":").map((x) => x.trim());
      if (!tag || tokens === undefined || rest.length > 0 || !/^[a-z][a-z0-9-]*$/.test(tag) || tokens === "") {
        throw new Error(`row ${row.row}: cannot parse spec "${part.trim()}"`);
      }
      const spec: Spec = { tag, attrs: [], children: [], values: [] };
      for (const token of tokens.split(/\s+/)) {
        if (token.startsWith(">")) spec.children.push(token.slice(1));
        else if (token.includes("=")) {
          const [attr, list] = token.split("=");
          spec.values.push({ attr: attr!, values: list!.split(",") });
        } else spec.attrs.push(token);
      }
      return spec;
    });
  }

  // What post.mx does not use: `destroy` (with `accept` and `validate`), `accept` on
  // update, `validate` in create and read, and the attribute types other than
  // string and atom.
  const EXTRA = [
    'resource="extra"',
    "  attributes",
    '    uuid-primary-key="id"',
    '    attribute="uuid" type="uuid"',
    '    attribute="at" type="datetime"',
    '    attribute="flag" type="boolean" default=true',
    '    attribute="count" type="integer" default=0',
    '    attribute="ratio" type="float" default=0.5',
    "  actions",
    '    create="open"',
    '      validate=({ extra }) => extra.ok message="not ok"',
    '    update="close" accept=["flag"]',
    '    destroy="remove" accept=["flag"]',
    '      validate=({ extra }) => extra.ok message="not ok"',
    '    read="all"',
    '      validate=({ extra }) => extra.ok message="not ok"',
    "",
  ].join("\n");

  interface TagNode {
    kind: string;
    name?: string;
    attrs?: { name: string; value?: unknown }[];
    children?: TagNode[];
  }
  const collect = (node: TagNode, into: TagNode[] = []): TagNode[] => {
    if (node.kind === "tag") into.push(node);
    for (const child of node.children ?? []) collect(child, into);
    return into;
  };
  const used = [fixture("post.mx").source, EXTRA].flatMap((source) => {
    const result = parse(source);
    expect(result.diagnostics).toEqual([]);
    return collect(result.tree as unknown as TagNode);
  });

  test("the page's section 3 is read: 110 rows, each with a status and a check cell", () => {
    expect(rows).toHaveLength(110);
    expect(rows.map((r) => r.row)).toEqual(Array.from({ length: 110 }, (_, i) => i + 1));
    expect(rows.filter((r) => r.onMain).length).toBeGreaterThan(30);
  });

  test("the rows that opt out with `n/a (reason)` are exactly these, each with a reason", () => {
    const optedOut = rows.filter((r) => /^`?n\/a\b/.test(r.check));
    expect(optedOut.map((r) => r.row)).toEqual([110]);
    for (const r of optedOut) {
      expect(r.onMain, `row ${r.row}`).toBe(true);
      expect(naReason(r)?.trim().length, `row ${r.row} needs a reason`).toBeGreaterThan(10);
    }
  });

  test("`n/a` without a reason is rejected", () => {
    for (const bad of ["n/a", "`n/a`", "`n/a ()`", "n/a ( )"]) {
      expect(() => parseCheck({ row: 0, onMain: true, check: bad }), bad).toThrow();
    }
  });

  test("a row that is not on main carries `-`, so no row is checked by accident or skipped by silence", () => {
    for (const r of rows.filter((x) => !x.onMain)) expect(r.check, `row ${r.row}`).toBe("-");
  });

  test("the parser rejects a malformed check cell instead of skipping it", () => {
    for (const bad of ["", "-", "`resource`", "`: value`", "`Resource: value`", "`a: b: c`", "resource: value"]) {
      expect(() => parseCheck({ row: 0, onMain: true, check: bad }), bad).toThrow();
    }
  });

  for (const r of rows.filter((x) => x.onMain)) {
    test(`row ${r.row} (${r.check})`, () => {
      for (const spec of parseCheck(r)) {
        const contract = contracts[spec.tag as keyof typeof contracts] as CustomTag | undefined;
        expect(contract, `no contract <${spec.tag}>`).toBeDefined();
        const declaredAttrs = Object.keys(contract!.attributes ?? {});
        const declaredChildren = Object.keys(contract!.children ?? {});
        const tags = used.filter((t) => t.name === spec.tag);
        expect(tags.length, `no clean fixture uses <${spec.tag}>`).toBeGreaterThan(0);
        for (const a of [...spec.attrs, ...spec.values.map((v) => v.attr)]) {
          expect(declaredAttrs, `<${spec.tag}> does not declare \`${a}\``).toContain(a);
          expect(
            tags.some((t) => t.attrs?.some((x) => x.name === a)),
            `no clean fixture uses ${spec.tag}.${a}`,
          ).toBe(true);
        }
        for (const c of spec.children) {
          expect(declaredChildren, `<${spec.tag}> does not declare child <${c}>`).toContain(c);
          expect(
            tags.some((t) => t.children?.some((x) => x.name === c)),
            `no clean fixture nests <${c}> in <${spec.tag}>`,
          ).toBe(true);
        }
        for (const { attr, values } of spec.values) {
          for (const value of values) {
            expect(
              tags.some((t) => t.attrs?.some((x) => x.name === attr && x.value === value)),
              `no clean fixture sets ${spec.tag}.${attr}="${value}"`,
            ).toBe(true);
          }
        }
      }
    });
  }

  test("no tag on main is outside the page: every contract is named by a row, as a tag or as a child", () => {
    const named = new Set<string>();
    for (const r of rows.filter((x) => x.onMain)) {
      for (const spec of parseCheck(r)) {
        named.add(spec.tag);
        for (const c of spec.children) named.add(c);
      }
    }
    // `value` (the body of `calculate`) is named as a child of `calculate`.
    expect([...named].sort()).toEqual(Object.keys(contracts).sort());
  });

  test("no attribute on main is outside the page: every declared attribute is named by a row for its tag", () => {
    const named = new Map<string, Set<string>>();
    for (const r of rows.filter((x) => x.onMain)) {
      for (const spec of parseCheck(r)) {
        const set = named.get(spec.tag) ?? new Set<string>();
        for (const a of [...spec.attrs, ...spec.values.map((v) => v.attr)]) set.add(a);
        named.set(spec.tag, set);
      }
    }
    for (const [tag, contract] of Object.entries(contracts)) {
      for (const attr of Object.keys((contract as CustomTag).attributes ?? {})) {
        if (tag === "value" && attr === "value") continue; // the body of `calculate`, code
        expect(named.get(tag)?.has(attr), `<${tag}> declares \`${attr}\` but no on-main row names it`).toBe(true);
      }
    }
  });
});
