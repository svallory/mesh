import { dirname, relative } from "node:path";
import type { Action, Atom, Attribute, Entity, Expression, Literal, SourcePosition, Step } from "@meshfw/model";
import { emitError } from "../emit-error.ts";
import type { EmitInput } from "../emit.ts";
import { camelCase, effectiveActions, entityInputs, entityPath, entitySegment, propertyName, typeName, valueName } from "./inputs.ts";
import { entityFileComment } from "./types.ts";

/**
 * What `actions.ts.jig` renders for one entity: `bind<Entity>(layer)`, returning one
 * method per action with its whole body written out (roadmap principle 1). Every
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
  /** Value imports from `@meshfw/runtime`, sorted, e.g. `["NotFoundError", "parseInput"]`. */
  readonly runtimeValues: readonly string[];
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
  /** One method per effective action: declared actions in authored order, then the `auto` ones. */
  readonly methods: readonly ActionMethod[];
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
  /** The resolved type, e.g. `Post`, `Post[]` or `void`. */
  readonly returnType: string;
  /** One comment line naming what this version does not run for the action, or `null` when everything runs. */
  readonly notRun: string | null;
  /** When not `null`, the method validates its input and then throws a `FrameworkError` with this message, a quoted string literal (a read with `filter` or `sort`); `statements` is then empty. */
  readonly unsupported: string | null;
  /** True when the statements read the validated input, which is then bound to `parsed`; a read validates and discards it. */
  readonly usesParsed: boolean;
  /** The statements inside `layer.transaction(async (tx) => { ... })`, in order, each printed in full. */
  readonly statements: readonly string[];
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
  const plain = isAtom(value) ? value.value : value;
  const json = JSON.stringify(plain);
  const dated = type === "date" || type === "datetime" || type === "timestamp";
  return dated && (typeof plain === "string" || typeof plain === "number") ? `new Date(${json})` : json;
}

/** The `always` blocks that apply to an action: by type, or by name. */
function alwaysFor(entity: Entity, action: Action) {
  return entity.always.filter((block) =>
    block.types?.includes(action.kind) || block.actions?.some((ref) => ref.name === action.name));
}

/** A policy applies when it names the action's type or the action; one that names neither applies to every action. */
function policiesFor(entity: Entity, action: Action): string[] {
  return entity.policies
    .filter((policy) => (!policy.types && !policy.actions)
      || policy.types?.includes(action.kind) || policy.actions?.some((ref) => ref.name === action.name))
    .map((policy) => policy.name);
}

interface Assignment { readonly column: string; readonly value: string }

/**
 * The constant `set` steps (every value a literal or an atom), which M2 applies, and
 * the comment naming everything else it does not run: checks, other steps, `on:load`
 * and policies run from later milestones (roadmap M4, M5, M7, M8).
 */
function plan(entity: Entity, action: Action) {
  const steps: Step[] = [];
  const checks: string[] = [];
  for (const block of [...alwaysFor(entity, action), action]) {
    checks.push(...block.validate.map((check) => check.label));
    steps.push(...block.do);
  }
  const sets: Assignment[] = [];
  const skippedSets: string[] = [];
  const loads: string[] = [];
  let whens = 0;
  let runs = 0;
  const writes = action.kind === "create" || action.kind === "update";
  for (const step of steps) {
    if (step.kind === "set") {
      const constant = step.assignments.every(({ value }) => !isExpression(value));
      if (constant && writes) {
        for (const { member, value } of step.assignments) {
          const column = columnOf(entity, member.name, member.position);
          sets.push({ column: column.name, value: isExpression(value) ? "" : printValue(value, column.type) });
        }
      } else skippedSets.push(...step.assignments.map(({ member }) => member.name));
    } else if (step.kind === "when") whens++;
    else if (step.kind === "run") runs++;
    else loads.push(...step.members.map((member) => member.name));
  }
  const parts: string[] = [];
  if (checks.length) parts.push(`validate ${checks.join(", ")}`);
  if (skippedSets.length) parts.push(`set ${skippedSets.join(", ")}`);
  if (whens) parts.push("when");
  if (runs) parts.push("run");
  if (loads.length) parts.push(`load ${loads.join(", ")}`);
  if (entity.onLoad && action.kind !== "destroy") parts.push(`on:load ${entity.onLoad.name}`);
  const policies = policiesFor(entity, action);
  if (policies.length) parts.push(`policies ${policies.join(", ")}`);
  return { sets, notRun: parts.length ? `Not run in this version: ${parts.join("; ")}` : null };
}

/** The stored column a member names: an attribute, or a belongs-to's key column. */
function columnOf(entity: Entity, name: string, position: SourcePosition): { name: string; type: Attribute["type"] } {
  const attribute = entity.attributes.find((a) => a.name === name);
  if (attribute) return attribute;
  const relation = entity.relationships.find((r) => r.name === name && r.keyColumn);
  if (relation) return { name: relation.keyColumn!, type: "string" };
  throw emitError("MESH_UNKNOWN_MEMBER", `Unknown member &${name} in entity :${entity.name}`, position);
}

const KEY = "key";

/** The actions view of one entity. Pure and synchronous; a model it cannot render is an `EmitError`. */
export function actionsView({ document }: EmitInput, entity: Entity): ActionsView {
  const recordName = typeName(entity.name, entity.position);
  const key = entity.attributes.find((a) => a.primaryKey)!;
  const inputs = entityInputs(entity, document);
  const actions = effectiveActions(entity);
  const table = tableAccess(entity);
  const runtime = new Set<string>();
  const methods = actions.map((action, index): ActionMethod => {
    const input = inputs[index]!;
    const name = valueName(action.name, action.position);
    const validator = input.name[0]!.toLowerCase() + input.name.slice(1);
    const { sets, notRun } = plan(entity, action);
    const base = {
      name,
      functionName: `${name}${recordName}`,
      inputType: input.name,
      validator,
      notRun,
    };
    runtime.add("parseInput");
    const keyRead = read("parsed", key.name);
    const keyObject = `{ ${propertyName(key.name)}: ${keyRead} }`;
    switch (action.kind) {
      case "read": {
        if (action.filter || action.sort) {
          runtime.add("FrameworkError");
          const parts = [action.filter ? "filter" : null, action.sort ? "sort" : null].filter(Boolean).join(" and ");
          return { ...base, returnType: `${recordName}[]`, usesParsed: false, unsupported: JSON.stringify(
            `${base.functionName} cannot run in this version: its ${parts} ${action.filter && action.sort ? "are" : "is"} evaluated from M4`), statements: [] };
        }
        return { ...base, returnType: `${recordName}[]`, unsupported: null, usesParsed: false,
          statements: [`return (await tx.selectAll(${table})) as ${recordName}[];`] };
      }
      case "destroy": {
        const accepted = action.input[0];
        if (accepted) throw emitError("MESH_EMIT_UNSUPPORTED",
          `Destroy action :${action.name} of :${entity.name}: a destroy action accepts no attributes in this version`,
          accepted.kind === "member" ? accepted.ref.position : accepted.position,
          "Remove the input section from the destroy action");
        runtime.add("NotFoundError");
        return { ...base, returnType: "void", unsupported: null, usesParsed: true, statements: [
          `const ${KEY} = ${keyObject};`,
          `if (!(await tx.deleteByKey(${table}, ${KEY}))) throw new NotFoundError(${JSON.stringify(entity.name)}, ${KEY});`,
        ] };
      }
      case "update": {
        runtime.add("NotFoundError");
        const statements = [`const ${KEY} = ${keyObject};`, `const changes: Partial<${recordName}> = {};`];
        for (const field of input.fields.slice(1)) {
          if (inputArgument(action, field.attribute.name)) continue;
          const column = columnOf(entity, field.attribute.name, field.attribute.position).name;
          const value = read("parsed", field.attribute.name);
          statements.push(`if (${value} !== undefined) ${read("changes", column)} = ${value};`);
        }
        for (const set of sets) statements.push(`${read("changes", set.column)} = ${set.value};`);
        const stamped = entity.attributes.filter((a) => a.on === "update");
        if (stamped.length) {
          statements.push("const now = new Date();");
          for (const attribute of stamped) statements.push(`${read("changes", attribute.name)} = now;`);
        }
        statements.push(
          `const row = await tx.updateByKey(${table}, ${KEY}, changes);`,
          `if (row === undefined) throw new NotFoundError(${JSON.stringify(entity.name)}, ${KEY});`,
          `return row as ${recordName};`,
        );
        return { ...base, returnType: recordName, unsupported: null, usesParsed: true, statements };
      }
      case "create": {
        const accepted = new Map<string, string>();
        for (const field of input.fields)
          if (!inputArgument(action, field.attribute.name))
            accepted.set(columnOf(entity, field.attribute.name, field.attribute.position).name, read("parsed", field.attribute.name));
        const constants = new Map(sets.map((set) => [set.column, set.value]));
        const lines: string[] = [];
        let usesNow = false;
        const fill = (column: string, position: SourcePosition, rules: {
          uuidKey: boolean; stamped: boolean; fallback: string | undefined; nullable: boolean }) => {
          let fallback: string | undefined;
          if (constants.has(column)) fallback = constants.get(column);
          else if (rules.uuidKey) fallback = "crypto.randomUUID()";
          else if (rules.stamped) { fallback = "now"; usesNow = true; }
          else if (rules.fallback !== undefined) fallback = rules.fallback;
          else if (rules.nullable) fallback = "null";
          const provided = accepted.get(column);
          // A constant `set` is a step: it runs after the input is taken, so it wins.
          let value: string;
          if (constants.has(column)) value = fallback!;
          else if (provided !== undefined) value = fallback === undefined ? provided : `${provided} === undefined ? ${fallback} : ${provided}`;
          else if (fallback !== undefined) value = fallback;
          else throw emitError("MESH_EMIT_UNFILLABLE",
            `Create action :${action.name} of :${entity.name} cannot fill \`${column}\`: it is not accepted, has no default and is not nullable`,
            position, `Accept &${column} in the action's input, give it a default, or make it nullable`);
          lines.push(`${propertyName(column)}: ${value},`);
        };
        for (const attribute of entity.attributes)
          fill(attribute.name, attribute.position, {
            uuidKey: attribute.primaryKey && attribute.type === "uuid",
            stamped: attribute.on !== undefined,
            fallback: attribute.default === undefined ? undefined : printValue(attribute.default, attribute.type),
            nullable: attribute.nullable,
          });
        for (const relation of entity.relationships)
          if (relation.keyColumn)
            fill(relation.keyColumn, relation.position, { uuidKey: false, stamped: false, fallback: undefined, nullable: relation.nullable });
        const statements = [
          ...(usesNow ? ["const now = new Date();"] : []),
          `const row = await tx.insert(${table}, {`, ...lines.map((line) => `  ${line}`), "});",
          `return row as ${recordName};`,
        ];
        return { ...base, returnType: recordName, unsupported: null, usesParsed: true, statements };
      }
    }
  });
  return {
    entityFile: entityFileComment(entity),
    hasActions: methods.length > 0,
    bindName: `bind${recordName}`,
    runtimeValues: [...runtime].sort(compareCode),
    typeImports: methods.length ? [recordName, ...inputs.map((input) => input.name)] : [],
    typesFromLiteral: JSON.stringify(`./${entitySegment(entity)}.types`),
    validatorImports: methods.map((method) => method.validator),
    validatorsFromLiteral: JSON.stringify(`./${entitySegment(entity)}.validators`),
    schemaFromLiteral: fromLiteral(entity, "schema"),
    methods,
  };
}

/** True when `name` is a typed input argument of the action, which is not stored. */
function inputArgument(action: Action, name: string): boolean {
  return action.input.some((field) => field.kind === "argument" && field.name === name);
}

function compareCode(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
