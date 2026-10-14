import type {
  Attr,
  ContractMap,
  CustomTag,
  CustomTagAttribute,
  TagCall,
} from "@mxlang/core";
import { ACTION_TYPES, ATTRIBUTE_TYPES as REGISTRY } from "@meshfw/model";
export { ACTION_TYPES } from "@meshfw/model";
export const ATTRIBUTE_TYPES = REGISTRY.map((t) => t.name);
export const ROLLUPS = ["count", "sum", "avg", "min", "max"] as const;

/** Layer-1 vocabulary only: no transforms, evaluation, or source rewriting. */
const closed = (def: CustomTag): CustomTag => ({
  attributes: {},
  attributeTags: {},
  children: {},
  ...def,
});
const atom = (required = false): CustomTagAttribute => ({
  type: "atom",
  required,
  pattern: "^[A-Za-z_][A-Za-z0-9_]*$",
});
/** An enum value is a fixed-set atom, written into string literals only, so it may contain hyphens (`:review-accepted`). */
const valueAtom = (): CustomTagAttribute => ({
  type: "atom",
  pattern: "^[A-Za-z_][A-Za-z0-9_-]*$",
});
const text = (required = false): CustomTagAttribute => ({
  type: "string",
  literalOnly: true,
  required,
});
const flag = (): CustomTagAttribute => ({ type: "boolean", literalOnly: true });
const number = (): CustomTagAttribute => ({
  type: "number",
  literalOnly: true,
});
const fn = (required = false): CustomTagAttribute => ({
  type: "function",
  required,
});
const named = () => ({ name: atom(true) });
const children = (...names: readonly string[]) =>
  Object.fromEntries(names.map((name) => [name, { repeatable: true }]));
const get = (call: TagCall, name: string) =>
  call.attrs.find((a) => a.kind !== "spread" && a.name === name);
interface Node {
  type: string;
  name?: string;
  value?: unknown;
  extra?: { mxMember?: unknown; mxAtom?: unknown; mxTransaction?: unknown };
  elements?: (Node | null)[];
}
const node = (a: Attr | undefined): Node | undefined =>
  a && (a.kind === "dynamic" || a.kind === "bound")
    ? (a.value.node as Node | undefined)
    : undefined;
/** `&a`, `&a.b`, `&a.b.c`: plain property accesses from one marked member. */
const isMemberPath = (n: Node | null | undefined): boolean => {
  let cursor = n as (Node & { object?: Node; property?: Node; computed?: boolean }) | null | undefined;
  while (cursor && !cursor.extra?.mxMember) {
    if (cursor.type !== "MemberExpression" || cursor.computed || cursor.property?.type !== "Identifier") return false;
    cursor = cursor.object;
  }
  return cursor?.type === "MemberExpression";
};
const isMember = (n: Node | null | undefined) =>
  n?.type === "MemberExpression" && !!n.extra?.mxMember;
/** An unmarked identifier: not an atom (`:x`), and not the stand-in of a mark such as `&x` or `%.x`. */
const isPlainIdentifier = (n: Node | null | undefined) =>
  n?.type === "Identifier" && !n.extra?.mxMember && !n.extra?.mxAtom && !n.extra?.mxTransaction;
/**
 * A reference to another file's declaration (SYN-21): an imported identifier (`List`), or a member of a namespace import
 * (`billing.Invoice`), one plain property access on an identifier. Which import it is, and what that file declares, is
 * Mesh's to resolve (`front-end/references.ts`).
 */
const isReference = (n: Node | null | undefined): boolean => {
  if (isPlainIdentifier(n)) return true;
  const access = n as (Node & { object?: Node; property?: Node; computed?: boolean }) | null | undefined;
  return access?.type === "MemberExpression" && !access.computed && !access.extra?.mxMember
    && !access.extra?.mxTransaction
    && isPlainIdentifier(access.object) && isPlainIdentifier(access.property);
};
/** A slot that holds one member only (MX decision 182 addendum 4): MX checks
 * the `&name` form, after a kind or as a whole value; Mesh resolves membership. */
const member = (required = false): CustomTagAttribute => ({
  type: "member",
  required,
});
/** A list of members (`actions=[&publish]`): MX's `"member"` type takes one
 * member, so a list is an array whose elements Mesh checks for marks. */
const members = (): CustomTagAttribute => ({ type: "array" });
function references(lists: string[]): NonNullable<CustomTag["analyze"]> {
  return (calls, ctx) => {
    for (const call of calls) {
      for (const key of lists) {
        const a = get(call, key);
        if (!a) continue;
        const n = node(a);
        if (n?.type !== "ArrayExpression" || !n.elements?.every(isMember))
          ctx.fail(`\`${key}\` requires a list of member references`, { at: a.loc, code: "MESH_MEMBER_REFERENCE" });
        // As `types=[]`: an empty list names no action, so what it scopes would cover none.
        else if (!n.elements.length)
          ctx.fail(`\`${key}\` must name at least one action: an empty list covers none`, { at: a.loc, code: "MESH_MEMBER_REFERENCE" });
      }
    }
  };
}
const scope = () => ({
  types: { type: "atom", values: [...ACTION_TYPES] } as CustomTagAttribute,
  actions: members(),
});
const options = (type: string) => ({
  nullable: flag(),
  default: { literalOnly: true },
  ...(type === "enum" ? { values: valueAtom() } : {}),
  ...(["string", "integer", "float", "decimal"].includes(type) ? { min: number(), max: number() } : {}),
  ...(type === "string" ? { match: { type: "expression" as const } } : {}),
});
const steps = children("set", "when", "load", "run");
const body = { validate: {}, do: {} };
// The `member` child MX lowers a tagless `&name` line to (`MESH_DIALECT`). An
// inline wildcard contract, so no `member` tag is authorable at large; under
// input/set the builder still refuses an authored `member name="x"`.
const memberLine = (attributes: Record<string, CustomTagAttribute>) => ({
  pattern: "member",
  attributes: { name: { type: "string", required: true } as CustomTagAttribute, ...attributes },
  attributeTags: {},
  children: {},
});

const contracts: ContractMap = {
  entity: closed({
    parents: ["#root"],
    attributes: { ...named(), table: text() },
    children: {
      attributes: {},
      relationships: {},
      computed: {},
      actions: {},
      policies: {},
    },
  }),
  attributes: closed({
    parents: ["entity"],
    children: children(...ATTRIBUTE_TYPES),
  }),
  relationships: closed({
    parents: ["entity"],
    children: children("belongs-to", "has-many", "has-one"),
  }),
  computed: closed({
    parents: ["entity"],
    children: children(...ATTRIBUTE_TYPES, ...ROLLUPS),
  }),
  actions: closed({
    parents: ["entity"],
    attributes: {
      auto: { type: "atom", values: [...ACTION_TYPES] },
      "on:load": member(),
    },
    children: children(...ACTION_TYPES, "always"),
  }),
  always: closed({
    parents: ["actions"],
    attributes: scope(),
    children: body,
    analyze: references(["actions"]),
  }),
  input: closed({
    parents: [...ACTION_TYPES],
    children: {
      ...children(...ATTRIBUTE_TYPES),
      "*": memberLine({}),
    },
  }),
  validate: closed({
    parents: [...ACTION_TYPES, "always"],
    children: children("check"),
  }),
  check: closed({
    parents: ["validate"],
    attributes: {
      ...named(),
      that: fn(true),
      code: text(true),
      // Text, or a function of the arguments `that` gets (ACT-30): the contract leaves the type open, `check` in the builder tells them apart.
      message: { required: true },
      when: fn(),
      details: fn(),
    },
    // MX's contract takes one type per attribute, so `message` is left open and this hook refuses what is neither text nor a function.
    analyze(calls, ctx) {
      for (const call of calls) {
        const a = get(call, "message");
        if (!a) continue;
        const type = node(a)?.type;
        if (type === "ArrowFunctionExpression" || type === "FunctionExpression") continue;
        const s = a as { kind: string; value?: unknown; atom?: unknown; member?: unknown; node?: unknown };
        if (s.kind === "static" && typeof s.value === "string" && !s.atom && !s.member && !s.node) {
          if (!s.value.trim()) ctx.fail("message cannot be empty", { at: a.loc, code: "MESH_TEXT" });
          continue;
        }
        ctx.fail("message is text (`message=\"the order is empty\"`) or a function (`message=({ self }) => ...`)", { at: a.loc, code: "MESH_ATTRIBUTE_VALUE" });
      }
    },
  }),
  do: closed({ parents: [...ACTION_TYPES, "always"], children: steps }),
  set: closed({
    parents: ["do", "when"],
    children: {
      // `value` takes whatever was written (`&done=true`, `&status=:sent`,
      // `&title=""`, an expression); the builder requires it and type-checks it.
      "*": memberLine({ value: {} }),
    },
  }),
  when: closed({
    parents: ["do", "when"],
    attributes: { value: fn(true) },
    children: steps,
  }),
  load: closed({
    parents: ["do", "when"],
    attributes: { value: { ...members(), required: true } },
    analyze: references(["value"]),
  }),
  run: closed({
    parents: ["do", "when"],
    // `after=:write` moves the step after the action's own row is written (ADR-0068 decision 2).
    attributes: { value: fn(true), after: { type: "atom", values: ["write"] } },
  }),
  filter: closed({ parents: ["read"], attributes: { value: fn(true) } }),
  sort: closed({ parents: ["read"], children: children("asc", "desc") }),
  policies: closed({ parents: ["entity"], children: children("policy") }),
  policy: closed({
    parents: ["policies"],
    attributes: {
      ...named(),
      ...scope(),
      when: fn(),
      "authorize-if": fn(),
      "forbid-if": fn(),
    },
    children: children("authorize-if", "forbid-if"),
    analyze: references(["actions"]),
  }),
  "authorize-if": closed({
    parents: ["policy"],
    attributes: { value: fn(true) },
  }),
  "forbid-if": closed({ parents: ["policy"], attributes: { value: fn(true) } }),
};
for (const type of ATTRIBUTE_TYPES)
  contracts[type] = closed({
    parents: ["attributes", "input", "computed"],
    attributes: {
      ...named(),
      ...options(type),
      ...(["uuid", "integer", "string"].includes(type) ? { "primary-key": flag() } : {}),
      // A json value is opaque to the database, so it cannot be unique (ADR-0069).
      ...(type === "json" ? {} : { unique: flag() }),
      ...(type === "timestamp" ? { on: { type: "atom" as const, values: ["create", "update"] } } : {}),
      value: fn(),
    },
    analyze(calls, ctx) {
      for (const call of calls) {
        const match = get(call, "match");
        if (match && node(match)?.type !== "RegExpLiteral")
          ctx.fail("match must be a regular expression", { at: match.loc, code: "MESH_ATTRIBUTE_RULE" });
        const values = get(call, "values");
        if (values && node(values)?.type !== "ArrayExpression")
          ctx.fail("values must be a list of atoms", { at: values.loc, code: "MESH_ENUM_VALUES" });
      }
    },
  });
for (const kind of ["belongs-to", "has-many", "has-one"])
  contracts[kind] = closed({
    parents: ["relationships"],
    attributes: {
      ...named(),
      entity: { type: "expression", required: true },
      ...(kind === "belongs-to" ? { nullable: flag() } : {}),
      // The other entity's belongs-to this follows (ADR-0070).
      ...(kind === "has-many" ? { inverse: atom() } : {}),
    },
    analyze(calls, ctx) {
      for (const call of calls) {
        const a = get(call, "entity");
        if (!isReference(node(a)))
          ctx.fail("entity must be an imported identifier (`List`) or a member of a namespace import (`billing.Invoice`)", { at: a?.loc, code: "MESH_ENTITY_REFERENCE" });
      }
    },
  });
for (const kind of ACTION_TYPES)
  contracts[kind] = closed({
    parents: ["actions"],
    attributes: { ...named(), ...(kind === "read" ? { filter: fn() } : {}) },
    children: {
      input: {},
      ...body,
      ...(kind === "read" ? { filter: {}, sort: {} } : {}),
    },
  });
for (const kind of ROLLUPS)
  contracts[kind] = closed({
    parents: ["computed"],
    // `of=&lines.amount` (SYN-28): a member reference, a path of marked members through relationships. The string form is refused with its fix.
    attributes: { ...named(), of: { required: true } },
    analyze(calls, ctx) {
      for (const call of calls) {
        const a = get(call, "of");
        if (!a) continue;
        const literal = node(a);
        const written = a.kind === "static" ? a.value : literal?.type === "StringLiteral" && !literal.extra?.mxAtom ? String(literal.value) : undefined;
        if (written !== undefined) {
          const path = /^[A-Za-z_]\w*(\.[A-Za-z_]\w*)*$/.test(written) ? written : undefined;
          ctx.fail(
            `of takes a member reference, not a string: ${path ? `write of=&${path}` : "write of=&relationship for a count, of=&relationship.attribute for the others"}`,
            { at: a.loc, code: "MESH_ROLLUP_PATH_STRING" },
          );
        } else if (!isMemberPath(node(a)) || /\s/.test((a.kind === "dynamic" ? a.value.code : "") ?? ""))
          ctx.fail("of takes a member reference: &relationship for a count, &relationship.attribute for the others", { at: a.loc, code: "MESH_ROLLUP_PATH" });
      }
    },
  });
for (const kind of ["asc", "desc"])
  contracts[kind] = closed({
    parents: ["sort"],
    attributes: { member: member(true) },
  });
// E1's function/array checks accept dynamic unknowns by design. This static
// dialect requires the written shape, not a runtime value of a compatible type.
for (const contract of Object.values(contracts)) {
  const analyze = contract.analyze;
  contract.analyze = (calls, ctx) => {
    for (const call of calls) {
      if (call.params.length || call.var)
        ctx.fail("tag parameters and variable bindings are not entity declarations", { at: call.loc, code: "MESH_SYNTAX" });
      for (const [key, declaration] of Object.entries(
        contract.attributes ?? {},
      )) {
        const a = get(call, key);
        if (!a) continue;
        if (a.kind === "bound")
          ctx.fail("bound attributes are not entity declarations", { at: a.loc, code: "MESH_SYNTAX" });
        const n = node(a);
        if (
          declaration.type === "function" &&
          !["ArrowFunctionExpression", "FunctionExpression"].includes(
            n?.type ?? "",
          )
        )
          ctx.fail(`${key} must be a function as written`, { at: a.loc, code: "MESH_EXPRESSION" });
        if (
          key === "name" &&
          declaration.type === "atom" &&
          !(a.kind === "static" && a.atom)
        )
          ctx.fail("a declaration needs one atom name", { at: a.loc, code: "MESH_NAME" });
        if (["auto", "types", "values"].includes(key)) {
          if (n?.type !== "ArrayExpression")
            ctx.fail(`${key} must be a list of atoms`, { at: a.loc, code: "MESH_ATOM_LIST" });
          const names = n?.elements?.map((e) => e?.value) ?? [];
          if (!names.length || new Set(names).size !== names.length)
            ctx.fail(`${key} must be non-empty with no repeated values`, { at: a.loc, code: "MESH_ATOM_LIST" });
        }
        if (
          declaration.type === "string" &&
          a.kind === "static" &&
          !a.value.trim()
        )
          ctx.fail(`${key} cannot be empty`, { at: a.loc, code: "MESH_TEXT" });
      }
    }
    analyze?.(calls, ctx);
  };
}
export default contracts;
