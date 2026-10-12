import { dirname, relative } from "node:path";
import type { Action, Always, Atom, Attribute, Check, Entity, Expression, Literal, Policy, SourcePosition, Step } from "@meshfw/model";
import { filledKey } from "../../model/new-instance.ts";
import { policiesCovering, policyExpressions, readsRecord } from "../../model/policies.ts";
import { emitError } from "../emit-error.ts";
import type { EmitInput } from "../emit.ts";
import { expressionIds, policySpecs } from "./expressions.ts";
import { globalAlias, globalsImport, type GlobalsImport } from "./globals.ts";
import { hasLoader, loaderName } from "./load.ts";
import { computedColumns, effectiveActions, entityInputs, entityLocal, entityPath, entitySegment, loadGenerics, propertyName, takesLoad, typeName } from "./inputs.ts";
import { entityFileComment, txLoadTypes } from "./types.ts";

/**
 * What `actions.ts.jig` renders for one entity: `bind<Entity>(layer, options)`, returning one
 * method per action with its whole body written out, phase by phase (roadmap principle 1, ADR-0003), and the entity
 * value (CMP-16): a frozen object with one method per action, `Post.publish(input, context)`, that runs the action on
 * the binding in scope, exported with the record type under the entity's name. Every
 * string is final, statements included; the template prints, loops and branches on
 * these fields and computes nothing. A project's own `actions.ts.jig` depends on this shape.
 */
export interface ActionsView {
  /** The entity file this file is generated from, project-relative, line terminators escaped as `\uXXXX`. */
  readonly entityFile: string;
  /** True when the entity has at least one action; when false the file binds an empty object and its entity value has no method. */
  readonly hasActions: boolean;
  /** The exported binding function, e.g. `bindPost`. */
  readonly bindName: string;
  /**
   * The entity's name as code writes it, e.g. `Post`: the name the entity value and the record type are exported under
   * (one name, a value and a type). The record type is imported from the types file as `$Record` and re-exported under it.
   */
  readonly entityName: string;
  /** The entity's FQN as a quoted string literal, e.g. `"blog.Post"`: what the entity value carries under the runtime's `ENTITY` symbol. */
  readonly fqnLiteral: string;
  /** The read binder the entity value carries, as printed: `readsBindName`, or `null` when the entity has no read action. */
  readonly readsBindValue: string;
  /**
   * Value imports from `@meshfw/runtime` as printed inside `import { ... }`, sorted by name.
   * A class is imported under a `$` alias (`NotFoundError as $NotFoundError`): no entity
   * name becomes a `$` name, so an entity's types can never collide with Mesh's imports.
   */
  readonly runtimeValues: readonly string[];
  /** Type imports from `@meshfw/runtime` beyond `ContextArgument`, `DataLayer` and `BindOptions`, aliased with `$`, e.g. `Issue as $Issue`. */
  readonly runtimeTypes: readonly string[];
  /** Type imports from the types file beyond the record type (`entityName`, imported as `$Record`): each input type and the load types. */
  readonly typeImports: readonly string[];
  /** The types file as a quoted string literal, e.g. `"./post.types"`. */
  readonly typesFromLiteral: string;
  /** Validator constants imported from the validators file, one per action. */
  readonly validatorImports: readonly string[];
  /** The validators file as a quoted string literal, e.g. `"./post.validators"`. */
  readonly validatorsFromLiteral: string;
  /** The adapter's schema file as a quoted string literal, e.g. `"../schema"`. */
  readonly schemaFromLiteral: string;
  /** The entity's expressions file as a quoted string literal, or `null` when it has no expression an action runs. */
  readonly expressionsFromLiteral: string | null;
  /** The scope types the actions read the expressions with, from the expressions file, aliased `$Scope` and `$StoredScope`: `$blog$Post$Scope as $Scope`. */
  readonly scopeImports: readonly string[];
  /** The load file as a quoted string literal, imported for its plan (`loadPlan as $loadPlan`), or `null` when nothing here reads the plan. */
  readonly loadFromLiteral: string | null;
  /** The entity's load function, or `null` when it has no relationship and no computed field. */
  readonly loader: LoadFunction | null;
  /** What `bind<Entity>` names its second parameter: `options`, or `_options` when no action reads it. */
  readonly optionsName: string;
  /**
   * What `bind<Entity>` names its third parameter, the binding's frame (`ActionFrame`): `frame`, or `_frame` when no action
   * uses it. An action's transaction runs inside `frame.within`, so an entity call or `privileged` read made by one of its
   * functions joins it, reads its instant and hands back read-only views (TXN-16, ACT-09); a computed field or a read
   * policy runs marked with it (TXN-18).
   */
  readonly frameName: string;
  /** What `bind<Entity>Reads` names its third parameter, the binding's frame: `frame`, or `_frame` when no body loads. */
  readonly readsFrameName: string;
  /**
   * The members of `$Privileged`, what `privileged(<Entity>)` returns: one per read action, `(input, context?)`, resolving
   * with what the read gives with no policy run (`<Entity>TxWith` when it loads). Each printed in full.
   */
  readonly privilegedMembers: readonly string[];
  /** The same as a function of an entity file sees them (`$PrivilegedReadOnly`): every result deeply read-only. */
  readonly privilegedReadOnlyMembers: readonly string[];
  /** The entity value's methods as a function of an entity file sees them (`$ReadOnly`, ACT-09): every result deeply read-only. */
  readonly readOnlyMembers: readonly string[];
  /** One method per effective action: declared actions in authored order, then the `auto` ones. */
  readonly methods: readonly ActionMethod[];
  /** The exported function that binds the read bodies, e.g. `bindPostReads`, or `null` when the entity has no read action. */
  readonly readsBindName: string | null;
  /** What `bind<Entity>Reads` names its second parameter, the binding's options (the clock a loaded computed field reads): `options`, or `_options` when no body loads. */
  readonly readsOptionsName: string;
  /** One body per read action, without its policies: what `privileged` calls and what the read method calls after evaluating them. */
  readonly reads: readonly ReadBody[];
  /** The globals the file names (`$Promise`, `$Object`), from `$globals.ts`; null when it names none. */
  readonly globals: GlobalsImport | null;
}

/**
 * `export async function <name><const N extends keyof <loadable>>(tx, rows: readonly $Record[], names: readonly N[], options?): Promise<<with><N>[]>`:
 * the entity's load function (`loadTaskFields`), which the module's barrel re-exports. It runs no policy, as `privileged`
 * loads, so it is typed with the entity's `TxWith` when it has one.
 */
export interface LoadFunction {
  /** The function's name, e.g. `loadTaskFields`. */
  readonly name: string;
  /** The map of what it can load, e.g. `TaskLoadable`. */
  readonly loadable: string;
  /** The loaded record's generic type, e.g. `TaskTxWith`. */
  readonly with: string;
  /** The entity's FQN (e.g. `blog.Post`) as a quoted string literal: its entry in the load plan. */
  readonly entityLiteral: string;
}

/** `async <name>(input: <inputType>): Promise<<returnType>> { ... }` inside `bind<Entity>Reads`: a read without its policies. */
export interface ReadBody {
  /** The method key: the action's name as written, e.g. `read`. */
  readonly name: string;
  /** The read's input type, e.g. `ReadPostInput`, or `ReadPostInput<N>` when it takes `load`. */
  readonly inputType: string;
  /** The type parameter list as printed (`<const N extends keyof PostLoadable = never>` when the read takes `load`), or the empty string. */
  readonly generics: string;
  /**
   * What follows `input` in the parameter list: `, context?: unknown, clock?: () => $Date, policies?: boolean` when the body
   * loads and so reads the caller's context, then `cast` on a read that runs; `, _context?: unknown` or the empty string on
   * one that fails naming M10.
   */
  readonly contextParam: string;
  /** The validator constant, e.g. `readPostInputSchema`. */
  readonly validator: string;
  /** The resolved type, e.g. `Post[]`, or `PostWith<N>[]` when the read takes `load`. */
  readonly returnType: string;
  /** As on `ActionMethod`: when not `null`, the body validates its input and then throws a `FrameworkError` with this message. */
  readonly unsupported: string | null;
  /**
   * True when the statements read the validated input, bound to `parsed`: then the body also takes `cast`, the input its
   * read action already cast for the read's policies, and casts only when it is absent (a read through `privileged`), so
   * `contextParam` ends with `, cast?: $CastOutput<typeof validator>`.
   */
  readonly usesParsed: boolean;
  /** The statements inside `layer.transaction(async (tx) => { ... })`. */
  readonly statements: readonly string[];
}

/** `async <name>(input: <inputType>, ...[context]: ContextArgument): Promise<<returnType>> { ... }` */
export interface ActionMethod {
  /** The method key: the action's name as written (`publish`, `_archive`, `toString`); the entity value's member (`Post.publish`). */
  readonly name: string;
  /** `name` as a quoted string literal, which the entity value's method dispatches by. */
  readonly nameLiteral: string;
  /** The action's label as a quoted string literal, e.g. `"blog.Post#publish"`: what its transaction runs under in the frame. */
  readonly labelLiteral: string;
  /** The action's input type, e.g. `PublishPostInput`, or `ReadPostInput<N>` for a read that takes `load`. */
  readonly inputType: string;
  /** The type parameter list as printed (`<const N extends keyof PostLoadable = never>` for a read that takes `load`), or the empty string. */
  readonly generics: string;
  /** The validator constant, e.g. `publishPostInputSchema`. */
  readonly validator: string;
  /** The resolved type, e.g. `Post`, `Post[]`, `void`, `PostWith<N>[]` for a read that takes `load`, or `PostWith<"comments">` when a `load` step names fields. */
  readonly returnType: string;
  /**
   * What the same call returns through `privileged`, which runs no policy (TXN-16): for a read that takes `load`, the loaded record
   * typed by `PostTxWith` when a `belongs-to` that is not nullable makes it differ (POL-17); `returnType` otherwise.
   */
  readonly txReturnType: string;
  /** What the method names its context parameter: `context`, or `_context` when the statements do not read it. */
  readonly contextName: string;
  /** One comment line naming what this version does not run for the action, or `null` when everything runs. */
  readonly notRun: string | null;
  /** When not `null`, the method validates its input and then throws a `FrameworkError` with this message, a quoted string literal (a read with `filter` or `sort`); `statements` is then empty. */
  readonly unsupported: string | null;
  /** True when the statements read the validated input, which is then bound to `parsed`; a read validates and discards it. */
  readonly usesParsed: boolean;
  /** The statements inside `layer.transaction(async (tx) => { ... })`, in order, each printed in full; a line comment names the phase it starts. */
  readonly statements: readonly string[];
  /** True for a read action. */
  readonly isRead: boolean;
  /** For a create, update or destroy, the seam target as an object literal, e.g. `{ entity: "blog.Post", action: "publish" }`, which `$runAction` takes; `null` for a read (a read runs no seam). */
  readonly seamTarget: string | null;
  /** For a read, the call of its body in `bind<Entity>Reads` that the method returns after the read's policies, e.g. `$reads.read(input)`; `null` otherwise, when `statements` hold the body. */
  readonly readsCall: string | null;
  /**
   * The pre-check (M8): statements printed before the transaction opens (after the cast on a write, first on a read); on a
   * write they come before `$runAction`, so a call they deny runs no seam, `beforeTransaction` included. On a write they evaluate the checks of the covering policies that read only `actor`, `context` and `input`, once; on a read,
   * the read's policies as a filter, returning no rows when they do not admit the caller. Each line printed in full.
   */
  readonly preCheck: readonly string[];
}

/** How the actions file reaches each other generated file; fixed by the other generators' paths. */
function fromLiteral(entity: Entity, target: string): string {
  let path = relative(dirname(entityPath(entity)), target).replace(/\\/g, "/");
  if (!path.startsWith(".")) path = `./${path}`;
  return JSON.stringify(path);
}

/** `tables.posts`, or `tables["late-result"]` when the table name is not an identifier: `tables` is keyed by the table name as stored (DAT-16). */
export function tableAccess(entity: Entity): string {
  const printed = propertyName(entity.table);
  return printed === entity.table ? `tables.${entity.table}` : `tables[${printed}]`;
}

/** `parsed.title`, or `parsed["..."]` when the name is not an identifier. */
function read(object: string, name: string): string {
  const printed = propertyName(name);
  return printed === name ? `${object}.${name}` : `${object}[${printed}]`;
}

/**
 * Whether the caller gave a member input: `$Object.hasOwn(parsed, "title") && parsed.title !== undefined`. The input is an
 * ordinary object, so a member named like a member of `Object.prototype` (`toString`, ENT-18) that the caller left out
 * reads as the inherited method; only an own member is the caller's. An own `undefined` is a member left out, as the
 * input type says (`title?: string | undefined`), and the validator keeps it.
 */
function given(name: string): string {
  return `$Object.hasOwn(parsed, ${JSON.stringify(name)}) && ${read("parsed", name)} !== undefined`;
}

function isExpression(value: Literal | Atom | Expression): value is Expression {
  return typeof value === "object" && value !== null && !Array.isArray(value) && "source" in value && "params" in value;
}

function isAtom(value: Literal | Atom): value is Atom {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    && Object.keys(value).length === 1 && typeof (value as { value?: unknown }).value === "string";
}

/** A literal or atom as a TypeScript value of the attribute's type: an atom is its name as a string. */
function printValue(value: Literal | Atom, type: Attribute["type"]): string {
  // A json value is data as written; an object with a lone string `value` is not an atom there.
  if (type === "json") return JSON.stringify(value);
  const plain = isAtom(value) ? value.value : value;
  const json = JSON.stringify(plain);
  const dated = type === "date" || type === "datetime" || type === "timestamp";
  return dated && (typeof plain === "string" || typeof plain === "number") ? `new ${globalAlias("Date")}(${json})` : json;
}

/**
 * The `always` blocks that apply to an action, in the order they are written: one that names the action's type or the
 * action, and one that names neither, which covers every action of the entity.
 */
export function alwaysFor(entity: Entity, action: Action): Always[] {
  return entity.always.filter((block) =>
    (!block.types && !block.actions)
    || block.types?.includes(action.kind) || block.actions?.some((ref) => ref.name === action.name));
}

/**
 * The steps a generated action runs. A destroy returns nothing and writes nothing, so a `set` or a `load` has nothing to
 * act on: the build rejects one written for a destroy, declared or auto (`checkLifecycleLimits`), and the only ones left here come from an
 * `always` block with no scope, which covers every action and which a destroy skips. Shared with `mesh explain`, so the two agree.
 */
export function stepsFor(action: Action, steps: readonly Step[]): Step[] {
  if (action.kind !== "destroy") return [...steps];
  const out: Step[] = [];
  for (const step of steps) {
    if (step.kind === "set" || step.kind === "load") continue;
    if (step.kind === "when") {
      const inner = stepsFor(action, step.steps);
      if (inner.length) out.push({ ...step, steps: inner });
    } else out.push(step);
  }
  return out;
}

/** The stored column a member names: an attribute, or a belongs-to's key column. */
function columnOf(entity: Entity, name: string, position: SourcePosition): { name: string; type: Attribute["type"]; relation?: string } {
  const attribute = entity.attributes.find((a) => a.name === name);
  if (attribute) return attribute;
  const relation = entity.relationships.find((r) => r.name === name && r.keyColumn);
  if (relation) return { name: relation.keyColumn!, type: relation.keyType ?? "string", relation: relation.name };
  throw emitError("MESH_UNKNOWN_MEMBER", `Unknown member &${name} in entity ${entity.fqn}`, position);
}

/** Names that stay unprefixed in the actions file, as they were before the lifecycle added the others. */
const PLAIN_IMPORTS: ReadonlySet<string> = new Set(["rejectComputedQuery"]);

/** `NotFoundError as $NotFoundError`; `rejectComputedQuery`, which generated code has always imported, keeps its name. */
const runtimeImport = (name: string) => (PLAIN_IMPORTS.has(name) ? name : `${name} as $${name}`);

/**
 * `set &x=({ input }) => input.x` for the member input `&x`: the one form ADR-0012 exempts from the null-to-required
 * error; when the caller omits `x`, the step is skipped and the stored value stays. The same holds for an action that
 * does not take `&x` at all (an `always` block shared by actions of which only some take it). An input argument that
 * happens to share the column's name is not the member input, nullable column or not: an omitted argument is no value,
 * as it is under any other name.
 */
function isPassthrough(action: Action, name: string, value: Expression): boolean {
  if (inputArgument(action, name)) return false;
  const tree = value.tree;
  return tree?.kind === "member" && tree.object.kind === "var" && tree.object.name === "input" && tree.name === name;
}

const KEY = "$key";

/**
 * The head of a create: `$changes`, the row to insert, and `$record`, the new instance the checks and the steps see.
 * Both are typed with the record's own columns (ENT-18), so a column named like a member of `Object.prototype`
 * (`toString`, `constructor`) is that column, never the inherited method. `pending` are the columns the input or a `set`
 * step fills later: both hold them as null until then. The row is not left without them: TypeScript gives every object
 * the members of `Object.prototype`, so an object without a `toString` key cannot be assigned to a type whose `toString`
 * is an optional string. `written` is an `integer` key, which the data layer gives when it writes the row: the row leaves
 * it out (the data layer is handed no value for it), and the instance holds it as null until the write.
 */
function createHead(lines: readonly { column: string; value: string }[], pending: readonly string[], written: readonly string[]): string[] {
  const entries = [...lines.map(({ column, value }) => `${propertyName(column)}: ${value},`), ...pending.map((column) => `${propertyName(column)}: null,`)];
  const nullable = (columns: readonly string[]) => columns.map((column) => `${propertyName(column)}: $Record[${JSON.stringify(column)}] | null`).join("; ");
  const without = (columns: readonly string[]) => `$Omit<$Record, ${columns.map((column) => JSON.stringify(column)).join(" | ")}>`;
  const changes = pending.length + written.length === 0 ? "$Record"
    : pending.length === 0 ? without(written)
    : `${without([...pending, ...written])} & { ${nullable(pending)} }`;
  if (written.length === 0) return [`const $changes: ${changes} = {`, ...entries, "};", `const $record: ${changes} = { ...$changes };`];
  const record = `${without([...pending, ...written])} & { ${nullable([...pending, ...written])} }`;
  return [`const $changes: ${changes} = {`, ...entries, "};",
    `const $record: ${record} = { ...$changes, ${written.map((column) => `${propertyName(column)}: null`).join(", ")} };`];
}

/** The actions view of one entity. Pure and synchronous; a model it cannot render is an `EmitError`. */
export function actionsView({ document }: EmitInput, entity: Entity): ActionsView {
  const recordName = typeName(entity.name, entity.position);
  const key = entity.attributes.find((a) => a.primaryKey)!;
  const inputs = entityInputs(entity, document);
  const actions = effectiveActions(entity);
  const table = tableAccess(entity);
  const loader = hasLoader(entity);
  const ids = expressionIds(entity);
  const runtime = new Set<string>();
  const runtimeTypes = new Set<string>();
  const extraTypes = new Set<string>();
  let usesExpressions = false;
  const scopes = new Set<string>();
  let planUsed = false;
  let optionsUsed = false;
  let frameUsed = false;
  let readsLoad = false;
  const readBodies: ReadBody[] = [];
  const idOf = (expression: Expression): string => {
    const id = ids.get(expression);
    if (id === undefined) throw emitError("MESH_EMIT_NAME", "An expression has no id", expression.position);
    return `$expressions[${JSON.stringify(id)}]`;
  };
  // ---- policies (M8): what the pre-check and the in-transaction phase print ---------------------
  /** `$authorizer("blog.Post", "publish", [...])`: the policies that cover the action, each function with where it runs (`record`). */
  const authorizerCall = (action: Action, covering: readonly Policy[]): string => {
    runtime.add("authorizer");
    const specs = policySpecs(covering, (expression) => {
      usesExpressions = true;
      return idOf(expression);
    }, action.kind === "read" ? "read" : "write");
    // A read's policies run marked with the frame (TXN-18): a `privileged` read made while one is evaluated throws.
    if (action.kind === "read") frameUsed = true;
    return `$authorizer(${JSON.stringify(entity.fqn)}, ${JSON.stringify(action.name)}, ${specs}${action.kind === "read" ? ", frame" : ""})`;
  };
  /** The scope the checks before the transaction see: no record yet, only `input`, `actor` and `context`. */
  const preScope = (inputValue: string, where: string) => {
    runtime.add("scope");
    runtime.add("readOnlyRecord");
    return `$scope({ input: $readOnlyRecord(${inputValue}, ${where}), actor: $actor, context: $context }, { clock: $clock })`;
  };
  // ---- end policies ----------------------------------------------------------------------------
  const methods = actions.map((action, index): ActionMethod => {
    const input = inputs[index]!;
    // The method is the action's name as written (`_archive`, `archive_`, `toString`): a declared name is an identifier.
    const name = action.name;
    const validator = input.validator;
    const base = {
      name,
      nameLiteral: JSON.stringify(name),
      labelLiteral: JSON.stringify(`${entity.fqn}#${action.name}`),
      inputType: input.name,
      generics: "",
      validator,
    };
    runtime.add("castInput");
    const keyRead = read("parsed", key.name);
    const keyObject = `{ ${propertyName(key.name)}: ${keyRead} }`;
    const notRun = (parts: string[]) => {
      if (entity.onLoad && action.kind !== "destroy") parts.push(`on:load ${entity.onLoad.name}`);
      return parts.length ? `Not run in this version: ${parts.join("; ")}` : null;
    };
    const covering = policiesCovering(entity, action);
    const where = JSON.stringify(`${entity.fqn}#${action.name}`);
    if (action.kind === "read") {
      // The body goes to `bind<Entity>Reads`, which `privileged` calls; the method evaluates the read's policies, then calls the body.
      // A read that takes `load` is generic in the names it lists: the result is the record with exactly those loaded.
      const loads = takesLoad(input);
      // The `load` member comes from the tuple `L` itself, so that TypeScript infers the names written.
      const inputType = loads ? `$Omit<${input.name}, "load"> & ${recordName}LoadArg<L>` : input.name;
      const generics = loads ? loadGenerics(entity, true) : "";
      // A caller's load runs the read policies of what it reaches (POL-17), so a `belongs-to` it may not read is null; `privileged` runs none.
      const tx = txLoadTypes(entity);
      const returnType = loads ? `(L extends unknown ? ${recordName}With<${recordName}LoadNames<L>>[] : never)` : `${recordName}[]`;
      const txReturnType = loads ? `(L extends unknown ? ${tx.with}<${recordName}LoadNames<L>>[] : never)` : `${recordName}[]`;
      if (loads) {
        extraTypes.add(`${recordName}With`);
        extraTypes.add(tx.with);
        extraTypes.add(`${recordName}LoadNames`);
        extraTypes.add(`${recordName}LoadArg`);
        extraTypes.add(`${recordName}Loadable`);
      }
      // `policies` is true only from the read action below: a `privileged` read loads everything (TXN-16).
      // The read action casts the input for its policies and hands the result over as `cast` (R2-N4), so it is cast once.
      const castParam = `, cast?: $CastOutput<typeof ${validator}>`;
      const body = { name, inputType, generics,
        contextParam: loads ? `, context?: unknown, clock?: () => $Date, policies?: boolean${castParam}` : `, _context?: unknown, _clock?: () => $Date, _policies?: boolean${castParam}`,
        validator, returnType: txReturnType };
      // ---- policies (M8): a read's policies are a filter on the read (ADR-0022, lead ruling 2 of M8a) --------------
      // A read the SQL evaluator must run (M10) fails in its body whatever the policies say, so they are not evaluated.
      const unsupportedRead = Boolean(action.filter || action.sort);
      if (!unsupportedRead) {
        runtime.add("pinClock");
        optionsUsed = true;
      }
      const preCheck = unsupportedRead ? [] : [
        "// pre-check: the read's policies, evaluated once before the read: a caller they do not admit gets no rows, never an error; a `privileged` read skips them",
        "const $context = (context ?? {}) as unknown as { [key: string]: unknown };",
        "const $actor = $context.actor;",
        "const $clock = $pinClock(options.clock);",
        // The checks see the input as the action does, cast; an invalid input is reported as one, denied or not.
        `const $parsed = await $castInput(layer, ${validator}, input);`,
        `if (!(await ${authorizerCall(action, covering)}.filter(layer, ${preScope("$parsed as never", where)}))) return [] as unknown as ${returnType};`,
      ];
      const differs = loads && !unsupportedRead && tx.with !== `${recordName}With`;
      const readsCall = !unsupportedRead ? `$reads.${name}(input, context, $clock, true, $parsed)` : loads ? `$reads.${name}(input, context)` : `$reads.${name}(input)`;
      // ---- end policies ----------------------------------------------------------------------------------------
      const method = { ...base, inputType, generics, returnType, txReturnType, contextName: unsupportedRead && !loads ? "_context" : "context", notRun: notRun([]), unsupported: null, usesParsed: false,
        statements: [], isRead: true, seamTarget: null, readsCall: differs ? `(await ${readsCall}) as unknown as ${returnType}` : readsCall, preCheck };
      if (unsupportedRead) {
        runtime.add("FrameworkError");
        runtime.add("failJoined");
        const parts = [action.filter ? "filter" : null, action.sort ? "sort" : null].filter(Boolean).join(" and ");
        readBodies.push({ ...body, contextParam: loads ? ", _context?: unknown" : "", usesParsed: false, unsupported: JSON.stringify(
          `${entity.fqn}#${action.name} cannot run in this version: its ${parts} ${action.filter && action.sort ? "are" : "is"} evaluated by the SQL evaluator, which arrives in M10`), statements: [] });
        return method;
      }
      const query = ["filter", "sort", "limit", "offset"].map((name) => `${name}: ${read("parsed", name)}`).join(", ");
      // A filter or sort by a computed field or rollup is the SQL evaluator's job (M10): say so before touching the database.
      const computed = computedColumns(entity).map((column) => JSON.stringify(column.name));
      if (computed.length) runtime.add("rejectComputedQuery");
      const select = `await tx.select(${table}, { ${query} })`;
      if (loads) {
        // The names were validated before the transaction opened. The rows are read, then loaded in the same transaction.
        runtime.add("loadRows");
        runtime.add("pinClock");
        planUsed = true;
        readsLoad = true;
      }
      runtimeTypes.add("CastOutput");
      readBodies.push({ ...body, unsupported: null, usesParsed: true,
        statements: [
          ...(computed.length ? [`rejectComputedQuery(${JSON.stringify(entity.fqn)}, [${computed.join(", ")}], parsed);`] : []),
          ...(loads
            ? [
              `const $rows = (${select}) as ${recordName}[];`,
              `if (!parsed.load?.length) return $rows as unknown as ${txReturnType};`,
              "const $context = (context ?? {}) as unknown as { [key: string]: unknown };",
              // One instant per call: the caller's (a `privileged` read inside an action carries the action's), else this read's own.
              "const $clock = clock ?? $pinClock(options.clock);",
              // From the read action, what the rows load runs the read policies of the entity it reaches (POL-17).
              `return (await $loadRows($loadPlan, ${JSON.stringify(entity.fqn)}, tx, $rows, parsed.load, { actor: $context.actor, context: $context, clock: $clock, policies, frame })) as unknown as ${txReturnType};`,
            ]
            : [`return (${select}) as ${recordName}[];`]),
        ] });
      return method;
    }

    // ---- create, update, destroy: the lifecycle --------------------------------------------------
    const blocks: { validate: Check[]; steps: Step[] }[] = [
      ...alwaysFor(entity, action).map((block) => ({ validate: block.validate, steps: block.do })),
      { validate: action.validate, steps: action.do },
    ];
    const checks = blocks.flatMap((block) => block.validate);
    const writes = action.kind !== "destroy";
    const steps = stepsFor(action, blocks.flatMap((block) => block.steps));
    // ---- policies (M8): the checks that read the record run inside the transaction, before validate (POL-08) ----
    const recordPolicies = covering.flatMap((policy) => policyExpressions(policy).map(({ expression }) => expression)).filter((expression) => readsRecord(expression));
    const policyNeeds = [...new Set(recordPolicies.flatMap((expression) => expression.needs ?? []))].sort();
    // ---- end policies ------------------------------------------------------------------------------------------

    // What the checks read through a relationship or a computed field, loaded onto the record before they run.
    const checkNeeds = [...new Set(checks.flatMap((check) => [check.that, check.when, check.details].flatMap((e) => e?.needs ?? [])))].sort();
    // Does the call need the stored row? An update always reads it (every update is read then write, ADR-0072);
    // a destroy reads it only when something in its body can see it.
    const reads = action.kind === "update" || checks.length > 0 || steps.length > 0 || recordPolicies.length > 0;
    // The columns a `set` step assigns: a create may fill a required column from one (D04), from the top level of the body.
    const setColumns = new Set<string>();
    for (const step of steps)
      if (step.kind === "set")
        for (const { member } of step.assignments) setColumns.add(columnOf(entity, member.name, member.position).name);
    // A load at the top of the body always runs, so its member is present on the result; one under a `when` may not run,
    // so its member is typed as possibly absent.
    const loadNames = [...new Set(steps.flatMap((step) => (step.kind === "load" ? step.members.map((member) => member.name) : [])))];
    const nestedLoads = (list: readonly Step[]): string[] => list.flatMap((step) => (step.kind === "load" ? step.members.map((member) => member.name) : step.kind === "when" ? nestedLoads(step.steps) : []));
    const maybeLoadNames = [...new Set(steps.flatMap((step) => (step.kind === "when" ? nestedLoads(step.steps) : [])))].filter((name) => !loadNames.includes(name));
    const anyLoad = steps.some(function hasLoad(step): boolean { return step.kind === "load" || (step.kind === "when" && step.steps.some(hasLoad)); });
    const stamped = entity.attributes.filter((a) => a.on === "update");
    // Does any function of the action read a relationship or computed field? Only then is something ever loaded onto the record.
    const anyNeeds = [...recordPolicies, ...checks.flatMap((check) => [check.that, check.when, check.details]), ...steps.flatMap(function expressionsOf(step): (Expression | undefined)[] {
      if (step.kind === "set") return step.assignments.map(({ value }) => (isExpression(value) ? value : undefined));
      if (step.kind === "when") return [step.condition, ...step.steps.flatMap(expressionsOf)];
      return step.kind === "run" ? [step.fn] : [];
    })].some((expression) => (expression?.needs?.length ?? 0) > 0);

    // What the body ends up using decides what is declared before it; the statements come first and the declarations after.
    const used = { scope: false, load: false, now: false, plan: false, options: false };
    const head: string[] = [];
    const body: string[] = [];
    const emit = (...lines: string[]) => body.push(...lines);
    /** `$expressions["id"]($s)`, or with the scope after the write. */
    const call = (expression: Expression, scope = "$s") => { used.scope = true; usesExpressions = true; return `${idOf(expression)}(${scope})`; };
    const loadFor = (paths: readonly string[], record = "$record", options = "$load") => {
      if (!paths.length) return;
      used.load = true;
      used.plan = true;
      runtime.add("loadInto");
      emit(`await $loadInto($loadPlan, ${JSON.stringify(entity.fqn)}, tx, ${record}, ${JSON.stringify(paths)}, ${options});`);
    };
    // A `when` that holds a step after the write keeps what its condition gave, so that step runs after the write only if it held.
    const whenFlags = new Map<Step, string>();
    const flagWhens = (list: readonly Step[]) => {
      for (const step of list)
        if (step.kind === "when") {
          if (hasAfterWrite(step.steps)) whenFlags.set(step, `$when${whenFlags.size}`);
          flagWhens(step.steps);
        }
    };
    flagWhens(steps);

    // The member inputs (`&x`), applied to the record once the checks have passed (ACT-27): the checks see `self` as it is.
    const applied: string[] = [];
    if (action.kind === "create") {
      // the new instance: its key, the defaults, the stamped timestamps and null where nothing fills it yet (ACT-27)
      head.push("// plan: a create is one insert; nothing is read first");
      // With no check or step, nothing sees the instance before the input, so the row is built with the input in it.
      const seen = checks.length > 0 || steps.length > 0;
      const accepted = new Map<string, { value: string; given: string }>();
      for (const field of input.fields) {
        if (inputArgument(action, field.attribute.name)) continue;
        const column = columnOf(entity, field.attribute.name, field.attribute.position).name;
        const value = read("parsed", field.attribute.name);
        const present = given(field.attribute.name);
        accepted.set(column, { value, given: present });
        if (seen) applied.push(`if (${present}) ${read("$changes", column)} = ${read("$record", column)} = ${value};`);
      }
      const lines: { column: string; value: string }[] = [];
      // What the record type says is set but the instance does not hold yet: null on the row and on `$record` (`createHead`).
      const pending: string[] = [];
      // An `integer` key the data layer gives when it writes the row: left out of the row, null on `$record` (`createHead`).
      const written: string[] = [];
      const fill = (column: string, position: SourcePosition, rules: {
        key: "filled" | "written" | null; stamped: boolean; fallback: string | undefined; nullable: boolean }) => {
        // A `uuid` or `string` key is filled now, so `self.id` is known to the checks and the steps; the data layer gives
        // an `integer` key (the next one) when it writes the row, so until then it is null.
        if (rules.key === "filled") { runtime.add("uuidv7"); lines.push({ column, value: "$uuidv7()" }); return; }
        if (rules.key === "written") { written.push(column); return; }
        let fallback: string | undefined;
        if (rules.stamped) { fallback = "$now"; used.now = true; }
        else if (rules.fallback !== undefined) fallback = rules.fallback;
        else if (rules.nullable) fallback = "null";
        const provided = seen ? undefined : accepted.get(column);
        if (provided !== undefined) lines.push({ column, value: fallback === undefined ? provided.value : `${provided.given} ? ${provided.value} : ${fallback}` });
        else if (fallback !== undefined) lines.push({ column, value: fallback });
        // The input fills it after the checks, or a `set` step does before the row is inserted.
        else if (accepted.has(column) || setColumns.has(column)) pending.push(column);
        else throw emitError("MESH_EMIT_UNFILLABLE",
          `Create action :${action.name} of ${entity.fqn} cannot fill \`${column}\`: it is not accepted, has no default and is not nullable`,
          position, `Accept &${column} in the action's input, give it a default, make it nullable or fill it with a \`set\` step`);
      };
      for (const attribute of entity.attributes)
        fill(attribute.name, attribute.position, {
          key: attribute.primaryKey ? (filledKey(attribute.type) ? "filled" : "written") : null,
          stamped: attribute.on !== undefined,
          fallback: attribute.default === undefined ? undefined : printValue(attribute.default, attribute.type),
          nullable: attribute.nullable,
        });
      for (const relation of entity.relationships)
        if (relation.keyColumn)
          fill(relation.keyColumn, relation.position, { key: null, stamped: false, fallback: undefined, nullable: relation.nullable });
      head.push(...createHead(lines, pending, written));
    } else {
      head.push(reads
        ? "// plan: read the row under the write lock, check, apply the input, change it, write it (every update is a read then a write)"
        : "// plan: nothing in the body can see the record, so the row is deleted without being read, unless a seam wants it: then it is read under the lock first, so the seam gets `before`");
      head.push(`const ${KEY} = ${keyObject};`);
      runtime.add("NotFoundError");
      if (!reads) {
        runtime.add("wantsChanges");
        head.push(`const $before = $wantsChanges(options.seams) ? await tx.selectByKeyForUpdate(${table}, ${KEY}) : undefined;`);
        head.push(`if ($wantsChanges(options.seams) && $before === undefined) throw new $NotFoundError(${JSON.stringify(entity.fqn)}, ${KEY});`);
      }
      if (reads) {
        // The data layer returns an untyped row; it is the stored record, typed as one so that every column is itself (ENT-18).
        head.push(`const $before = (await tx.selectByKeyForUpdate(${table}, ${KEY})) as $Record | undefined;`);
        head.push(`if ($before === undefined) throw new $NotFoundError(${JSON.stringify(entity.fqn)}, ${KEY});`);
        // the stored record, as the checks see it; the accepted input is applied after them
        head.push(...(writes ? ["const $changes: $Partial<$Record> = {};"] : []), "const $record: $Record = { ...$before };");
        for (const field of input.fields.slice(1)) {
          if (field.query || inputArgument(action, field.attribute.name)) continue;
          const column = columnOf(entity, field.attribute.name, field.attribute.position);
          const value = read("parsed", field.attribute.name);
          applied.push(`if (${given(field.attribute.name)}) ${writes ? `${read("$changes", column.name)} = ` : ""}${read("$record", column.name)} = ${value};`);
        }
      }
    }

    // ---- policies (M8): the checks that read the record, before validate ------------------------------------
    if (recordPolicies.length > 0) {
      emit("// policies: the checks that read the record run here, on the locked row (on a create, the new instance before the input), before validate (POL-08), so a caller who may not run the action is told so and never which check their input fails");
      loadFor(policyNeeds, "$record", action.kind === "create" ? "{ ...$load, newInstance: true }" : "$load");
      used.scope = true;
      runtime.add("checkScope");
      emit("await $policies.inside($checkScope($s));");
    }
    // ---- end policies ------------------------------------------------------------------------------------------

    // validate
    if (checks.length > 0) {
      emit("// validate: every check runs, and every failed check is reported together");
      runtime.add("InvalidInputError");
      runtime.add("runCheck");
      runtime.add("checkScope");
      runtimeTypes.add("Issue");
      emit("const $issues: $Issue[] = [];");
      // A check sees no `before` (ACT-01, ACT-27): `self` there is the record before the input.
      emit("const $checks = $checkScope($s);");
      // On a create the record is the new instance: a required relationship the input has not filled yet is null on it.
      loadFor(checkNeeds, "$record", action.kind === "create" ? "{ ...$load, newInstance: true }" : "$load");
      for (const check of checks) {
        used.scope = true;
        usesExpressions = true;
        const source = `{ file: ${JSON.stringify(check.position.file)}, line: ${check.position.line}, column: ${check.position.column + 1} }`;
        const parts = [
          `label: ${JSON.stringify(check.label)}`,
          `code: ${JSON.stringify(check.code)}`,
          `message: ${JSON.stringify(check.message)}`,
          `source: ${source}`,
          `that: ${idOf(check.that)}`,
          ...(check.when ? [`when: ${idOf(check.when)}`] : []),
          ...(check.details ? [`details: ${idOf(check.details)}`] : []),
        ];
        emit(`await $runCheck($issues, $checks, { ${parts.join(", ")} });`);
      }
      emit("if ($issues.length > 0) throw new $InvalidInputError($issues);");
    }

    // apply the input: the caller's values over the record the checks saw; a field the caller did not send keeps its value
    if (applied.length > 0) {
      emit("// the input: the member inputs the caller sent, applied now that the checks have passed", ...applied);
      // What the checks and the policies loaded was worked out from the record before the input.
      if (checkNeeds.length > 0 || policyNeeds.length > 0) {
        used.plan = true;
        runtime.add("unloadFrom");
        emit(`$unloadFrom($loadPlan, ${JSON.stringify(entity.fqn)}, $record);`);
      }
    }

    // do
    const target = (column: string) => (writes ? `${read("$changes", column)} = ${read("$record", column)}` : read("$record", column));
    const emitSteps = (list: readonly Step[]) => {
      for (const step of list) {
        if (step.kind === "set") {
          for (const { member, value } of step.assignments) {
            const column = columnOf(entity, member.name, member.position);
            if (isExpression(value)) {
              loadFor(value.needs ?? []);
              const nullable = column.relation ? entity.relationships.find((r) => r.name === column.relation)!.nullable : entity.attributes.find((a) => a.name === column.name)!.nullable;
              if (isPassthrough(action, member.name, value)) {
                // `set &x=({ input }) => input.x`: the caller omitted x, so the stored value stays (ADR-0012).
                // A null for a required column is the caller's mistake, so it is an invalid input and not a database error.
                if (nullable || !writes) emit(`{ const $value = await ${call(value)}; if ($value !== undefined) ${target(column.name)} = $value; }`);
                else {
                  runtime.add("InvalidInputError");
                  const issue = `{ label: null, code: "required", path: [${JSON.stringify(member.name)}], message: ${JSON.stringify(`${member.name} is required and cannot be null`)}, source: null, details: null }`;
                  emit(`{ const $value = await ${call(value)}; if ($value === null) throw new $InvalidInputError([${issue}]); if ($value !== undefined) ${target(column.name)} = $value; }`);
                }
              } else if (nullable || !writes) {
                emit(`{ const $value = await ${call(value)}; ${target(column.name)} = $value === undefined ? null : $value; }`);
              } else {
                // A required column cannot take "no value": say which step produced it, with its line, instead of a constraint error from the database.
                runtime.add("FrameworkError");
                const where = `${value.position.file}:${value.position.line}:${value.position.column + 1}`;
                emit(`{ const $value = await ${call(value)}; if ($value === undefined || $value === null) throw new $FrameworkError(${JSON.stringify(`set &${member.name} (${where}) produced no value, and ${column.relation ? `the relationship ${member.name}` : member.name} is required`)}); ${target(column.name)} = $value; }`);
              }
            } else emit(`${target(column.name)} = ${printValue(value, column.type)};`);
          }
          // What was loaded was worked out from columns this step has just changed.
          if (anyNeeds) {
            used.plan = true;
            runtime.add("unloadFrom");
            emit(`$unloadFrom($loadPlan, ${JSON.stringify(entity.fqn)}, $record);`);
          }
        } else if (step.kind === "when") {
          loadFor(step.condition.needs ?? []);
          const flag = whenFlags.get(step);
          if (flag === undefined) emit(`if (await ${call(step.condition)}) {`);
          else {
            emit(`${flag} = !!(await ${call(step.condition)});`);
            if (!hasBeforeWrite(step.steps)) continue;
            emit(`if (${flag}) {`);
          }
          emitSteps(step.steps);
          emit("}");
        } else if (step.kind === "load") {
          emit(step.members.map((member) => `$loads.add(${JSON.stringify(member.name)});`).join(" "));
        } else if (step.after !== "write") {
          loadFor(step.fn.needs ?? []);
          emit(`await ${call(step.fn)};`);
        }
      }
    };
    /** The `run [after=:write]` steps, in written order, under the `when` blocks they were written in. */
    const emitAfterWrite = (list: readonly Step[], record: string) => {
      for (const step of list) {
        if (step.kind === "when" && whenFlags.has(step)) {
          emit(`if (${whenFlags.get(step)}) {`);
          emitAfterWrite(step.steps, record);
          emit("}");
        } else if (step.kind === "run" && step.after === "write") {
          loadFor(step.fn.needs ?? [], record);
          emit(`await ${call(step.fn, "$after")};`);
        }
      }
    };
    if (anyLoad) emit("const $loads = new $Set<string>();");
    if (hasBeforeWrite(steps) || whenFlags.size > 0) {
      emit("// do: the steps run in written order, each seeing the record as the ones before it left it");
      emit(...[...whenFlags.values()].map((flag) => `let ${flag} = false;`));
      emitSteps(steps);
    }

    // data layer, commit
    let returnType = writes ? recordName : "void";
    emit("// data layer");
    if (action.kind === "create") {
      emit(`const $stored = await tx.insert(${table}, $changes);`);
    } else if (action.kind === "update") {
      for (const attribute of stamped) { used.now = true; emit(`${read("$changes", attribute.name)} = $now;`); }
      if (used.scope) {
        // A call a function made before this write may have changed this very row; the action must not write after deciding on a stale copy.
        runtime.add("writeCount");
        runtime.add("checkUnchanged");
        head.push("const $writes = $writeCount(tx);");
        emit("// a call made before this write must not have changed this row: the checks and steps above decided on the row as read");
        emit(`await $checkUnchanged(tx, $writes, ${table}, ${KEY}, $before, ${where});`);
      }
      emit(`const $stored = await tx.updateByKey(${table}, ${KEY}, $changes);`);
      emit(`if ($stored === undefined) throw new $NotFoundError(${JSON.stringify(entity.fqn)}, ${KEY});`);
    } else {
      emit(`if (!(await tx.deleteByKey(${table}, ${KEY}))) throw new $NotFoundError(${JSON.stringify(entity.fqn)}, ${KEY});`);
    }
    runtime.add("noteWrite");
    emit("$noteWrite(tx);");
    runtime.add("recordWrite");
    optionsUsed = true;
    const seamTarget = `{ entity: ${JSON.stringify(entity.fqn)}, action: ${JSON.stringify(action.name)} }`;
    emit("// seam: afterWrite runs here, inside the transaction, before the steps marked after=:write; application code, so what it calls resolves with plain values");
    emit(`await frame.plain(() => $recordWrite(tx, options.seams, ${seamTarget}, ${action.kind === "create" ? "null" : reads ? "$before" : "$before ?? null"}, ${writes ? "$stored" : "null"}, parsed, context));`);
    let result = "$stored";
    // after the write: still inside the transaction, with the stored record (a destroy: the row as it was) as `self`
    if (hasAfterWrite(steps)) {
      runtime.add("readOnlyRecord");
      runtime.add("rescope");
      if (writes) {
        runtimeTypes.add("Row");
        emit("// after the write: the steps marked after=:write run here, inside the transaction, and see the stored record as self");
        emit("const $written: $Row = { ...$stored };");
      } else emit("// after the write: the steps marked after=:write run here, inside the transaction, and see the deleted row as it was as self");
      const record = writes ? "$written" : "$record";
      if (loader) {
        used.plan = true;
        runtime.add("guarded");
        emit(`const $after = $rescope($s, { self: $readOnlyRecord($guarded($loadPlan, ${JSON.stringify(entity.fqn)}, ${record}, "action function"), ${where}) });`);
      } else emit(`const $after = $rescope($s, { self: $readOnlyRecord(${record}, ${where}) });`);
      emitAfterWrite(steps, record);
      if (writes) {
        // A step after the write may have changed the row through an entity call: the result is the row as the steps left it.
        runtime.add("FrameworkError");
        emit("// the result: the row as the steps after the write left it, read again by key");
        emit(`const $result = await tx.selectByKey(${table}, { ${propertyName(key.name)}: ${read("$stored", key.name)} });`);
        emit(`if ($result === undefined) throw new $FrameworkError(${JSON.stringify(`${entity.fqn}#${action.name}: a step after the write deleted the row this action returns`)});`);
        result = "$result";
      }
    }
    // The transaction commits when this callback returns. The typed result carries anything a `load` step named.
    if (writes) {
      if (anyLoad) {
        runtime.add("loadRows");
        used.load = true;
        used.plan = true;
        emit("// still inside the transaction: the result, with what a load step named");
        if (loadNames.length || maybeLoadNames.length) {
          extraTypes.add(`${recordName}With`);
          if (maybeLoadNames.length) extraTypes.add(`${recordName}Loadable`);
          const present = loadNames.length ? `${recordName}With<${loadNames.map((name) => JSON.stringify(name)).join(" | ")}>` : recordName;
          returnType = maybeLoadNames.length ? `${present} & $Partial<$Pick<${recordName}Loadable, ${maybeLoadNames.map((name) => JSON.stringify(name)).join(" | ")}>>` : present;
        }
        // The caller gets the result, so what it loads runs the read policies of the entity it reaches (POL-17).
        emit(`return (await $loadRows($loadPlan, ${JSON.stringify(entity.fqn)}, tx, [${result}], [...$loads], { ...$load, policies: true }))[0] as unknown as ${returnType};`);
      } else emit(`return ${result} as ${recordName};`);
    }

    // The declarations the body turned out to need, in front of it. The pre-check reads the context and the clock before
    // the transaction opens, so they are declared there, and the transaction's functions read the same instant.
    const prelude: string[] = [];
    used.options = true;
    runtime.add("pinClock");
    // One instant per action call: the policies, the scope's `now()`, the `$now` stamps, the `load` step and every `privileged` read read it.
    if (used.now) prelude.push("const $now = $clock();");
    const afterHead: string[] = [];
    if (used.load) afterHead.push("const $load = { actor: $actor, context: $context, clock: $clock, frame };");
    if (used.scope) {
      runtime.add("scope");
      // An update or a destroy reads a stored record, so `before` is never null for its functions.
      const stored = action.kind !== "create";
      const scopeAlias = stored ? "$StoredScope" : "$Scope";
      scopes.add(stored ? `${entityLocal(entity, "StoredScope")} as $StoredScope` : `${entityLocal(entity, "Scope")} as $Scope`);
      runtime.add("readOnlyRecord");
      if (loader) {
        used.plan = true;
        runtime.add("guarded");
        afterHead.push(`const $self = $readOnlyRecord($guarded($loadPlan, ${JSON.stringify(entity.fqn)}, $record, "action function"), ${where});`);
      } else afterHead.push(`const $self = $readOnlyRecord($record, ${where});`);
      // `before` holds the stored columns only: a relationship or computed field read on it throws instead of coming back undefined.
      const beforeView = action.kind === "create" ? "null"
        : loader ? `$readOnlyRecord($guarded($loadPlan, ${JSON.stringify(entity.fqn)}, $before, "before"), ${where}) as unknown as ${recordName}`
          : `$readOnlyRecord($before, ${where}) as unknown as ${recordName}`;
      afterHead.push(`const $s = $scope({ self: $self, input: $readOnlyRecord(parsed, ${where}), actor: $actor, context: $context, before: ${beforeView} }, { clock: $clock }) as unknown as ${scopeAlias}<${input.name}>;`);
    }
    if (used.plan) planUsed = true;
    if (used.options) optionsUsed = true;

    const statements = ["// transaction: opens here; what follows commits together or not at all", ...prelude, ...head, ...afterHead, ...body];
    // ---- policies (M8): the pre-check, before the transaction opens -------------------------------------------
    const preCheck = [
      "// pre-check: every policy that covers the action must pass (POL-03); the checks that read only actor, context and input run here, once, before any seam, so a denial writes nothing, takes no lock and runs no seam",
      "const $context = (context ?? {}) as unknown as { [key: string]: unknown };",
      "const $actor = $context.actor;",
      "const $clock = $pinClock(options.clock);",
      `const $policies = ${authorizerCall(action, covering)};`,
      `await $policies.before(layer, ${preScope("parsed", where)});`,
    ];
    // ---- end policies ------------------------------------------------------------------------------------------
    // The working copy of the record is declared only when something reads it.
    const declared = statements.findIndex((line) => line.startsWith("const $record:"));
    if (declared >= 0 && !statements.some((line, at) => at !== declared && /\$record\b/.test(line))) statements.splice(declared, 1);
    runtime.add("runAction");
    frameUsed = true;
    return { ...base, returnType, txReturnType: returnType, contextName: "context", notRun: notRun([]), unsupported: null, usesParsed: true, statements, isRead: false, seamTarget, readsCall: null, preCheck };
  });
  // What `privileged(<Entity>)` returns, and the entity value and those reads as a function of an entity file sees them,
  // every result deeply read-only (ACT-09). Written out, not mapped, because a read is generic in the names its `load`
  // lists and a mapped type would erase that; a read's read-only result is the read-only record intersected with the
  // read-only loaded members, since a deep-readonly conditional type over the generic `L` cannot be related to its twin.
  const txTypes = txLoadTypes(entity);
  const readOnly = (method: ActionMethod, loadable: string, returnType: string) => method.isRead && method.generics
    ? `(L extends unknown ? readonly ($DeepReadonly<${recordName}> & $Pick<$DeepReadonly<${loadable}>, ${recordName}LoadNames<L>>)[] : never)`
    : returnType === "void" ? "void" : `$DeepReadonly<${returnType}>`;
  const reads = methods.filter((method) => method.isRead);
  if (reads.some((method) => method.generics)) extraTypes.add(txTypes.loadable);
  const privilegedMembers = reads.map((method) => `${method.name}${method.generics}(input: ${method.inputType}, context?: $ActionContext): $Promise<${method.txReturnType}>;`);
  const privilegedReadOnlyMembers = reads.map((method) => `${method.name}${method.generics}(input: ${method.inputType}, context?: $ActionContext): $Promise<${readOnly(method, txTypes.loadable, method.txReturnType)}>;`);
  const readOnlyMembers = methods.map((method) => `${method.name}${method.generics}(input: ${method.inputType}, ...context: $ContextArgument): $Promise<${readOnly(method, `${recordName}Loadable`, method.returnType)}>;`);
  if (readBodies.length) frameUsed = true;
  // The load function lives here, beside the entity value, so the barrel re-exports both from this file; it reads the plan
  // from the load file, which imports no actions file.
  const loadFunction: LoadFunction | null = loader
    ? { name: loaderName(entity), loadable: `${recordName}Loadable`, with: txTypes.with, entityLiteral: JSON.stringify(entity.fqn) }
    : null;
  if (loadFunction) {
    runtime.add("loadRows");
    runtimeTypes.add("DataOperations").add("LoadOptions");
    extraTypes.add(loadFunction.loadable).add(loadFunction.with);
    planUsed = true;
  }
  const view = {
    entityFile: entityFileComment(entity),
    hasActions: methods.length > 0,
    bindName: `bind${recordName}`,
    entityName: recordName,
    fqnLiteral: JSON.stringify(entity.fqn),
    readsBindValue: readBodies.length ? `bind${recordName}Reads as $EntityReadsBind<$Privileged>` : "null",
    runtimeValues: [...runtime, "entity", ...(methods.length ? ["NO_FRAME"] : [])].sort(compareCode).map(runtimeImport),
    runtimeTypes: [...runtimeTypes].sort(compareCode).map((name) => `${name} as $${name}`),
    typeImports: [...extraTypes, ...(methods.length ? inputs.map((input) => input.name) : [])],
    typesFromLiteral: JSON.stringify(`./${entitySegment(entity)}.types`),
    validatorImports: methods.map((method) => method.validator),
    validatorsFromLiteral: JSON.stringify(`./${entitySegment(entity)}.validators`),
    schemaFromLiteral: fromLiteral(entity, "schema"),
    expressionsFromLiteral: usesExpressions ? JSON.stringify(`./${entitySegment(entity)}.expressions`) : null,
    scopeImports: [...scopes].sort(compareCode),
    loadFromLiteral: planUsed ? fromLiteral(entity, "load") : null,
    loader: loadFunction,
    optionsName: optionsUsed || readBodies.length > 0 ? "options" : "_options",
    frameName: frameUsed ? "frame" : "_frame",
    readsFrameName: readsLoad ? "frame" : "_frame",
    privilegedMembers,
    privilegedReadOnlyMembers,
    readOnlyMembers,
    methods,
    readsBindName: readBodies.length ? `bind${recordName}Reads` : null,
    readsOptionsName: readsLoad ? "options" : "_options",
    reads: readBodies,
  };
  // The template prints `$Object.freeze` and, around the methods and the load function, `$Promise` and `$Omit` itself.
  const fixed = [...(["Object"] as const), ...(methods.length || loadFunction ? (["Promise"] as const) : []), ...(loadFunction ? (["Omit"] as const) : [])];
  return { ...view, globals: globalsImport(`${entityPath(entity)}.actions`, view, fixed) };
}

/** True when a `run [after=:write]` is among the steps, at any depth. */
export function hasAfterWrite(steps: readonly Step[]): boolean {
  return steps.some((step) => (step.kind === "run" && step.after === "write") || (step.kind === "when" && hasAfterWrite(step.steps)));
}

/** True when something among the steps runs before the write: a `set`, a `load`, a plain `run`, or a `when` holding one. */
function hasBeforeWrite(steps: readonly Step[]): boolean {
  return steps.some((step) => (step.kind === "run" ? step.after !== "write" : step.kind === "when" ? hasBeforeWrite(step.steps) : true));
}

/** True when `name` is a typed input argument of the action, which is not stored. */
function inputArgument(action: Action, name: string): boolean {
  return action.input.some((field) => field.kind === "argument" && field.name === name);
}

function compareCode(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
