import type {
  AnalyzeContext,
  Attr,
  ContractMap,
  CustomTag,
  CustomTagAttribute,
  TagCall,
} from "@mxlang/core";

/**
 * Mesh's resource-file vocabulary as MX tag contracts (MX decision 142).
 *
 * The vocabulary copies Ash's DSL, spelled by the naming rule of the
 * vocabulary mapping (apps/docs/docs/architecture/roadmap/vocabulary-mapping.md,
 * section 0): Ash's snake_case names in kebab-case, a trailing `?` dropped
 * (`allow_nil?` -> `allow-nil`). Names that differ from Ash only by that rule
 * are not deviations.
 *
 * Declarations plus `analyze` only: no `transform`, `finalize` or templates.
 * Mesh reads the static tree `parseData` returns; MX enforces the shape of that
 * tree at parse time, so a resource file that reaches Mesh's own stages already
 * has the right tags in the right places with the right attribute types.
 *
 * Every contract is closed: it lists its attributes, attribute tags and child
 * tags, and an empty record means "none". MX treats an omitted key as open, so
 * `closed()` fills each key explicitly. Every authored value that Mesh reads
 * statically is `literalOnly`: a static tree has no scope, so an identifier
 * (`table=posts`) would reach Mesh as an unevaluable expression. `literalOnly`
 * accepts literal arrays and objects, so `constraints={ one_of: [...] }` keeps
 * it. The exceptions are code: function attributes (`change=`, `validate=`,
 * ...) and a policy's condition (`policy=action_type("read")`, a call, checked
 * in `analyze`).
 *
 * A default attribute (`resource="post"`) arrives as an attribute named `value`,
 * so every tag that takes one declares `value`.
 *
 * Rules that need more than a declaration (an attribute required only when
 * another has a given value, the contents of a check call, literal array
 * contents) live in `analyze`.
 *
 * Empty sections are allowed on purpose: `attributes`, `relationships`,
 * `actions` and the other containers may have no children. Whether a resource
 * needs at least one attribute is a model rule, enforced when Mesh builds the
 * model. Likewise "exactly one `resource` per file" cannot be declared (MX has
 * no root cardinality) and is enforced there too.
 */

/** The action kinds a `defaults` list and the `action_type` check may name. */
export { ACTION_TYPES } from "@mesh/model";
import { ACTION_TYPES, ATTRIBUTE_TYPES as ATTRIBUTE_REGISTRY } from "@mesh/model";

/** The attribute types Mesh resource files may declare. */
export const ATTRIBUTE_TYPES = ATTRIBUTE_REGISTRY.map((type) => type.name);

/**
 * A calculation yields a value, never a choice from a list, so it takes the
 * attribute types except `atom` (an atom needs `constraints`, which
 * `calculate` does not declare).
 */
export const CALCULATION_TYPES = ATTRIBUTE_TYPES.filter((t) => t !== "atom");

/** The policy checks the vocabulary has so far (mapping page, row 91). */
const POLICY_CHECKS = ["action", "action_type"] as const;

type Analyze = NonNullable<CustomTag["analyze"]>;

/** A contract with every key spelled out, so nothing is open by omission. */
function closed(def: CustomTag): CustomTag {
  return { attributes: {}, attributeTags: {}, children: {}, ...def };
}

const str = (extra: CustomTagAttribute = {}): CustomTagAttribute => ({
  type: "string",
  literalOnly: true,
  ...extra,
});
const strings = (extra: CustomTagAttribute = {}): CustomTagAttribute => ({
  type: "array",
  items: "string",
  literalOnly: true,
  ...extra,
});
const flag = (): CustomTagAttribute => ({ type: "boolean", literalOnly: true });
const code = (): CustomTagAttribute => ({ type: "function", required: true });
/** The default attribute of a tag that names something: `create="publish"`. */
const name = (): Record<string, CustomTagAttribute> => ({
  value: str({ required: true }),
});

// ---- reading what an attribute carries -------------------------------------

type Literal =
  | { kind: "string"; value: string }
  | { kind: "number"; value: number }
  | { kind: "boolean"; value: boolean };

// Babel nodes are untyped in core (`Node`), so read them structurally.
interface LooseNode {
  type: string;
  value?: unknown;
  name?: unknown;
  operator?: string;
  argument?: LooseNode;
  elements?: (LooseNode | null)[];
  callee?: LooseNode;
  arguments?: LooseNode[];
  properties?: (LooseNode | null)[];
  key?: LooseNode;
  computed?: boolean;
}

function nodeOf(attr: Attr | undefined): LooseNode | undefined {
  return attr?.kind === "dynamic" || attr?.kind === "bound"
    ? (attr.value.node as LooseNode)
    : undefined;
}

/** The literal an attribute carries, `undefined` for anything not written as one. */
function literalOf(attr: Attr | undefined): Literal | undefined {
  if (attr === undefined) return undefined;
  if (attr.kind === "static") return { kind: "string", value: attr.value };
  if (attr.kind === "boolean") return { kind: "boolean", value: true };
  const node = nodeOf(attr);
  if (node?.type === "StringLiteral")
    return { kind: "string", value: node.value as string };
  if (node?.type === "NumericLiteral")
    return { kind: "number", value: node.value as number };
  if (node?.type === "UnaryExpression" && node.operator === "-") {
    const arg = node.argument;
    if (arg?.type === "NumericLiteral")
      return { kind: "number", value: -(arg.value as number) };
  }
  if (node?.type === "BooleanLiteral")
    return { kind: "boolean", value: node.value as boolean };
  return undefined;
}

/** The elements of an array literal; `undefined` when it is not one. Non-string elements are `undefined` entries. */
function arrayOf(attr: Attr | undefined): (string | undefined)[] | undefined {
  const node = nodeOf(attr);
  if (node?.type !== "ArrayExpression") return undefined;
  return (node.elements ?? []).map((el) =>
    el?.type === "StringLiteral" ? (el.value as string) : undefined,
  );
}

function attrNamed(call: TagCall, attrName: string): Attr | undefined {
  return call.attrs.find(
    (attr) => attr.kind !== "spread" && attr.name === attrName,
  );
}

const quoted = (items: readonly string[]) =>
  items.map((i) => `"${i}"`).join(", ");

// ---- analyze rules ---------------------------------------------------------

/** A tag that names something may not be named with an empty string. */
function nonEmpty(...attrNames: string[]): Analyze {
  return (calls, ctx) => {
    for (const call of calls) {
      for (const attrName of attrNames) {
        const attr = attrNamed(call, attrName);
        const lit = literalOf(attr);
        if (attr && lit?.kind === "string" && lit.value.trim() === "") {
          ctx.fail(`\`${attrName}\` may not be empty`, attr.loc);
        }
      }
    }
  };
}

function all(...rules: Analyze[]): Analyze {
  return (calls, ctx) => {
    for (const rule of rules) rule(calls, ctx);
  };
}

/**
 * The `one_of` list inside `constraints={ one_of: [...] }`: the string items,
 * with `undefined` entries where the item is not a string literal, or
 * `undefined` when there is no well-formed `one_of` list.
 */
function oneOfItems(constraints: Attr | undefined): {
  items: (string | undefined)[] | undefined;
  problems: string[];
} {
  const problems: string[] = [];
  if (constraints === undefined) return { items: undefined, problems };
  const node = nodeOf(constraints);
  if (node === undefined || node.type !== "ObjectExpression") {
    problems.push("`constraints` must be an object literal with `one_of`");
    return { items: undefined, problems };
  }
  let oneOf: LooseNode | undefined;
  for (const prop of node.properties ?? []) {
    if (prop?.type !== "ObjectProperty" || prop.computed === true) {
      problems.push("`constraints` must be an object literal with `one_of`");
      return { items: undefined, problems };
    }
    const key =
      prop.key?.type === "Identifier" || prop.key?.type === "StringLiteral"
        ? (prop.key.name ?? prop.key.value)
        : undefined;
    if (key !== "one_of") {
      problems.push(
        `\`constraints\` has an unknown constraint "${String(key)}"; only \`one_of\` is known`,
      );
      continue;
    }
    oneOf = prop.value as LooseNode | undefined;
  }
  if (oneOf === undefined) {
    problems.push("`constraints` must name `one_of`, the list of allowed values");
    return { items: undefined, problems };
  }
  if (oneOf.type !== "ArrayExpression") {
    problems.push("`one_of` must be a list of strings");
    return { items: undefined, problems };
  }
  return {
    items: (oneOf.elements ?? []).map((el) =>
      el?.type === "StringLiteral" ? (el.value as string) : undefined,
    ),
    problems,
  };
}

/**
 * `constraints` belongs to atom attributes and only to them, an atom needs
 * `one_of` with at least one value, and a literal `default` has to fit the
 * type.
 *
 * `type` is `literalOnly`, so by the time this runs it is a string literal.
 */
function analyzeAttribute(calls: readonly TagCall[], ctx: AnalyzeContext): void {
  for (const call of calls) {
    const type = literalOf(attrNamed(call, "type"));
    if (type?.kind !== "string") continue;
    const constraints = attrNamed(call, "constraints");
    if (type.value === "atom" && constraints === undefined) {
      ctx.fail("type `atom` requires `constraints`", call.loc);
    }
    if (type.value !== "atom" && constraints !== undefined) {
      ctx.fail(
        `\`constraints\` is only allowed when \`type\` is "atom", not "${type.value}"`,
        constraints.loc,
      );
    }
    const { items: options, problems } = oneOfItems(constraints);
    for (const problem of problems) {
      ctx.fail(problem, constraints?.loc);
    }
    if (constraints && options?.length === 0) {
      ctx.fail("an atom needs at least one value in `one_of`", constraints.loc);
    }
    options?.forEach((item, index) => {
      if (item === undefined) {
        ctx.fail(`\`one_of\` item ${index + 1} must be a string`, constraints?.loc);
      }
    });
    checkItems("one_of", options, constraints, ctx);

    const def = attrNamed(call, "default");
    if (!def) continue;
    const lit = literalOf(def);
    if (!lit) {
      ctx.fail("`default` must be a string, number or boolean literal", def.loc);
    }
    if (type.value === "atom") {
      const known = options?.filter((o): o is string => o !== undefined);
      if (
        known &&
        known.length === options?.length &&
        !(lit.kind === "string" && known.includes(lit.value))
      ) {
        ctx.fail(
          `\`default\` must be one of ${quoted(known)}, got ${describe(lit)}`,
          def.loc,
        );
      }
    } else if (type.value === "boolean") {
      if (lit.kind !== "boolean") {
        ctx.fail(`\`default\` must be true or false, got ${describe(lit)}`, def.loc);
      }
    } else if (type.value === "integer") {
      if (lit.kind !== "number" || !Number.isInteger(lit.value)) {
        ctx.fail(`\`default\` must be an integer, got ${describe(lit)}`, def.loc);
      }
    } else if (type.value === "float") {
      if (lit.kind !== "number") {
        ctx.fail(`\`default\` must be a number, got ${describe(lit)}`, def.loc);
      }
    } else if (lit.kind !== "string") {
      ctx.fail(
        `\`default\` must be a string for type "${type.value}", got ${describe(lit)}`,
        def.loc,
      );
    }
  }
}

function describe(lit: Literal): string {
  return lit.kind === "string" ? `"${lit.value}"` : String(lit.value);
}

/**
 * A policy's condition is a check call (`policy=action_type("read")`,
 * `policy=action("publish")`) or a list of them (mapping page, D22). On main
 * the checks are `action` and `action_type` (row 91).
 */
function analyzePolicy(calls: readonly TagCall[], ctx: AnalyzeContext): void {
  for (const call of calls) {
    const value = attrNamed(call, "value");
    const node = nodeOf(value);
    const checks =
      node?.type === "ArrayExpression" ? (node.elements ?? []) : [node];
    if (checks.length === 0) {
      ctx.fail("a policy needs at least one check call", value?.loc);
    }
    for (const check of checks) {
      checkPolicyCheck(check, value, ctx);
    }
  }
}

function checkPolicyCheck(
  check: LooseNode | null | undefined,
  value: Attr | undefined,
  ctx: AnalyzeContext,
): void {
  if (check?.type !== "CallExpression") {
    ctx.fail(
      'takes a check call, for example `action_type("read")` or `action("publish")`',
      value?.loc,
    );
  }
  const callee = check.callee;
  const checkName = callee?.type === "Identifier" ? String(callee.name) : "";
  if (!(POLICY_CHECKS as readonly string[]).includes(checkName)) {
    ctx.fail(
      `unknown policy check \`${checkName || "?"}\`; the checks are ${quoted(POLICY_CHECKS)}`,
      value?.loc,
    );
  }
  const args = check.arguments ?? [];
  const arg = args.length === 1 ? literalArgOf(args[0]) : undefined;
  if (arg === undefined || arg.kind !== "string") {
    ctx.fail(`\`${checkName}\` takes exactly one string argument`, value?.loc);
  }
  if (checkName === "action_type") {
    if (!(ACTION_TYPES as readonly string[]).includes(arg.value)) {
      ctx.fail(
        `\`action_type\` must be one of ${quoted(ACTION_TYPES)}, got "${arg.value}"`,
        value?.loc,
      );
    }
  } else if (arg.value.trim() === "") {
    ctx.fail("`action` may not be empty", value?.loc);
  }
}

/** The literal a call argument is written as, if it is one. */
function literalArgOf(node: LooseNode | undefined): Literal | undefined {
  if (node?.type === "StringLiteral")
    return { kind: "string", value: node.value as string };
  if (node?.type === "NumericLiteral")
    return { kind: "number", value: node.value as number };
  if (node?.type === "BooleanLiteral")
    return { kind: "boolean", value: node.value as boolean };
  return undefined;
}

/** Items of a string list: none blank, none repeated. */
function checkItems(
  label: string,
  items: (string | undefined)[] | undefined,
  attr: Attr | undefined,
  ctx: AnalyzeContext,
): void {
  const seen = new Set<string>();
  for (const item of items ?? []) {
    if (item === undefined) continue;
    if (item.trim() === "") {
      ctx.fail(`\`${label}\` has a blank item`, attr?.loc);
    }
    if (seen.has(item)) {
      ctx.fail(`\`${label}\` has a repeated item "${item}"`, attr?.loc);
    }
    seen.add(item);
  }
}

/** A list the tag exists to carry may not be empty. */
function nonEmptyList(label: string, attrName = "value"): Analyze {
  return (calls, ctx) => {
    for (const call of calls) {
      const attr = attrNamed(call, attrName);
      if (arrayOf(attr)?.length === 0) {
        ctx.fail(`\`${label}\` may not be empty`, attr?.loc);
      }
    }
  };
}

/** The items of the list in attribute `attrName` (default: the tag's own value). */
function listItems(label: string, attrName = "value"): Analyze {
  return (calls, ctx) => {
    for (const call of calls) {
      const attr = attrNamed(call, attrName);
      checkItems(label, arrayOf(attr), attr, ctx);
    }
  };
}

/** `defaults=["read", "destroy"]` names built-in actions; each item has to be one, once. */
function analyzeDefaults(calls: readonly TagCall[], ctx: AnalyzeContext): void {
  for (const call of calls) {
    const attr = attrNamed(call, "defaults");
    const items = arrayOf(attr);
    for (const item of items ?? []) {
      if (
        item !== undefined &&
        item.trim() !== "" &&
        !(ACTION_TYPES as readonly string[]).includes(item)
      ) {
        ctx.fail(
          `\`defaults\` item "${item}" must be one of ${quoted(ACTION_TYPES)}`,
          attr?.loc,
        );
      }
    }
    checkItems("defaults", items, attr, ctx);
  }
}

// ---- the vocabulary --------------------------------------------------------

export default {
  resource: closed({
    parents: ["#root"],
    attributes: {
      value: str({ required: true }),
      table: str(),
      domain: str(),
    },
    children: {
      attributes: { required: true },
      relationships: {},
      actions: {},
      policies: {},
      calculations: {},
      aggregates: {},
    },
    analyze: nonEmpty("value", "table", "domain"),
  }),

  attributes: closed({
    parents: ["resource"],
    children: {
      "uuid-primary-key": {},
      attribute: { repeatable: true },
      "create-timestamp": {},
      "update-timestamp": {},
    },
  }),
  "uuid-primary-key": closed({
    parents: ["attributes"],
    attributes: name(),
    analyze: nonEmpty("value"),
  }),
  attribute: closed({
    parents: ["attributes"],
    attributes: {
      value: str({ required: true }),
      type: str({ required: true, enum: [...ATTRIBUTE_TYPES] }),
      constraints: { literalOnly: true },
      "allow-nil": flag(),
      public: flag(),
      default: { literalOnly: true },
    },
    analyze: all(nonEmpty("value"), analyzeAttribute),
  }),
  "create-timestamp": closed({
    parents: ["attributes"],
    attributes: name(),
    analyze: nonEmpty("value"),
  }),
  "update-timestamp": closed({
    parents: ["attributes"],
    attributes: name(),
    analyze: nonEmpty("value"),
  }),

  relationships: closed({
    parents: ["resource"],
    children: {
      "belongs-to": { repeatable: true },
      "has-many": { repeatable: true },
    },
  }),
  "belongs-to": closed({
    parents: ["relationships"],
    attributes: { ...name(), destination: str({ required: true }) },
    analyze: nonEmpty("value", "destination"),
  }),
  "has-many": closed({
    parents: ["relationships"],
    attributes: { ...name(), destination: str({ required: true }) },
    analyze: nonEmpty("value", "destination"),
  }),

  actions: closed({
    parents: ["resource"],
    attributes: { defaults: strings() },
    children: {
      ...Object.fromEntries(ACTION_TYPES.map((kind) => [kind, { repeatable: true }])),
    },
    analyze: all(nonEmptyList("defaults", "defaults"), analyzeDefaults),
  }),
  create: closed({
    parents: ["actions"],
    attributes: { ...name(), accept: strings() },
    children: { change: { repeatable: true }, validate: { repeatable: true } },
    analyze: all(nonEmpty("value"), listItems("accept", "accept")),
  }),
  update: closed({
    parents: ["actions"],
    attributes: { ...name(), accept: strings() },
    children: { change: { repeatable: true }, validate: { repeatable: true } },
    analyze: all(nonEmpty("value"), listItems("accept", "accept")),
  }),
  destroy: closed({
    parents: ["actions"],
    attributes: { ...name(), accept: strings() },
    children: { change: { repeatable: true }, validate: { repeatable: true } },
    analyze: all(nonEmpty("value"), listItems("accept", "accept")),
  }),
  read: closed({
    parents: ["actions"],
    attributes: name(),
    children: { filter: {}, sort: {}, validate: { repeatable: true } },
    analyze: nonEmpty("value"),
  }),
  change: closed({
    parents: ["create", "update", "destroy"],
    attributes: { value: code() },
  }),
  validate: closed({
    parents: ["create", "update", "destroy", "read"],
    attributes: { value: code(), message: str() },
    analyze: nonEmpty("message"),
  }),
  filter: closed({
    parents: ["read"],
    attributes: { value: code() },
  }),
  sort: closed({
    parents: ["read"],
    attributes: { value: strings({ required: true }) },
    analyze: all(nonEmptyList("sort"), listItems("sort")),
  }),

  policies: closed({
    parents: ["resource"],
    children: { policy: { repeatable: true } },
  }),
  policy: closed({
    parents: ["policies"],
    attributes: { value: { required: true } },
    children: { "authorize-if": { repeatable: true, required: true } },
    analyze: analyzePolicy,
  }),
  "authorize-if": closed({
    parents: ["policy"],
    attributes: { value: code() },
  }),

  calculations: closed({
    parents: ["resource"],
    children: { calculate: { repeatable: true } },
  }),
  calculate: closed({
    parents: ["calculations"],
    attributes: {
      value: str({ required: true }),
      type: str({ required: true, enum: [...CALCULATION_TYPES] }),
    },
    children: { value: { required: true } },
    analyze: nonEmpty("value"),
  }),
  value: closed({
    parents: ["calculate"],
    attributes: { value: code() },
  }),

  aggregates: closed({
    parents: ["resource"],
    children: { count: { repeatable: true } },
  }),
  count: closed({
    parents: ["aggregates"],
    attributes: { ...name(), "relationship-path": str({ required: true }) },
    analyze: nonEmpty("value", "relationship-path"),
  }),
} satisfies ContractMap;
