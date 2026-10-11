import { dirname, relative } from "node:path";
import type { Action, Always, Atom, Attribute, Check, Entity, Expression, Literal, SourcePosition, Step } from "@meshfw/model";
import { emitError } from "../emit-error.ts";
import type { EmitInput } from "../emit.ts";
import { expressionIds } from "./expressions.ts";
import { hasLoader } from "./load.ts";
import { camelCase, computedColumns, effectiveActions, entityInputs, entityPath, entitySegment, propertyName, typeName, valueName } from "./inputs.ts";
import { entityFileComment } from "./types.ts";

/**
 * What `actions.ts.jig` renders for one entity: `bind<Entity>(layer, options)`, returning one
 * method per action with its whole body written out, phase by phase (roadmap principle 1, ADR-0003). Every
 * string is final, statements included; the template prints, loops and branches on
 * these fields and computes nothing. A project's own `actions.ts.jig` depends on this shape.
 */
export interface ActionsView {
  /** The entity file this file is generated from, project-relative, line terminators escaped as `\uXXXX`. */
  readonly entityFile: string;
  /** True when the entity has at least one action; when false the file binds an empty object and imports only `DataLayer`. */
  readonly hasActions: boolean;
  /** The exported binding function, e.g. `bindPost`. */
  readonly bindName: string;
  /**
   * Value imports from `@meshfw/runtime` as printed inside `import { ... }`, sorted by name.
   * A class is imported under a `$` alias (`NotFoundError as $NotFoundError`): no entity
   * name becomes a `$` name, so an entity's types can never collide with Mesh's imports.
   */
  readonly runtimeValues: readonly string[];
  /** Type imports from `@meshfw/runtime` beyond `ContextArgument`, `DataLayer` and `BindOptions`, aliased with `$`, e.g. `Issue as $Issue`. */
  readonly runtimeTypes: readonly string[];
  /** Type imports from the types file: the record type, then each input type. */
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
  /** The scope types the actions read the expressions with, from the expressions file, aliased `$Scope` and `$StoredScope`: `PostScope as $Scope`. */
  readonly scopeImports: readonly string[];
  /** The load file as a quoted string literal, or `null` when the entity has no relationship and no computed field. */
  readonly loadFromLiteral: string | null;
  /** What `bind<Entity>` names its second parameter: `options`, or `_options` when no action reads it. */
  readonly optionsName: string;
  /** What `bind<Entity>` names its third parameter, the binding's composer (ADR-0068): `compose`, or `_compose` when no function of the entity can reach `actions` or `tx`. */
  readonly composeName: string;
  /** One method per effective action: declared actions in authored order, then the `auto` ones. */
  readonly methods: readonly ActionMethod[];
  /** The exported function that binds the read bodies, e.g. `bindPostReads`, or `null` when the entity has no read action. */
  readonly readsBindName: string | null;
  /** One body per read action, without the authorizer slot: what `tx` calls and what the read method calls after that slot. */
  readonly reads: readonly ReadBody[];
}

/** `async <name>(input: <inputType>): Promise<<returnType>> { ... }` inside `bind<Entity>Reads`: a read without its authorizer slot. */
export interface ReadBody {
  /** The method key: the action name, lowerCamel, e.g. `read`. */
  readonly name: string;
  /** The read's input type, e.g. `ReadPostInput`. */
  readonly inputType: string;
  /** The validator constant, e.g. `readPostInput`. */
  readonly validator: string;
  /** The resolved type, e.g. `Post[]`. */
  readonly returnType: string;
  /** As on `ActionMethod`: when not `null`, the body validates its input and then throws a `FrameworkError` with this message. */
  readonly unsupported: string | null;
  /** True when the statements read the validated input, bound to `parsed`. */
  readonly usesParsed: boolean;
  /** The statements inside `layer.transaction(async (tx) => { ... })`. */
  readonly statements: readonly string[];
}

/** `async <name>(input: <inputType>, ...[context]: ContextArgument): Promise<<returnType>> { ... }` */
export interface ActionMethod {
  /** The method key: the action name, lowerCamel, e.g. `publish`. */
  readonly name: string;
  /** The top-level function the index exports for it: action name + entity name PascalCase, e.g. `publishPost`. */
  readonly functionName: string;
  /** The action's input type, e.g. `PublishPostInput`. */
  readonly inputType: string;
  /** The validator constant, e.g. `publishPostInput`. */
  readonly validator: string;
  /** The resolved type, e.g. `Post`, `Post[]`, `void` or `PostWith<"comments">` when a `load` step names fields. */
  readonly returnType: string;
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
  /** For a read, the call of its body in `bind<Entity>Reads` that the method returns after the authorizer slot, e.g. `$reads.read(input)`; `null` otherwise, when `statements` hold the body. */
  readonly readsCall: string | null;
}

/** How the actions file reaches each other generated file; fixed by the other generators' paths. */
function fromLiteral(entity: Entity, target: string): string {
  let path = relative(dirname(entityPath(entity)), target).replace(/\\/g, "/");
  if (!path.startsWith(".")) path = `./${path}`;
  return JSON.stringify(path);
}

/** The entity's key in the schema's `tables` map: its name, camelCase (the data adapter's rule). */
export function tableKey(entity: Entity): string {
  return camelCase(entity.name);
}

/** `tables.post`, or `tables["..."]` when the key is not an identifier. */
function tableAccess(entity: Entity): string {
  const key = tableKey(entity);
  const printed = propertyName(key);
  return printed === key ? `tables.${key}` : `tables[${printed}]`;
}

/** `parsed.title`, or `parsed["..."]` when the name is not an identifier. */
function read(object: string, name: string): string {
  const printed = propertyName(name);
  return printed === name ? `${object}.${name}` : `${object}[${printed}]`;
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
  return dated && (typeof plain === "string" || typeof plain === "number") ? `new Date(${json})` : json;
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

/** A policy applies when it names the action's type or the action; one that names neither applies to every action. */
export function policiesFor(entity: Entity, action: Action): string[] {
  return entity.policies
    .filter((policy) => (!policy.types && !policy.actions)
      || policy.types?.includes(action.kind) || policy.actions?.some((ref) => ref.name === action.name))
    .map((policy) => policy.name);
}

/** The stored column a member names: an attribute, or a belongs-to's key column. */
function columnOf(entity: Entity, name: string, position: SourcePosition): { name: string; type: Attribute["type"]; relation?: string } {
  const attribute = entity.attributes.find((a) => a.name === name);
  if (attribute) return attribute;
  const relation = entity.relationships.find((r) => r.name === name && r.keyColumn);
  if (relation) return { name: relation.keyColumn!, type: relation.keyType ?? "string", relation: relation.name };
  throw emitError("MESH_UNKNOWN_MEMBER", `Unknown member &${name} in entity :${entity.name}`, position);
}

/** Global types the generated actions and index files name; an entity's record type must not shadow them. */
export const GLOBAL_TYPES: readonly string[] = Object.freeze(["Partial", "Promise", "ReturnType"]);

/** Names that stay unprefixed in the actions file, as they were before the lifecycle added the others. */
const PLAIN_IMPORTS: ReadonlySet<string> = new Set(["parseInput", "rejectComputedQuery"]);

/** `NotFoundError as $NotFoundError`; the two functions generated code has always imported keep their names. */
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

/** The actions view of one entity. Pure and synchronous; a model it cannot render is an `EmitError`. */
export function actionsView({ document }: EmitInput, entity: Entity): ActionsView {
  const recordName = typeName(entity.name, entity.position);
  if (GLOBAL_TYPES.includes(recordName))
    throw emitError("MESH_EMIT_NAME", `Entity :${entity.name} would generate the type ${recordName}, which shadows the global ${recordName} the generated code uses`,
      entity.position, "Rename the entity");
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
  let composeUsed = false;
  const readBodies: ReadBody[] = [];
  const methods = actions.map((action, index): ActionMethod => {
    const input = inputs[index]!;
    const name = valueName(action.name, action.position);
    const validator = input.name[0]!.toLowerCase() + input.name.slice(1);
    const base = {
      name,
      functionName: `${name}${recordName}`,
      inputType: input.name,
      validator,
    };
    runtime.add("parseInput");
    const keyRead = read("parsed", key.name);
    const keyObject = `{ ${propertyName(key.name)}: ${keyRead} }`;
    const notRun = (parts: string[]) => {
      if (entity.onLoad && action.kind !== "destroy") parts.push(`on:load ${entity.onLoad.name}`);
      const policies = policiesFor(entity, action);
      if (policies.length) parts.push(`policies ${policies.join(", ")}`);
      return parts.length ? `Not run in this version: ${parts.join("; ")}` : null;
    };
    if (action.kind === "read") {
      // The body goes to `bind<Entity>Reads`, which `tx` calls; the method runs the authorizer slot, then the body.
      const body = { name, inputType: input.name, validator, returnType: `${recordName}[]` };
      const method = { ...base, returnType: `${recordName}[]`, contextName: "_context", notRun: notRun([]), unsupported: null, usesParsed: false,
        statements: [], isRead: true, readsCall: `$reads.${name}(input)` };
      if (action.filter || action.sort) {
        runtime.add("FrameworkError");
        const parts = [action.filter ? "filter" : null, action.sort ? "sort" : null].filter(Boolean).join(" and ");
        readBodies.push({ ...body, usesParsed: false, unsupported: JSON.stringify(
          `${base.functionName} cannot run in this version: its ${parts} ${action.filter && action.sort ? "are" : "is"} evaluated by the SQL evaluator, which arrives in M10`), statements: [] });
        return method;
      }
      const query = ["filter", "sort", "limit", "offset"].map((name) => `${name}: ${read("parsed", name)}`).join(", ");
      // A filter or sort by a computed field or rollup is the SQL evaluator's job (M10): say so before touching the database.
      const computed = computedColumns(entity).map((column) => JSON.stringify(column.name));
      if (computed.length) runtime.add("rejectComputedQuery");
      readBodies.push({ ...body, unsupported: null, usesParsed: true,
        statements: [
          ...(computed.length ? [`rejectComputedQuery(${JSON.stringify(entity.name)}, [${computed.join(", ")}], parsed);`] : []),
          `return (await tx.select(${table}, { ${query} })) as ${recordName}[];`,
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
    const idOf = (expression: Expression): string => {
      const id = ids.get(expression);
      if (id === undefined) throw emitError("MESH_EMIT_NAME", "An expression has no id", expression.position);
      return `$expressions[${JSON.stringify(id)}]`;
    };

    // Does the call need the stored row? An update always reads it (every update is read then write, ADR-0072);
    // a destroy reads it only when something in its body can see it.
    const reads = action.kind === "update" || checks.length > 0 || steps.length > 0;
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
    const anyNeeds = [...checks.flatMap((check) => [check.that, check.when, check.details]), ...steps.flatMap(function expressionsOf(step): (Expression | undefined)[] {
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
    const loadFor = (paths: readonly string[], record = "$record") => {
      if (!paths.length) return;
      used.load = true;
      used.plan = true;
      runtime.add("loadInto");
      emit(`await $loadInto($loadPlan, ${JSON.stringify(entity.name)}, tx, ${record}, ${JSON.stringify(paths)}, $load);`);
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

    if (action.kind === "create") {
      // the proposed record: the accepted input over the declared defaults
      head.push("// plan: a create is one insert; nothing is read first");
      const accepted = new Map<string, string>();
      for (const field of input.fields)
        if (!inputArgument(action, field.attribute.name))
          accepted.set(columnOf(entity, field.attribute.name, field.attribute.position).name, read("parsed", field.attribute.name));
      const lines: string[] = [];
      const fill = (column: string, position: SourcePosition, rules: {
        key: boolean; stamped: boolean; fallback: string | undefined; nullable: boolean }) => {
        // The primary key is not written here: the data layer fills a key the row lacks (a UUIDv7
        // for a text key, the next integer for an integer key) inside the write transaction.
        if (rules.key && !setColumns.has(column)) return;
        let fallback: string | undefined;
        if (rules.stamped) { fallback = "$now"; used.now = true; }
        else if (rules.fallback !== undefined) fallback = rules.fallback;
        else if (rules.nullable) fallback = "null";
        const provided = accepted.get(column);
        let value: string;
        if (provided !== undefined) value = fallback === undefined ? provided : `${provided} === undefined ? ${fallback} : ${provided}`;
        else if (fallback !== undefined) value = fallback;
        // A column a `set` step fills is not known yet: the step writes it before the row is inserted.
        else if (setColumns.has(column)) return;
        else throw emitError("MESH_EMIT_UNFILLABLE",
          `Create action :${action.name} of :${entity.name} cannot fill \`${column}\`: it is not accepted, has no default and is not nullable`,
          position, `Accept &${column} in the action's input, give it a default, make it nullable or fill it with a \`set\` step`);
        lines.push(`${propertyName(column)}: ${value},`);
      };
      for (const attribute of entity.attributes)
        fill(attribute.name, attribute.position, {
          key: attribute.primaryKey,
          stamped: attribute.on !== undefined,
          fallback: attribute.default === undefined ? undefined : printValue(attribute.default, attribute.type),
          nullable: attribute.nullable,
        });
      for (const relation of entity.relationships)
        if (relation.keyColumn)
          fill(relation.keyColumn, relation.position, { key: false, stamped: false, fallback: undefined, nullable: relation.nullable });
      runtimeTypes.add("Row");
      head.push("const $changes: $Row = {", ...lines, "};", "const $record: $Row = { ...$changes };");
    } else {
      head.push(reads
        ? "// plan: read the row under the write lock, check, change it, write it (every update is a read then a write)"
        : "// plan: nothing in the body can see the record, so the row is deleted without being read");
      head.push(`const ${KEY} = ${keyObject};`);
      runtime.add("NotFoundError");
      if (reads) {
        runtimeTypes.add("Row");
        head.push(`const $before = await tx.selectByKeyForUpdate(${table}, ${KEY});`);
        head.push(`if ($before === undefined) throw new $NotFoundError(${JSON.stringify(entity.name)}, ${KEY});`);
        // the record with the accepted input applied: stored values for the fields the caller did not send
        head.push(...(writes ? ["const $changes: $Row = {};"] : []), "const $record: $Row = { ...$before };");
        for (const field of input.fields.slice(1)) {
          if (field.query || inputArgument(action, field.attribute.name)) continue;
          const column = columnOf(entity, field.attribute.name, field.attribute.position);
          const value = read("parsed", field.attribute.name);
          head.push(`if (${value} !== undefined) ${writes ? `${read("$changes", column.name)} = ` : ""}${read("$record", column.name)} = ${value};`);
        }
      }
    }

    // validate
    if (checks.length > 0) {
      emit("// validate: every check runs, and every failed check is reported together");
      runtime.add("InvalidInputError");
      runtime.add("runCheck");
      runtimeTypes.add("Issue");
      emit("const $issues: $Issue[] = [];");
      loadFor([...new Set(checks.flatMap((check) => [check.that, check.when, check.details].flatMap((e) => e?.needs ?? [])))].sort());
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
        emit(`await $runCheck($issues, $s, { ${parts.join(", ")} });`);
      }
      emit("if ($issues.length > 0) throw new $InvalidInputError($issues);");
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
            emit(`$unloadFrom($loadPlan, ${JSON.stringify(entity.name)}, $record);`);
          }
        } else if (step.kind === "when") {
          loadFor(step.condition.needs ?? []);
          const flag = whenFlags.get(step);
          if (flag === undefined) emit(`if (await ${call(step.condition)}) {`);
          else {
            emit(`${flag} = Boolean(await ${call(step.condition)});`);
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
    if (anyLoad) emit("const $loads = new Set<string>();");
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
      emit(`const $stored = await tx.updateByKey(${table}, ${KEY}, $changes);`);
      emit(`if ($stored === undefined) throw new $NotFoundError(${JSON.stringify(entity.name)}, ${KEY});`);
    } else {
      emit(`if (!(await tx.deleteByKey(${table}, ${KEY}))) throw new $NotFoundError(${JSON.stringify(entity.name)}, ${KEY});`);
    }
    // after the write: still inside the transaction, with the stored record (a destroy: the row as it was) as `self`
    if (hasAfterWrite(steps)) {
      const where = JSON.stringify(`${entity.name}.${action.name}`);
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
        emit(`const $after = $rescope($s, { self: $readOnlyRecord($guarded($loadPlan, ${JSON.stringify(entity.name)}, ${record}, "action function"), ${where}) });`);
      } else emit(`const $after = $rescope($s, { self: $readOnlyRecord(${record}, ${where}) });`);
      emitAfterWrite(steps, record);
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
          returnType = maybeLoadNames.length ? `${present} & Partial<Pick<${recordName}Loadable, ${maybeLoadNames.map((name) => JSON.stringify(name)).join(" | ")}>>` : present;
        }
        emit(`return (await $loadRows($loadPlan, ${JSON.stringify(entity.name)}, tx, [$stored], [...$loads], $load))[0] as unknown as ${returnType};`);
      } else emit(`return $stored as ${recordName};`);
    }

    // The declarations the body turned out to need, in front of it.
    const prelude: string[] = [];
    const usesContext = used.scope || used.load;
    if (usesContext) {
      used.options = true;
      prelude.push("const $context = (context ?? {}) as unknown as Record<string, unknown>;", "const $actor = $context.actor;");
    }
    if (used.now) { used.options = true; prelude.push("const $now = options.clock?.() ?? new Date();"); }
    const afterHead: string[] = [];
    if (used.load) afterHead.push("const $load = { actor: $actor, context: $context, clock: options.clock };");
    if (used.scope) {
      runtime.add("scope");
      // An update or a destroy reads a stored record, so `before` is never null for its functions.
      const stored = action.kind !== "create";
      const scopeAlias = stored ? "$StoredScope" : "$Scope";
      scopes.add(stored ? `${recordName}StoredScope as $StoredScope` : `${recordName}Scope as $Scope`);
      runtime.add("readOnlyRecord");
      const where = JSON.stringify(`${entity.name}.${action.name}`);
      if (loader) {
        used.plan = true;
        runtime.add("guarded");
        afterHead.push(`const $self = $readOnlyRecord($guarded($loadPlan, ${JSON.stringify(entity.name)}, $record, "action function"), ${where});`);
      } else afterHead.push(`const $self = $readOnlyRecord($record, ${where});`);
      // `before` holds the stored columns only: a relationship or computed field read on it throws instead of coming back undefined.
      const beforeView = action.kind === "create" ? "null"
        : loader ? `$readOnlyRecord($guarded($loadPlan, ${JSON.stringify(entity.name)}, $before, "before"), ${where}) as unknown as ${recordName}`
          : `$readOnlyRecord($before, ${where}) as unknown as ${recordName}`;
      // `actions` and `tx` come from the binding's composer, bound to this transaction and carrying this call's context (ADR-0068).
      runtime.add("composed");
      composeUsed = true;
      afterHead.push(`const $s = $scope({ self: $self, input: $readOnlyRecord(parsed, ${where}), actor: $actor, context: $context, before: ${beforeView}, ...$composed(compose, tx, context, ${where}) }, options) as unknown as ${scopeAlias}<${input.name}>;`);
    }
    if (used.plan) planUsed = true;
    if (used.options) optionsUsed = true;

    const statements = [`// transaction: opens here; what follows commits together or not at all (pre-check: the authorizer slot before it stays empty until policies, M8)`, ...prelude, ...head, ...afterHead, ...body];
    // The working copy of the record is declared only when something reads it.
    const declared = statements.findIndex((line) => line.startsWith("const $record:"));
    if (declared >= 0 && !statements.some((line, at) => at !== declared && line.includes("$record"))) statements.splice(declared, 1);
    return { ...base, returnType, contextName: usesContext ? "context" : "_context", notRun: notRun([]), unsupported: null, usesParsed: true, statements, isRead: false, readsCall: null };
  });
  return {
    entityFile: entityFileComment(entity),
    hasActions: methods.length > 0,
    bindName: `bind${recordName}`,
    runtimeValues: [...runtime].sort(compareCode).map(runtimeImport),
    runtimeTypes: [...runtimeTypes].sort(compareCode).map((name) => `${name} as $${name}`),
    typeImports: methods.length ? [recordName, ...extraTypes, ...inputs.map((input) => input.name)] : [],
    typesFromLiteral: JSON.stringify(`./${entitySegment(entity)}.types`),
    validatorImports: methods.map((method) => method.validator),
    validatorsFromLiteral: JSON.stringify(`./${entitySegment(entity)}.validators`),
    schemaFromLiteral: fromLiteral(entity, "schema"),
    expressionsFromLiteral: usesExpressions ? JSON.stringify(`./${entitySegment(entity)}.expressions`) : null,
    scopeImports: [...scopes].sort(compareCode),
    loadFromLiteral: planUsed ? fromLiteral(entity, "load") : null,
    optionsName: optionsUsed ? "options" : "_options",
    composeName: composeUsed ? "compose" : "_compose",
    methods,
    readsBindName: readBodies.length ? `bind${recordName}Reads` : null,
    reads: readBodies,
  };
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
