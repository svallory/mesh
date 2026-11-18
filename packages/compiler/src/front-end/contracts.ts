import type {
  Attr,
  ContractMap,
  CustomTag,
  CustomTagAttribute,
  SourceSpan,
  TagCall,
} from "@mxlang/core";
import { ACTION_TYPES, ATTRIBUTE_TYPES as REGISTRY } from "@meshfw/model";
import { itemNotAtom } from "./syntax/atoms-sugars.ts";
export { ACTION_TYPES } from "@meshfw/model";
export const ATTRIBUTE_TYPES = REGISTRY.map((t) => t.name);
export const ROLLUPS = ["count", "sum", "avg", "min", "max"] as const;
/** The relationship kinds. Each once took its entity as the line's value (`belongs-to=:List :list`, syntax v3). */
export const RELATIONSHIP_KINDS = ["belongs-to", "has-many", "has-one"] as const;

/** Layer-1 vocabulary only: no transforms, evaluation, or source rewriting. */
const closed = (def: CustomTag): CustomTag => ({
  attributes: {},
  attributeTags: {},
  children: {},
  ...def,
});
/** One atom (`mesh:Atom`, `syntax/mesh.ts`); core checks the shape, `syntax/atoms-sugars.ts` checks `pattern`. */
const atom = (required = false): CustomTagAttribute => ({
  type: "mesh:Atom",
  required,
  pattern: "^[A-Za-z_][A-Za-z0-9_]*$",
});
/** A list of atoms: `[:a, :b]`. The slot's `values`/`pattern` apply to each element. */
const atomList = (extra: { values?: string[]; pattern?: string } = {}): CustomTagAttribute => ({
  type: "array",
  items: "mesh:Atom",
  ...extra,
});
/** An enum value is a fixed-set atom, written into string literals only, so it may contain hyphens (`:review-accepted`). The slot is the list `values=[:a, :b]`. */
const valueAtom = (): CustomTagAttribute => atomList({ pattern: "^[A-Za-z_][A-Za-z0-9_-]*$" });
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
/** A rule's name in the architecture file: an atom that may hold hyphens, as an enum value may. */
const ruleName = (): CustomTagAttribute => ({ type: "mesh:Atom", required: true, pattern: "^[A-Za-z_][A-Za-z0-9_-]*$" });
/**
 * A field parent: a tag whose children are field lines (`attributes`, `event`, `command`, `concept`). It admits a concept
 * use (`Money :total`), whose name no contract can list in advance (a concept is a tag file MX finds by its file name,
 * `concept-file.ts`), so it declares no `children` (ruling D36, OD3). Each field kind's `parents` keeps a misplaced known
 * line an error (`MESH_PARENT_NOT_ALLOWED`), and MX keeps a tagless `&title` one (`MESH_UNKNOWN_TAG`). Every change to one
 * of these contracts builds it through this helper, so `children` stays absent.
 */
export const fieldParent = (def: CustomTag): CustomTag => {
  const { children: _open, ...rest } = closed(def);
  return rest;
};
const children = (...names: readonly string[]) =>
  Object.fromEntries(names.map((name) => [name, { repeatable: true }]));
/**
 * The head of a line that is a reference and nothing else (`InvoicePaid`, `notices.InvoiceOverdue`): the builder resolves
 * it (`front-end/references.ts`, `lineHeadReference`). The pattern admits any dotted identifier path, so a path of three
 * parts reaches the builder, which says what a reference is, instead of MX's "not a known tag". MX anchors it.
 */
export const REFERENCE_HEAD = "[A-Za-z_$][A-Za-z0-9_$]*(?:\\.[A-Za-z_$][A-Za-z0-9_$]*)*";
/**
 * A listing line's contract: a wildcard child (`children["*"]`, MX decision 147), so its head is a reference and not a tag
 * of the vocabulary, with the options given and no child. Inline, so it takes no `analyze` hook (MX refuses one on a
 * wildcard entry) and the wrapper at the end of this file never reaches it: the builder refuses tag parameters on the line.
 * Works only with `bindingsCallTags: false` (`dialect.ts`): a name an import binds is otherwise a component call, which
 * the wildcard may not claim.
 */
export const listing = (attributes: Record<string, CustomTagAttribute> = {}) => ({
  pattern: REFERENCE_HEAD,
  attributes,
  attributeTags: {},
  children: {},
});
const get = (call: TagCall, name: string) =>
  call.attrs.find((a) => a.kind !== "spread" && a.name === name);
interface Node {
  type: string;
  name?: string;
  value?: unknown;
  extra?: { mxTransaction?: unknown };
  elements?: (Node | null)[];
}
const node = (a: Attr | undefined): Node | undefined =>
  a && (a.kind === "dynamic" || a.kind === "bound")
    ? (a.value.node as Node | undefined)
    : undefined;
/**
 * The forwards of an option's members: the `self.name` each `mesh:Member` node lowers to, listed in `Expr.nodes`
 * (MX 0.1.0-alpha.34, IR version 7). A member is found by its forward's identity; core sets no mark on it.
 */
const membersOf = (a: Attr | undefined): ReadonlySet<unknown> =>
  new Set(
    a && (a.kind === "dynamic" || a.kind === "bound")
      ? (a.value.nodes ?? []).filter((each) => each.type === "mesh:Member").map((each) => each.forward)
      : [],
  );
/** The forwards of an option's atoms, found the same way: an atom's forward is a string node, as a written string is. */
const atomsOf = (a: Attr | undefined): ReadonlySet<unknown> =>
  new Set(
    a && (a.kind === "dynamic" || a.kind === "bound")
      ? (a.value.nodes ?? []).filter((each) => each.type === "mesh:Atom").map((each) => each.forward)
      : [],
  );
/** `&a`, `&a.b`, `&a.b.c`: plain property accesses from one member. */
const isMemberPath = (n: Node | null | undefined, members: ReadonlySet<unknown>): boolean => {
  let cursor = n as (Node & { object?: Node; property?: Node; computed?: boolean }) | null | undefined;
  while (cursor && !members.has(cursor)) {
    if (cursor.type !== "MemberExpression" || cursor.computed || cursor.property?.type !== "Identifier") return false;
    cursor = cursor.object;
  }
  return !!cursor;
};
/** An identifier that stands for itself: not the stand-in of the `%.x` mark (a member's forward is a `MemberExpression`, an atom's a string literal). */
const isPlainIdentifier = (n: Node | null | undefined) =>
  n?.type === "Identifier" && !n.extra?.mxTransaction;
/**
 * A reference to another file's declaration: an imported identifier (`List`), or a member of a namespace import
 * (`billing.Invoice`), one plain property access on an identifier. Which import it is, and what that file declares, is
 * Mesh's to resolve (`front-end/references.ts`). MX lowers `(List)`, `List!`, `List as T`, `List satisfies T` and
 * `<T>List` to `List`, so the node shows no wrapper: `isWrapped` finds one from the option's spans instead. A member
 * (`&list`) lowers to the forward `self.list`, which has the same shape as `billing.Invoice`: it is told apart by
 * identity (`membersOf`), since core sets no mark on it, and is no reference.
 */
const isReference = (a: Attr | undefined): boolean => isReferenceNode(node(a), membersOf(a));
/** `isReference` for one node of an option, an item of a list, with the option's members (`membersOf`). */
const isReferenceNode = (n: Node | null | undefined, members: ReadonlySet<unknown>): boolean => {
  if (isPlainIdentifier(n)) return true;
  const access = n as (Node & { object?: Node; property?: Node; computed?: boolean }) | null | undefined;
  return access?.type === "MemberExpression" && !access.computed && !access.extra?.mxTransaction
    && !members.has(access) && isPlainIdentifier(access.object) && isPlainIdentifier(access.property);
};
/**
 * A dynamic option whose value is written inside a wrapper, `(x)`, `x!`, `x as T`, `x satisfies T` or `<T>x` (nested ones
 * too): MX strips the wrapper from `value`, and keeps the value as written in `valueSpan` (MX 0.1.0-alpha.28, IR version
 * 5), so the two spans differ exactly when a wrapper was written. Whitespace and comments around a plain value are in
 * neither span.
 */
const isWrapped = (a: Attr | undefined): a is Extract<Attr, { kind: "dynamic" }> & { valueSpan: SourceSpan } =>
  a?.kind === "dynamic" && !!a.valueSpan && !!a.value.span
  && (a.valueSpan.sourceStart !== a.value.span.sourceStart || a.valueSpan.sourceEnd !== a.value.span.sourceEnd);
/** A slot that holds one member only: a `mesh:Member` node (`syntax/member.ts`), after a kind or as a whole value.
 * Core refuses any other typed value; `checkMemberSlots` refuses an expression that is not exactly one member; Mesh
 * resolves membership. */
const member = (required = false): CustomTagAttribute => ({
  type: "mesh:Member",
  required,
});
/** A list of members (`actions=[&publish]`): a node type takes one value, so a list is an array whose elements
 * `references` checks are members. */
const members = (): CustomTagAttribute => ({ type: "array" });
function references(lists: string[]): NonNullable<CustomTag["analyze"]> {
  return (calls, ctx) => {
    for (const call of calls) {
      for (const key of lists) {
        const a = get(call, key);
        if (!a) continue;
        const n = node(a);
        const found = membersOf(a);
        if (n?.type !== "ArrayExpression" || !n.elements?.every((e) => found.has(e)))
          ctx.report(`\`${key}\` requires a list of member references`, { at: a.loc, code: "MESH_MEMBER_REFERENCE" });
        // As `types=[]`: an empty list names no action, so what it scopes would cover none.
        else if (!n.elements.length)
          ctx.report(`\`${key}\` must name at least one action: an empty list covers none`, { at: a.loc, code: "MESH_MEMBER_REFERENCE" });
      }
    }
  };
}
const scope = () => ({
  types: atomList({ values: [...ACTION_TYPES] }),
  actions: members(),
});
const options = (type: string) => ({
  nullable: flag(),
  default: { literalOnly: true },
  ...(type === "enum" ? { values: valueAtom() } : {}),
  ...(["string", "integer", "float", "decimal"].includes(type) ? { min: number(), max: number() } : {}),
  ...(type === "string" ? { match: { type: "expression" as const } } : {}),
  // What a broken `min`, `max` or `match` of this line reports instead of Mesh's standard message and code: text only.
  // The builder refuses either on a line with none of the three (`checkRuleText` in `build.ts`).
  ...(["string", "integer", "float", "decimal"].includes(type) ? { message: text(), code: text() } : {}),
});
const steps = children("set", "when", "load", "run", "publish", "lock", "relate");
const body = { validate: {}, do: {} };
/** The action types that take `validate` and `do`. A read writes nothing, so it has no step to run and no write for a check to guard: its contract leaves both out, and either under a read is `MESH_TAG_NOT_ALLOWED`. */
const WRITE_TYPES = ACTION_TYPES.filter((type) => type !== "read");
// The `member` child MX lowers a tagless `&name` line to (`MESH_DIALECT`). An
// inline wildcard contract, so no `member` tag is authorable at large; under
// input/set the builder still refuses an authored `member name="x"`.
const memberLine = (attributes: Record<string, CustomTagAttribute>) => ({
  pattern: "member",
  attributes: { name: { type: "string", required: true } as CustomTagAttribute, ...attributes },
  attributeTags: {},
  children: {},
});

/**
 * The options that hold a reference to an entity (`entity=List`, `entity=billing.Invoice`): each must be the reference,
 * written bare. `entity` is required, and every other option is checked only when written. One hook for the relationship
 * kinds and an aggregate's `root`, so each says the same thing about the same mistake.
 */
function entityReference(options: readonly string[]): NonNullable<CustomTag["analyze"]> {
  return (calls, ctx) => {
    for (const call of calls) {
      for (const option of options) {
        const a = get(call, option);
        if (!a && option !== "entity") continue;
        if (!isReference(a))
          ctx.report(`${option} must be an imported identifier (\`List\`) or a member of a namespace import (\`billing.Invoice\`)`, { at: a?.loc, code: "MESH_ENTITY_REFERENCE" });
        // a reference is written bare; `(List)`, `List!`, `List as T`, `List satisfies T` and `<T>List` are refused at
        // the value as written (lead, SYN-21). One error per value: a wrapped value that is no reference either (`(getList())`) keeps the
        // error above alone, which says what to write.
        else if (isWrapped(a))
          ctx.report(`${option} must be the reference alone, with no parentheses, \`!\`, \`as\`, \`satisfies\` or \`<T>\` around it (\`${option}=List\`, \`${option}=billing.Invoice\`)`, { at: a.valueSpan, code: "MESH_ENTITY_REFERENCE" });
      }
    }
  };
}

/**
 * `fields=[:title, :state]` or `fields=:all` on an `expose` line (`notes/spec/other-file-kinds.md`, "Surface files"). MX's
 * contract takes one type per option, so the slot is left open, as `check`'s `message` is, and this hook refuses what is
 * neither: the shape of the list (not a list, empty, repeated) is `MESH_ATOM_LIST` at the option, and an item that is no
 * atom is `MESH_OPTION_VALUE` at the item, in the words `checkAtomSlots` uses for `auto=[read]` (`itemNotAtom`).
 */
function exposedFields(calls: readonly TagCall[], ctx: Parameters<NonNullable<CustomTag["analyze"]>>[1]) {
  for (const call of calls) {
    const a = get(call, "fields");
    if (!a) continue;
    if (a.kind === "static" && a.node?.type === "mesh:Atom") {
      if (a.value !== "all")
        ctx.report(`fields takes a list of atoms (\`fields=[:${String(a.value)}]\`) or \`:all\` for every field`, { at: a.loc, code: "MESH_ATOM_LIST" });
      continue;
    }
    const n = node(a);
    if (n?.type !== "ArrayExpression") {
      ctx.report("fields must be a list of atoms (`fields=[:title, :state]`) or `:all`", { at: a.loc, code: "MESH_ATOM_LIST" });
      continue;
    }
    const atoms = atomsOf(a);
    const elements = n.elements ?? [];
    const bad = elements.findIndex((e) => !(e && atoms.has(e)));
    if (bad >= 0) {
      const item = elements[bad] as (Node & { start?: number | null; end?: number | null }) | null | undefined;
      // An empty item (`[:a, , :b]`) has no place of its own: the option is where it is.
      const at = typeof item?.start === "number" && typeof item.end === "number" ? { sourceStart: item.start, sourceEnd: item.end } : a.loc;
      ctx.report(itemNotAtom("fields", bad, item ?? null), { at, code: "MESH_OPTION_VALUE" });
      continue;
    }
    const names = elements.map((e) => String(e!.value));
    if (!names.length || new Set(names).size !== names.length)
      ctx.report("fields must be non-empty with no repeated values", { at: a.loc, code: "MESH_ATOM_LIST" });
  }
}

/**
 * The sections an entity holds that a mixin may hold too (`notes/spec/other-file-kinds.md`, "Mixin files": every section
 * an entity holds, except `events` and `commands`). The builder reads these kinds from a used mixin's lines
 * (`front-end/build.ts`); `events`, `commands` and `use` are left out of the mixin's children on purpose.
 */
export const MIXIN_SECTIONS = ["attributes", "relationships", "computed", "checks", "actions", "policies", "handlers"] as const;

const contracts: ContractMap = {
  entity: closed({
    parents: ["#root"],
    attributes: { ...named(), table: text() },
    children: {
      attributes: {},
      relationships: {},
      computed: {},
      checks: {},
      actions: {},
      policies: {},
      events: {},
      commands: {},
      handlers: {},
      // One line per mixin the entity includes (`notes/spec/entity.md`, "`use`: including a mixin").
      use: { repeatable: true },
    },
  }),
  // A mixin file's root (`notes/spec/other-file-kinds.md`, "Mixin files"): a block of sections that entities include with
  // `use mixin=Name`, taking only its name. `events` and `commands` are left out of its children on purpose (the spec's
  // `MESH_TAG_NOT_ALLOWED`), and so is `use` (a mixin includes no mixin).
  mixin: closed({
    parents: ["#root"],
    attributes: named(),
    children: Object.fromEntries(MIXIN_SECTIONS.map((name) => [name, {}])),
  }),
  // An owner's events and commands (`notes/spec/events-and-commands.md`, "Where a declaration lives"): inline declarations
  // (`event :InvoiceVoided` with its field lines) and listing lines of the events or commands an import of the file names
  // (`InvoicePaid`, `notices.InvoiceOverdue`), side by side. The owner check reads them: an event that owners list or
  // declare is published only by its owners' actions.
  events: closed({
    parents: ["entity", "aggregate"],
    children: { ...children("event"), "*": listing() },
  }),
  commands: closed({
    parents: ["entity", "aggregate"],
    children: { ...children("command"), "*": listing() },
  }),
  // An aggregate file (`notes/spec/other-file-kinds.md`, "Aggregate files"; ADR-0080): its root entity, its parts and the
  // events and commands it owns. No option but the name; nothing is generated from it.
  aggregate: closed({
    parents: ["#root"],
    attributes: named(),
    children: { root: { required: true }, entities: {}, events: {}, commands: {}, handlers: {} },
  }),
  // The lines that consume events (`notes/spec/events-and-commands.md`, "Where a declaration lives"): one per handler, of
  // core's two kinds, `process` and `listen`. `project` is the event-sourcing extension's kind, not core's.
  handlers: closed({ parents: ["entity", "aggregate", "mixin"], children: children("process", "listen") }),
  // `root entity=Task`: the aggregate's root entity, a reference written bare as `belongs-to`'s `entity=` is.
  root: closed({
    parents: ["aggregate"],
    attributes: { entity: { type: "expression", required: true } },
    analyze: entityReference(["entity"]),
  }),
  // One part per line, its head the part entity's reference (`Dependency`, `talk.Comment`); `prop=:name` picks the part's
  // `belongs-to` to the root when it has more than one.
  entities: closed({
    parents: ["aggregate"],
    children: { "*": listing({ prop: atom() }) },
  }),
  // An event and a command are files of their own (M6), or declared inline in an owner's section: the line declares one,
  // and its children are field lines, written as attribute lines are (`uuid :invoiceId`). The field kinds are the
  // attribute types, whose contracts list these two as parents (the two are field parents, `fieldParent`); `default`, `unique`, `primary-key`, `on` and `value`
  // are not options of a field, which the builder reports as `MESH_UNKNOWN_OPTION` (a contract is per tag, so it cannot
  // tell a field from an attribute).
  event: fieldParent({
    parents: ["#root", "events"],
    attributes: named(),
  }),
  command: fieldParent({
    parents: ["#root", "commands"],
    attributes: named(),
  }),
  attributes: fieldParent({
    parents: ["entity", "mixin"],
  }),
  // A concept file (`notes/spec/other-file-kinds.md`, "Concept files"; ADR-0080): `concept :Money`, then one field line
  // per field, written as an event's. The root takes only the name. MX finds the file in a `concepts` folder and turns
  // it into the contract of a concept use through the dialect's `tagFile` hook (`concept-file.ts`).
  concept: fieldParent({
    parents: ["#root"],
    attributes: named(),
  }),
  // The architecture file (`notes/spec/other-file-kinds.md`, "The architecture file"; ruling D40): one per project,
  // directly in the domain root, holding only its three kinds of line, none of which takes a child.
  architecture: closed({
    parents: ["#root"],
    attributes: named(),
    children: children("use", "severity", "disable"),
  }),
  // `use` includes what its parent includes: a preset in the architecture file (`use preset=MeshRecommended`), a mixin in an
  // entity file (`use mixin=Timestamps`, `use mixin=shared.Audited`). A contract is per tag and an `analyze` hook sees no
  // parent, so both options are optional here and `checkUseOptions` (`syntax/use-options.ts`) requires the parent's option
  // and refuses the other one; the hook checks the shape of what is written: a reference, written bare.
  use: closed({
    parents: ["architecture", "entity"],
    attributes: { preset: { type: "expression" }, mixin: { type: "expression" } },
    analyze(calls, ctx) {
      for (const call of calls) {
        const preset = get(call, "preset");
        if (preset) {
          if (!isReference(preset))
            ctx.report("preset must be an imported preset (`preset=MeshRecommended`)", { at: preset.loc, code: "MESH_OPTION_VALUE" });
          else if (isWrapped(preset))
            ctx.report("preset must be the reference alone, with no parentheses, `!`, `as`, `satisfies` or `<T>` around it (`preset=MeshRecommended`)", { at: preset.valueSpan, code: "MESH_OPTION_VALUE" });
        }
        const mixin = get(call, "mixin");
        if (mixin) {
          if (!isReference(mixin))
            ctx.report("mixin must be an imported mixin (`mixin=Timestamps`) or a member of a namespace import (`mixin=shared.Audited`)", { at: mixin.loc, code: "MESH_OPTION_VALUE" });
          else if (isWrapped(mixin))
            ctx.report("mixin must be the reference alone, with no parentheses, `!`, `as`, `satisfies` or `<T>` around it (`mixin=Timestamps`, `mixin=shared.Audited`)", { at: mixin.valueSpan, code: "MESH_OPTION_VALUE" });
        }
      }
    },
  }),
  // `severity :rule level=:error` re-grades a rule; `disable :rule` switches it off. A rule name may hold hyphens
  // (`:service-touches-one-entity`), and which names are rules is the builder's check (`MESH_UNKNOWN_RULE`), so a
  // misspelt or camelCase name gets the nearest rule's name instead of MX's pattern error.
  severity: closed({
    parents: ["architecture"],
    attributes: { name: ruleName(), level: { type: "mesh:Atom", required: true, values: ["error", "warning"] } },
  }),
  disable: closed({
    parents: ["architecture"],
    attributes: { name: ruleName() },
  }),
  // A surface file (`notes/spec/other-file-kinds.md`, "Surface files"; ADR-0077): one audience's entry point, read from the
  // configured surfaces folder. The root takes only its name; its lines are `expose` lines, each listing the actions of its
  // entity the audience may call, and at most one `publishes` section. No line takes a function: a surface declares no
  // behaviour.
  surface: closed({
    parents: ["#root"],
    attributes: named(),
    children: { expose: { repeatable: true }, publishes: {} },
  }),
  // The events the surface sends out: one listing line per event, an imported identifier or a member of a namespace
  // import (`TaskCompleted`, `billing.InvoicePaid`), never an atom. It raises nothing: the `publish` step does that.
  publishes: closed({
    parents: ["surface"],
    children: { "*": listing() },
  }),
  // `expose :tasks entity=Task label="Tasks" fields=[:title, :state]`: an entity the audience may reach, under the exposed
  // name. `entity=` is a reference written bare, as a relationship's; `fields=` lists what leaves, or `:all`.
  expose: closed({
    parents: ["surface"],
    attributes: {
      ...named(),
      entity: { type: "expression", required: true },
      label: text(),
      fields: {},
    },
    children: children("action"),
    analyze(calls, ctx) {
      entityReference(["entity"])(calls, ctx);
      exposedFields(calls, ctx);
    },
  }),
  // `action :complete`: one of the exposed entity's actions the audience may call, by name.
  action: closed({
    parents: ["expose"],
    attributes: named(),
  }),
  // A domain service (`notes/spec/other-file-kinds.md`, "Services"; services design, section 3.2; ruling D42): a file of
  // its own whose operations span entities. It is stateless by grammar, so it takes none of an entity's data sections
  // (R5): only its operations and the policies that cover them.
  service: closed({
    parents: ["#root"],
    attributes: named(),
    children: { operation: { repeatable: true, required: true }, policies: {} },
  }),
  // One operation of a service: the entities it reaches (`uses`, at least one, OD-9), its input and its body. No `on=`
  // (OD-11), and no `validate`, `do` or `output` (OD-7): the body is the whole operation.
  operation: closed({
    parents: ["service"],
    attributes: named(),
    children: { uses: { repeatable: true, required: true }, input: {}, run: { required: true } },
  }),
  // `uses entity=Task actions=[:complete, :read]` (OD-5): the entity, written as `belongs-to entity=` writes it, and the
  // actions of it the operation may call, by atom. MX's type check refuses a list that is no list (`actions=:read`) and
  // an item that is no atom (`[&x]`, `["read"]`) as `MESH_OPTION_VALUE`, so only the empty list reaches the hook; a
  // repeated atom is the builder's, at the second one.
  uses: closed({
    parents: ["operation"],
    attributes: { entity: { type: "expression", required: true }, actions: { ...atomList(), required: true } },
    analyze(calls, ctx) {
      entityReference(["entity"])(calls, ctx);
      for (const call of calls) {
        const list = get(call, "actions");
        if (list && node(list)?.type === "ArrayExpression" && !node(list)?.elements?.length)
          ctx.report("actions must list at least one action of the entity, as atoms (`actions=[:complete]`)", { at: list.loc, code: "MESH_ATOM_LIST" });
      }
    },
  }),
  relationships: closed({
    parents: ["entity", "mixin"],
    children: children(...RELATIONSHIP_KINDS),
  }),
  computed: closed({
    parents: ["entity", "mixin"],
    children: children(...ATTRIBUTE_TYPES, ...ROLLUPS),
  }),
  actions: closed({
    parents: ["entity", "mixin"],
    attributes: {
      auto: atomList({ values: [...ACTION_TYPES] }),
      "on:load": member(),
      // The largest `limit` a caller read of this entity takes, and what it reads when the caller gives none.
      "max-limit": number(),
    },
    children: children(...ACTION_TYPES, "always"),
  }),
  always: closed({
    parents: ["actions"],
    attributes: scope(),
    children: body,
    analyze(calls, ctx) {
      references(["actions"])(calls, ctx);
      // A read runs neither `validate` nor `do`, so a block scoped to reads never applies: the `:read` item is the error,
      // at its own span (`Expr.nodes`), since the model keeps no position for a `types` item. `policy` shares `scope()`
      // and keeps `:read`; an `actions=` reference that names a read is the build's (`model/lifecycle-limits.ts`).
      for (const call of calls) {
        const a = get(call, "types");
        const read = a && (a.kind === "dynamic" || a.kind === "bound")
          ? (a.value.nodes ?? []).find((each) => each.type === "mesh:Atom" && (each.forward as Node).value === "read")
          : undefined;
        if (read)
          ctx.report("`types=` lists `:read`, and a read runs neither `validate` nor `do`, so an always block never applies to it; remove `:read`", { at: read.span, code: "MESH_OPTION_VALUE" });
      }
    },
  }),
  input: closed({
    parents: [...ACTION_TYPES, "operation"],
    children: {
      ...children(...ATTRIBUTE_TYPES),
      "*": memberLine({}),
    },
  }),
  validate: closed({
    parents: [...WRITE_TYPES, "always"],
    // `publish` is no `validate` line: the contract admits it where it is written wrongly, so that the build says why
    // (`MESH_PUBLISH`, `front-end/build.ts`) instead of calling it an unknown tag. A `when` line nests checks under a condition.
    children: children("check", "when", "publish"),
  }),
  // The entity's named checks: each line declares one, which a `validate` block uses with `check &name`.
  checks: closed({ parents: ["entity", "mixin"], children: children("check") }),
  check: closed({
    parents: ["validate", "when", "checks"],
    children: children("publish"),
    attributes: {
      // A line declares a check (`:name`, `that`, `code`, `message`) or uses one (`&name` alone). Nothing is required here:
      // the builder says what each form needs, line by line (`declaredCheck` and `checks` in `front-end/build.ts`), since a
      // contract cannot say "required unless `member` is written".
      name: atom(),
      member: member(),
      that: fn(),
      code: text(),
      // Text, or a function of the arguments `that` gets: the contract leaves the type open, `check` in the builder tells them apart.
      message: {},
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
        const s = a as { kind: string; value?: unknown; node?: unknown };
        if (s.kind === "static" && typeof s.value === "string" && !s.node) {
          if (!s.value.trim()) ctx.report("message cannot be empty", { at: a.loc, code: "MESH_TEXT" });
          continue;
        }
        ctx.report("message is text (`message=\"the order is empty\"`) or a function (`message=({ self }) => ...`)", { at: a.loc, code: "MESH_OPTION_VALUE" });
      }
    },
  }),
  do: closed({ parents: [...WRITE_TYPES, "always"], children: steps }),
  set: closed({
    parents: ["do", "when"],
    children: {
      // `value` takes whatever was written (`&done=true`, `&status=:sent`,
      // `&title=""`, an expression); the builder requires it and type-checks it.
      "*": memberLine({ value: {} }),
    },
  }),
  // One contract serves the step `when` under `do` and the `when` line under `validate`, so its child list is the union of
  // both: the builder refuses a step under a `when` in `validate` and a `check` under one in `do` (`front-end/build.ts`).
  // `check` is not added to `steps`, which `do` uses too: `do > check` stays MX's error.
  when: closed({
    parents: ["do", "when", "validate"],
    attributes: { value: fn(true) },
    children: { ...steps, ...children("check") },
  }),
  load: closed({
    parents: ["do", "when"],
    attributes: { value: { ...members(), required: true } },
    analyze: references(["value"]),
  }),
  run: closed({
    // Under an `operation`, the operation's body; the builder refuses `after=` there, since an operation writes no row.
    parents: ["do", "when", "operation"],
    // `after=:write` moves the step after the action's own row is written (ADR-0068 decision 2).
    attributes: { value: fn(true), after: { type: "mesh:Atom", values: ["write"] } },
  }),
  // `publish=() => new InvoicePaid({ ... })` raises an event (M6, `notes/spec/events-and-commands.md`, "Publishing"): the
  // function's value is the event's instance. It is a step of `do`, and of a `when` in one; `validate` and a `check` take
  // it only to refuse it, `MESH_PUBLISH`. The value is untyped here so that a value that is no function is `MESH_PUBLISH`
  // alone, from the hook below, and not also `MESH_EXPRESSION`.
  publish: closed({
    parents: ["do", "when", "validate", "check"],
    attributes: { value: { required: true } },
    analyze(calls, ctx) {
      for (const call of calls) {
        const a = get(call, "value");
        if (!a) continue;
        const type = node(a)?.type;
        if (type !== "ArrowFunctionExpression" && type !== "FunctionExpression")
          ctx.report("this value is no function: a `publish` raises the event its function returns, as in `publish=() => new InvoicePaid({ ... })`", { at: a.loc, code: "MESH_PUBLISH" });
      }
    },
  }),
  // `lock &version`: an optimistic lock (ADR-0100). The member is the whole line; a value after it is MX's `MESH_SYNTAX`,
  // and `optional` lets a call leave the version out. Under a step `when` the builder refuses it (`MESH_LOCK_STEP`).
  lock: closed({
    parents: ["do", "when"],
    attributes: { member: member(true), optional: flag() },
  }),
  // `relate &tracks create=:add update=:rename destroy=:remove`: the rows of a has-many from the caller's list (ADR-0100).
  // Each option names an action of the target entity; the builder requires at least one and refuses one under a step
  // `when` or in an `always` block (`MESH_RELATE_STEP`), and `checkLockRelate` resolves the names.
  relate: closed({
    parents: ["do", "when"],
    attributes: { member: member(true), create: atom(), update: atom(), destroy: atom() },
  }),
  filter: closed({ parents: ["read"], attributes: { value: fn(true) } }),
  sort: closed({ parents: ["read"], children: children("asc", "desc") }),
  policies: closed({ parents: ["entity", "service", "mixin"], children: children("policy") }),
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
    parents: ["attributes", "input", "computed", "event", "command", "concept"],
    attributes: {
      ...named(),
      ...options(type),
      // Command fields only; the dialect's afterLower hook checks the authored parent.
      optional: flag(),
      ...(["uuid", "integer", "string"].includes(type) ? { "primary-key": flag() } : {}),
      // A json value is opaque to the database, so it cannot be unique (ADR-0069).
      ...(type === "json" ? {} : { unique: flag() }),
      ...(type === "timestamp" ? { on: { type: "mesh:Atom" as const, values: ["create", "update"] } } : {}),
      value: fn(),
    },
    analyze(calls, ctx) {
      for (const call of calls) {
        const match = get(call, "match");
        if (match && node(match)?.type !== "RegExpLiteral")
          ctx.report("match must be a regular expression", { at: match.loc, code: "MESH_ATTRIBUTE_RULE" });
        const values = get(call, "values");
        if (values && node(values)?.type !== "ArrayExpression")
          ctx.report("values must be a list of atoms", { at: values.loc, code: "MESH_ENUM_VALUES" });
      }
    },
  });
for (const kind of RELATIONSHIP_KINDS)
  contracts[kind] = closed({
    parents: ["relationships"],
    attributes: {
      ...named(),
      entity: { type: "expression", required: true },
      ...(kind === "belongs-to" ? { nullable: flag() } : {}),
      // The other entity's belongs-to this follows (ADR-0070); with `through`, the link entity's.
      ...(kind === "has-many" ? { inverse: atom(), through: { type: "expression" as const } } : {}),
    },
    // `through=` is a reference like `entity=`, checked the same way.
    analyze: entityReference(kind === "has-many" ? ["entity", "through"] : ["entity"]),
  });
/**
 * `on=` answers a command (`notes/spec/events-and-commands.md`, "Answering a command"): the command's imported identifier
 * (`on=PayInvoice`) or a member of a namespace import (`on=billing.PayInvoice`). Every shape that is not that is
 * `MESH_UNKNOWN_COMMAND`, as the spec has it for an `on=` that names anything but an imported command; which import it is
 * and what that file declares is the build's to resolve. A `read` has no `on=`, so MX refuses it there, and the name is
 * optional on the other three (a command names the action), with neither a `MESH_NAME`.
 */
function answers(calls: readonly TagCall[], ctx: Parameters<NonNullable<CustomTag["analyze"]>>[1]) {
  for (const call of calls) {
    const a = get(call, "on");
    if (!a && !get(call, "name"))
      ctx.report(`an action needs a name or \`on=\`: write \`${call.name} :name\`, or \`${call.name} on=PayInvoice\` to take the name from the command`, { at: call.loc, code: "MESH_NAME" });
    if (!a) continue;
    if (!isReference(a))
      ctx.report("on must be an imported command (`on=PayInvoice`) or a member of a namespace import (`on=billing.PayInvoice`)", { at: a.loc, code: "MESH_UNKNOWN_COMMAND" });
    else if (isWrapped(a))
      ctx.report("on must be the reference alone, with no parentheses, `!`, `as`, `satisfies` or `<T>` around it (`on=PayInvoice`, `on=billing.PayInvoice`)", { at: a.valueSpan, code: "MESH_UNKNOWN_COMMAND" });
  }
}
/** A read answers no command (`on=` is no option of it), so a read line with no name has nothing to be named after: `MESH_NAME`, as for the other three. */
function namedRead(calls: readonly TagCall[], ctx: Parameters<NonNullable<CustomTag["analyze"]>>[1]) {
  for (const call of calls)
    if (!get(call, "name"))
      ctx.report("an action needs a name: write `read :name`; `actions auto=[:read]` generates the plain read", { at: call.loc, code: "MESH_NAME" });
}
for (const kind of ACTION_TYPES)
  contracts[kind] = closed({
    parents: ["actions"],
    // The name is optional in every contract so that a line without one is `MESH_NAME` from the hook, not MX's `MESH_MISSING_OPTION`.
    attributes: kind === "read"
      ? { name: atom(), filter: fn() }
      : { name: atom(), on: { type: "expression" } },
    analyze: kind === "read" ? namedRead : answers,
    children: {
      input: {},
      ...(kind === "read" ? { filter: {}, sort: {} } : body),
    },
  });
/**
 * A rollup's `filter=` takes exactly one parameter, a plain identifier: the record the path reaches (`(line) => ...`,
 * ruling D33, OD6). Two parameters or more is `MESH_EXPRESSION`, the catalogue's form for a function with a second
 * parameter; no parameter, a pattern (`({ self })`), a rest element or a default value is `MESH_ROLLUP_FILTER`, at the
 * parameter list. That the value is a function as written is the universal check's (`MESH_EXPRESSION`).
 */
function rollupFilterParameter(call: TagCall, ctx: Parameters<NonNullable<CustomTag["analyze"]>>[1]) {
  const a = get(call, "filter");
  const fn = node(a) as (Node & { params?: (Node & { start?: number; end?: number })[]; start?: number; body?: { start?: number } }) | undefined;
  if (!a || !fn || (fn.type !== "ArrowFunctionExpression" && fn.type !== "FunctionExpression")) return;
  const params = fn.params ?? [];
  const spanOf = (from: { start?: number } | undefined, to: { start?: number; end?: number } | undefined) =>
    typeof from?.start === "number" && typeof (to?.end ?? to?.start) === "number" ? { sourceStart: from.start, sourceEnd: (to!.end ?? to!.start)! } : a.loc;
  if (params.length > 1) {
    ctx.report(`filter takes one parameter, the record the path reaches, and this function has ${params.length}`, { at: spanOf(params[1], params.at(-1)), code: "MESH_EXPRESSION" });
    return;
  }
  const param = params[0];
  if (param?.type !== "Identifier")
    ctx.report(`filter takes one parameter, the record the path reaches: write filter=(<name>) => ...`, { at: param ? spanOf(param, param) : spanOf(fn, fn.body), code: "MESH_ROLLUP_FILTER" });
  // A scope root's name would stand for the record and for the root at once (`&x` is a member of `self`).
  else if (SCOPE_ROOTS.has(param.name!))
    ctx.report(`filter's parameter is the record the path reaches, and \`${param.name}\` is a scope name: call it after the record, filter=(line) => ...`, { at: spanOf(param, param), code: "MESH_ROLLUP_FILTER" });
}
/** The scope roots of a function in an entity file (`SCOPE_NAMES` in `expression.ts`, which this file does not import). */
const SCOPE_ROOTS: ReadonlySet<string> = new Set(["self", "input", "actor", "context", "before"]);
for (const kind of ROLLUPS)
  contracts[kind] = closed({
    parents: ["computed"],
    // `of=&lines.amount`: a member reference, a path of marked members through relationships. The string form is refused with its fix.
    // `filter=(line) => ...`: the condition each record the path reaches last must meet to be aggregated (ruling D33, OD6).
    attributes: { ...named(), of: { required: true }, filter: fn() },
    analyze(calls, ctx) {
      for (const call of calls) {
        rollupFilterParameter(call, ctx);
        const a = get(call, "of");
        if (!a) continue;
        const literal = node(a);
        // An atom is one of the expression's `mesh:Atom` nodes, found by its forward (`Expr.nodes`).
        const atom = (a.kind === "dynamic" || a.kind === "bound") && (a.value.nodes ?? []).some((each) => each.forward === literal);
        const written = a.kind === "static" ? a.value : literal?.type === "StringLiteral" && !atom ? String(literal.value) : undefined;
        if (written !== undefined) {
          const path = /^[A-Za-z_]\w*(\.[A-Za-z_]\w*)*$/.test(written) ? written : undefined;
          ctx.report(
            `of takes a member reference, not a string: ${path ? `write of=&${path}` : "write of=&relationship for a count, of=&relationship.attribute for the others"}`,
            { at: a.loc, code: "MESH_ROLLUP_PATH_STRING" },
          );
        } else if (!isMemberPath(node(a), membersOf(a)))
          ctx.report("of takes a member reference: &relationship for a count, &relationship.attribute for the others", { at: a.loc, code: "MESH_ROLLUP_PATH" });
      }
    },
  });
for (const kind of ["asc", "desc"])
  contracts[kind] = closed({
    parents: ["sort"],
    attributes: { member: member(true) },
  });
/** What an `on=` of a handler line takes, for the shape messages of `handles`. */
const HANDLES_SHAPE = "on must be an event in scope (`on=InvoicePaid`), a member of a namespace import (`on=billing.InvoicePaid`), or a list of them (`on=[InvoicePaid, billing.PaymentRecorded]`)";
const HANDLES_WRAPPED = "on must be the reference alone, with no parentheses, `!`, `as`, `satisfies` or `<T>` around it (`on=InvoicePaid`, `on=billing.InvoicePaid`)";
/** Comments, which a list may hold between its items: they are no wrapper. */
const COMMENTS = /\/\/[^\n]*|\/\*[\s\S]*?\*\//g;
type Item = Node & { start?: number; end?: number; object?: Node; property?: Node };
/**
 * A handler line names the events it takes in `on=`: one reference, or a non-empty list of references, each written bare
 * (`notes/architecture/handlers-design.md`, rule H7). Which import each is, and whether it is an event, is the build's to
 * resolve. MX strips a wrapper inside a list item as it does around a whole value, and keeps no span of the item as
 * written, so an item's wrapper is found in the list's written text (`value.code`, whose offsets are the source's less
 * `value.span.sourceStart`): the text between two items, comments aside, is one comma and whitespace, and the text after
 * the last is whitespace and at most one comma. A wrapper written before an item is that item's; one after it (`!`,
 * `as T`) is the item before the comma. A line reports its first bad item only: one error per option.
 */
function handles(calls: readonly TagCall[], ctx: Parameters<NonNullable<CustomTag["analyze"]>>[1]) {
  for (const call of calls) {
    const a = get(call, "on");
    if (!a) continue; // MX reports the missing required option
    const n = node(a);
    if (n?.type !== "ArrayExpression") {
      if (!isReference(a)) ctx.report(HANDLES_SHAPE, { at: a.loc, code: "MESH_UNKNOWN_EVENT" });
      else if (isWrapped(a)) ctx.report(HANDLES_WRAPPED, { at: a.valueSpan, code: "MESH_UNKNOWN_EVENT" });
      continue;
    }
    // A wrapper around the whole list (`([A])`, `[A] as any`) is MX's to strip, as around one reference: the written value
    // (`valueSpan`) then differs from the lowered one.
    if (isWrapped(a)) {
      ctx.report(HANDLES_WRAPPED, { at: a.valueSpan, code: "MESH_UNKNOWN_EVENT" });
      continue;
    }
    const items = (n.elements ?? []) as (Item | null)[];
    if (items.length === 0) {
      ctx.report("on must list at least one event: `on=[InvoicePaid]`", { at: a.loc, code: "MESH_UNKNOWN_EVENT" });
      continue;
    }
    const members = membersOf(a);
    const spanOf = (item: Item | null | undefined) =>
      item && typeof item.start === "number" && typeof item.end === "number" ? { sourceStart: item.start, sourceEnd: item.end } : a.loc;
    // A hole (`[A, , B]`) has no node, and is no reference.
    const bad = items.find((item) => !item || !isReferenceNode(item, members));
    if (bad !== undefined) {
      ctx.report(HANDLES_SHAPE, { at: spanOf(bad), code: "MESH_UNKNOWN_EVENT" });
      continue;
    }
    const value = (a as Extract<Attr, { kind: "dynamic" }>).value;
    const base = value.span?.sourceStart;
    const code = value.code;
    if (base === undefined || typeof code !== "string") continue;
    const written = (item: Item) => code.slice(item.start! - base, item.end! - base);
    // The written text of an item must be the item: the trigger splices of `Expr.code` would shift what follows them,
    // and then no gap is read (a list of references holds none, so this never skips a real list).
    const named = (item: Item) => item.type === "Identifier" ? item.name : `${item.object?.name}.${item.property?.name}`;
    if (!(items as Item[]).every((item) => typeof item.start === "number" && typeof item.end === "number"
      && written(item).replace(COMMENTS, "").replace(/\s+/g, "") === named(item))) continue;
    const list = items as Item[];
    const open = code.indexOf("[");
    const close = code.lastIndexOf("]");
    for (let index = 0; index <= list.length; index++) {
      const from = index === 0 ? open + 1 : list[index - 1]!.end! - base;
      const to = index === list.length ? close : list[index]!.start! - base;
      const gap = code.slice(from, to).replace(COMMENTS, " ");
      const comma = gap.indexOf(",");
      const head = comma === -1 ? gap : gap.slice(0, comma);
      const tail = comma === -1 ? "" : gap.slice(comma + 1);
      // Before the first item there is no comma; between two there is one; after the last there is at most one.
      const wrappedBefore = index > 0 && head.trim() !== "";
      const wrappedAfter = index === 0 ? gap.trim() !== "" : index < list.length ? comma === -1 || tail.trim() !== "" : tail.trim() !== "";
      if (wrappedBefore) { ctx.report(HANDLES_WRAPPED, { at: spanOf(list[index - 1]), code: "MESH_UNKNOWN_EVENT" }); break; }
      if (wrappedAfter) { ctx.report(HANDLES_WRAPPED, { at: spanOf(list[Math.min(index, list.length - 1)]), code: "MESH_UNKNOWN_EVENT" }); break; }
    }
  }
}
for (const kind of ["process", "listen"] as const)
  contracts[kind] = closed({
    parents: ["handlers"],
    attributes: {
      // Required: a line with no name is MX's `MESH_MISSING_OPTION`, as for every declaration but an action (errors.md §12).
      name: atom(true),
      // One event reference or a list of them: `handles` checks the shape, the builder resolves each.
      on: { type: "expression", required: true },
      // The body: the line's default option, so `process :x [on=E] async ({ event }) { ... }` and `listen :x [on=E] =(...) => ...` set it.
      value: fn(true),
      // A former name of this handler in the same owner: its progress row moves to this one.
      "renamed-from": atom(),
    },
    analyze: handles,
  });
/**
 * The messages of the universal checks below. `params` is shared with the build's check of a concept use (`conceptUses`
 * in `build.ts`): a tag file's contract carries no `analyze` hook, and the dialect's `afterLower` sees no call's tag
 * parameters, so the build makes that check there, in the same words.
 */
export const SYNTAX_MESSAGES = Object.freeze({
  params: "tag parameters and variable bindings are not entity declarations",
  bound: "bound options are not entity declarations",
  name: "a declaration needs one atom name",
});
// E1's function/array checks accept dynamic unknowns by design. This static
// dialect requires the written shape, not a runtime value of a compatible type.
//
// Every check reports through `ctx.report` (MX 0.1.0-alpha.38, `@unstable`), which does not end the hook, so a file
// shows every bad line of a tag, not only the first (`ctx.fail` throws). One error per option: once an option is
// reported, the next option is checked. The tag's own hook then sees each call without the options reported here, so it
// does not report the same option again in other words (`values=x`: `MESH_ATOM_LIST` here, `MESH_ENUM_VALUES` there),
// and still checks the line's other options (`string :b value=x match=y` reports both). Two exceptions: a call with tag
// parameters or a variable binding is not handed on at all, since none of its options is a declaration; and a reported
// `name=` stays on the call, since the hooks only test that a name is present (`answers`, `namedRead`) and would
// otherwise report the same name as missing.
for (const contract of Object.values(contracts)) {
  const analyze = contract.analyze;
  contract.analyze = (calls, ctx) => {
    const clean: TagCall[] = [];
    for (const call of calls) {
      if (call.params.length || call.var) {
        ctx.report(SYNTAX_MESSAGES.params, { at: call.loc, code: "MESH_SYNTAX" });
        continue;
      }
      const reported = new Set<Attr>();
      for (const [key, declaration] of Object.entries(
        contract.attributes ?? {},
      )) {
        const a = get(call, key);
        if (!a) continue;
        if (a.kind === "bound") {
          ctx.report(SYNTAX_MESSAGES.bound, { at: a.loc, code: "MESH_SYNTAX" });
          reported.add(a);
          continue;
        }
        const n = node(a);
        if (
          declaration.type === "function" &&
          !["ArrowFunctionExpression", "FunctionExpression"].includes(
            n?.type ?? "",
          )
        ) {
          ctx.report(`${key} must be a function as written`, { at: a.loc, code: "MESH_EXPRESSION" });
          reported.add(a);
          continue;
        }
        if (
          key === "name" &&
          declaration.type === "mesh:Atom" &&
          !(a.kind === "static" && a.node?.type === "mesh:Atom")
        ) {
          ctx.report(SYNTAX_MESSAGES.name, { at: a.loc, code: "MESH_NAME" });
          reported.add(a);
          continue;
        }
        if (["auto", "types", "values"].includes(key)) {
          if (n?.type !== "ArrayExpression") {
            ctx.report(`${key} must be a list of atoms`, { at: a.loc, code: "MESH_ATOM_LIST" });
            reported.add(a);
            continue;
          }
          // Only atoms can repeat: an item that is none (`values=[a, b]`, `values=[:a, "a"]`) is refused where it is
          // written (`checkAtomSlots`, or core for a string). A string's node has a string `value` too, so an item counts
          // only when it is an atom's forward.
          const atoms = atomsOf(a);
          const names = (n.elements ?? []).flatMap((e) => (e && atoms.has(e) && typeof e.value === "string" ? [e.value] : []));
          if (!n.elements?.length || new Set(names).size !== names.length) {
            ctx.report(`${key} must be non-empty with no repeated values`, { at: a.loc, code: "MESH_ATOM_LIST" });
            reported.add(a);
            continue;
          }
        }
        if (
          declaration.type === "string" &&
          a.kind === "static" &&
          !a.value.trim()
        ) {
          ctx.report(`${key} cannot be empty`, { at: a.loc, code: "MESH_TEXT" });
          reported.add(a);
        }
      }
      clean.push(reported.size
        ? { ...call, attrs: call.attrs.filter((a) => !reported.has(a) || (a.kind !== "spread" && a.name === "name")) }
        : call);
    }
    if (clean.length) analyze?.(clean, ctx);
  };
}
export default contracts;
