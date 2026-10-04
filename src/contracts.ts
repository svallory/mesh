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
 * Declarations plus `analyze` only: no `transform`, `finalize` or templates.
 * Mesh reads the static tree `parseData` returns; MX enforces the shape of that
 * tree at parse time, so a resource file that reaches Mesh's own stages already
 * has the right tags in the right places with the right attribute types.
 *
 * Every contract is closed: it lists its attributes, attribute tags and child
 * tags, and an empty record means "none". MX treats an omitted key as open, so
 * `closed()` fills each key explicitly. Every authored value that Mesh reads
 * statically is `literalOnly`: a static tree has no scope, so an identifier
 * (`resource=post`) would reach Mesh as an unevaluable expression. Function
 * attributes (`change=`, `validate=`, ...) are the exception; they are code.
 *
 * A default attribute (`resource="post"`) arrives as an attribute named `value`,
 * so every tag that takes one declares `value`.
 *
 * Rules that need more than a declaration (an attribute required only when
 * another has a given value, one-of groups, literal array contents) live in
 * `analyze`.
 *
 * Empty sections are allowed on purpose: `attributes`, `relationships`,
 * `actions` and the other containers may have no children. Whether a resource
 * needs at least one attribute is a model rule, enforced when Mesh builds the
 * model. Likewise "exactly one `resource` per file" cannot be declared (MX has
 * no root cardinality) and is enforced there too.
 */

/** The action kinds a policy's `action-type` and `defaults` may name. */
export const ACTION_TYPES = ["create", "read", "update", "destroy"] as const;

/** The attribute types Mesh resource files may declare. */
export const ATTRIBUTE_TYPES = [
  "string",
  "number",
  "boolean",
  "enum",
  "uuid",
  "datetime",
] as const;

/**
 * A calculation yields a value, never a choice from a list, so it takes the
 * attribute types except `enum` (an enum needs `values`, which `calculate`
 * does not declare).
 */
export const CALCULATION_TYPES = ATTRIBUTE_TYPES.filter((t) => t !== "enum");

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
  elements?: (LooseNode | null)[];
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
        if (attr && lit?.kind === "string" && lit.value === "") {
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
 * `values` belongs to enum attributes and only to them, an enum needs at
 * least one, and a literal `default` has to fit the type.
 *
 * `type` is `literalOnly`, so by the time this runs it is a string literal.
 */
function analyzeAttribute(calls: readonly TagCall[], ctx: AnalyzeContext): void {
  for (const call of calls) {
    const type = literalOf(attrNamed(call, "type"));
    if (type?.kind !== "string") continue;
    const values = attrNamed(call, "values");
    if (type.value === "enum" && values === undefined) {
      ctx.fail("type `enum` requires `values`", call.loc);
    }
    if (type.value !== "enum" && values !== undefined) {
      ctx.fail(
        `\`values\` is only allowed when \`type\` is "enum", not "${type.value}"`,
        values.loc,
      );
    }
    const options = arrayOf(values);
    if (values && options?.length === 0) {
      ctx.fail("an enum needs at least one value in `values`", values.loc);
    }

    const def = attrNamed(call, "default");
    const lit = literalOf(def);
    if (!def || !lit) continue;
    if (type.value === "enum") {
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
    } else if (type.value === "number") {
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

/** A policy applies to an action by name or to a class of actions by type: exactly one. */
function analyzePolicy(calls: readonly TagCall[], ctx: AnalyzeContext): void {
  for (const call of calls) {
    const action = attrNamed(call, "action");
    const actionType = attrNamed(call, "action-type");
    if (action === undefined && actionType === undefined) {
      ctx.fail("requires `action` or `action-type`", call.loc);
    }
    if (action !== undefined && actionType !== undefined) {
      ctx.fail("takes `action` or `action-type`, not both", actionType.loc);
    }
  }
}

/** `defaults=["read", "destroy"]` names built-in actions; each item has to be one. */
function analyzeDefaults(calls: readonly TagCall[], ctx: AnalyzeContext): void {
  for (const call of calls) {
    const attr = attrNamed(call, "value");
    for (const item of arrayOf(attr) ?? []) {
      if (item !== undefined && !(ACTION_TYPES as readonly string[]).includes(item)) {
        ctx.fail(
          `\`defaults\` item "${item}" must be one of ${quoted(ACTION_TYPES)}`,
          attr?.loc,
        );
      }
    }
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
      timestamps: {},
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
      values: strings(),
      required: flag(),
      public: flag(),
      default: { literalOnly: true },
    },
    analyze: all(nonEmpty("value"), analyzeAttribute),
  }),
  timestamps: closed({ parents: ["attributes"] }),

  relationships: closed({
    parents: ["resource"],
    children: {
      "belongs-to": { repeatable: true },
      "has-many": { repeatable: true },
    },
  }),
  "belongs-to": closed({
    parents: ["relationships"],
    attributes: { ...name(), resource: str({ required: true }) },
    analyze: nonEmpty("value", "resource"),
  }),
  "has-many": closed({
    parents: ["relationships"],
    attributes: { ...name(), resource: str({ required: true }) },
    analyze: nonEmpty("value", "resource"),
  }),

  actions: closed({
    parents: ["resource"],
    children: {
      defaults: {},
      create: { repeatable: true },
      update: { repeatable: true },
      read: { repeatable: true },
      destroy: { repeatable: true },
    },
  }),
  defaults: closed({
    parents: ["actions"],
    attributes: { value: strings({ required: true }) },
    analyze: analyzeDefaults,
  }),
  create: closed({
    parents: ["actions"],
    attributes: { ...name(), accept: strings() },
    children: { change: { repeatable: true } },
    analyze: nonEmpty("value"),
  }),
  update: closed({
    parents: ["actions"],
    attributes: { ...name(), accept: strings() },
    children: { change: { repeatable: true }, validate: { repeatable: true } },
    analyze: nonEmpty("value"),
  }),
  destroy: closed({
    parents: ["actions"],
    attributes: name(),
    children: { change: { repeatable: true }, validate: { repeatable: true } },
    analyze: nonEmpty("value"),
  }),
  read: closed({
    parents: ["actions"],
    attributes: name(),
    children: { filter: {}, sort: {} },
    analyze: nonEmpty("value"),
  }),
  change: closed({
    parents: ["create", "update", "destroy"],
    attributes: { value: code() },
  }),
  validate: closed({
    parents: ["update", "destroy"],
    attributes: { value: code(), message: str() },
  }),
  filter: closed({
    parents: ["read"],
    attributes: { value: code() },
  }),
  sort: closed({
    parents: ["read"],
    attributes: { value: strings({ required: true }) },
  }),

  policies: closed({
    parents: ["resource"],
    children: { policy: { repeatable: true } },
  }),
  policy: closed({
    parents: ["policies"],
    attributes: {
      action: str(),
      "action-type": str({ enum: [...ACTION_TYPES] }),
    },
    children: { "authorize-if": { repeatable: true, required: true } },
    analyze: all(analyzePolicy, nonEmpty("action")),
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
    attributes: { ...name(), relationship: str({ required: true }) },
    analyze: nonEmpty("value", "relationship"),
  }),
} satisfies ContractMap;
