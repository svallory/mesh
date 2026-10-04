import type { AnalyzeContext, Attr, ContractMap, TagCall } from "@mxlang/core";

/**
 * Mesh's resource-file vocabulary as MX tag contracts (MX decision 142).
 *
 * Declarations plus `analyze` only: no `transform`, `finalize` or templates.
 * Mesh reads the static tree `parseData` returns; MX enforces the shape of that
 * tree at parse time, so a resource file that reaches Mesh's own stages already
 * has the right tags in the right places with the right attribute types.
 *
 * A default attribute (`resource="post"`) arrives as an attribute named `value`,
 * so every tag that takes one declares `value`.
 *
 * Rules that need more than a declaration (an attribute required only when
 * another has a given value, one-of groups) live in `analyze`.
 */

/** The string literal an attribute carries, `undefined` when it is not a literal. */
function literal(attr: Attr | undefined): string | undefined {
  return attr?.kind === "static" ? attr.value : undefined;
}

function attrNamed(call: TagCall, name: string): Attr | undefined {
  return call.attrs.find((attr) => attr.kind !== "spread" && attr.name === name);
}

/**
 * `values` belongs to enum attributes and only to them.
 *
 * `type` that is not a string literal (an expression) cannot be judged, so the
 * rule stays silent rather than guess.
 */
function analyzeAttribute(calls: readonly TagCall[], ctx: AnalyzeContext): void {
  for (const call of calls) {
    const type = literal(attrNamed(call, "type"));
    const values = attrNamed(call, "values");
    if (type === undefined) continue;
    if (type === "enum" && values === undefined) {
      ctx.fail("type `enum` requires `values`", call.loc);
    }
    if (type !== "enum" && values !== undefined) {
      ctx.fail(
        `\`values\` is only allowed when \`type\` is "enum", not "${type}"`,
        values.loc,
      );
    }
  }
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
      ctx.fail(
        "takes `action` or `action-type`, not both",
        actionType.loc,
      );
    }
  }
}

/** The set of action kinds a policy's `action-type` may name. */
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

export default {
  resource: {
    parents: ["#root"],
    attributes: {
      value: { type: "string", required: true },
      table: { type: "string" },
      domain: { type: "string" },
    },
    children: {
      attributes: { required: true },
      relationships: {},
      actions: {},
      policies: {},
      calculations: {},
      aggregates: {},
    },
  },

  attributes: {
    parents: ["resource"],
    children: {
      "uuid-primary-key": {},
      attribute: { repeatable: true },
      timestamps: {},
    },
  },
  "uuid-primary-key": {
    children: {},
    parents: ["attributes"],
    attributes: { value: { type: "string", required: true } },
  },
  attribute: {
    parents: ["attributes"],
    attributes: {
      value: { type: "string", required: true },
      type: { type: "string", required: true, enum: [...ATTRIBUTE_TYPES] },
      values: { type: "array", items: "string" },
      required: { type: "boolean" },
      public: { type: "boolean" },
      default: {},
    },
    analyze: analyzeAttribute,
  },
  timestamps: { parents: ["attributes"], children: {} },

  relationships: {
    parents: ["resource"],
    children: {
      "belongs-to": { repeatable: true },
      "has-many": { repeatable: true },
    },
  },
  "belongs-to": {
    children: {},
    parents: ["relationships"],
    attributes: {
      value: { type: "string", required: true },
      resource: { type: "string", required: true },
    },
  },
  "has-many": {
    children: {},
    parents: ["relationships"],
    attributes: {
      value: { type: "string", required: true },
      resource: { type: "string", required: true },
    },
  },

  actions: {
    parents: ["resource"],
    children: {
      defaults: {},
      create: { repeatable: true },
      update: { repeatable: true },
      read: { repeatable: true },
    },
  },
  defaults: {
    children: {},
    parents: ["actions"],
    attributes: { value: { type: "array", items: "string", required: true } },
  },
  create: {
    parents: ["actions"],
    attributes: {
      value: { type: "string", required: true },
      accept: { type: "array", items: "string" },
    },
    children: { change: { repeatable: true } },
  },
  update: {
    parents: ["actions"],
    attributes: {
      value: { type: "string", required: true },
      accept: { type: "array", items: "string" },
    },
    children: { change: { repeatable: true }, validate: { repeatable: true } },
  },
  read: {
    parents: ["actions"],
    attributes: { value: { type: "string", required: true } },
    children: { filter: {}, sort: {} },
  },
  change: {
    children: {},
    parents: ["create", "update"],
    attributes: { value: { type: "function", required: true } },
  },
  validate: {
    children: {},
    parents: ["update"],
    attributes: {
      value: { type: "function", required: true },
      message: { type: "string" },
    },
  },
  filter: {
    children: {},
    parents: ["read"],
    attributes: { value: { type: "function", required: true } },
  },
  sort: {
    children: {},
    parents: ["read"],
    attributes: { value: { type: "array", items: "string", required: true } },
  },

  policies: {
    parents: ["resource"],
    children: { policy: { repeatable: true } },
  },
  policy: {
    parents: ["policies"],
    attributes: {
      action: { type: "string" },
      "action-type": { type: "string", enum: [...ACTION_TYPES] },
    },
    children: { "authorize-if": { repeatable: true, required: true } },
    analyze: analyzePolicy,
  },
  "authorize-if": {
    children: {},
    parents: ["policy"],
    attributes: { value: { type: "function", required: true } },
  },

  calculations: {
    parents: ["resource"],
    children: { calculate: { repeatable: true } },
  },
  calculate: {
    parents: ["calculations"],
    attributes: {
      value: { type: "string", required: true },
      type: { type: "string", required: true },
    },
    children: { value: { required: true } },
  },
  value: {
    children: {},
    parents: ["calculate"],
    attributes: { value: { type: "function", required: true } },
  },

  aggregates: {
    parents: ["resource"],
    children: { count: { repeatable: true } },
  },
  count: {
    children: {},
    parents: ["aggregates"],
    attributes: {
      value: { type: "string", required: true },
      relationship: { type: "string", required: true },
    },
  },
} satisfies ContractMap;
