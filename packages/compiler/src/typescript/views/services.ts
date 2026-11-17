import { dirname, posix, relative } from "node:path";
import type { Argument, Entity, Expression, Operation, Service } from "@meshfw/model";
import { policyExpressions } from "../../model/policies.ts";
import type { EmitInput } from "../emit.ts";
import { emitError } from "../emit-error.ts";
import { compareText } from "../emitters/order.ts";
import { emittedNothing, printExpression, type EntityLocals, type NamedInTypes } from "../expression-printer.ts";
import { typeNames } from "../type-names.ts";
import { conceptImports, type ConceptImport } from "./concepts.ts";
import { policySpecs, type ExpressionEntry, type HelperImport } from "./expressions.ts";
import { globalsImport, type GlobalsImport } from "./globals.ts";
import { conceptsUsed, entityLocal, entityPath, entitySegment, propertyName, schemaName, typeName, valueType } from "./inputs.ts";
import { entityFileComment } from "./types.ts";
import { fieldSchema, ruleTable, type SchemaField } from "./validators.ts";

/**
 * The two files of a service (services design, sections 5.1 step 5 and 7; ruling D42), each below the service's module
 * folder: `<service>.service.ts`, the service value with its operations' bodies and policies (`service.ts.jig`), and
 * `<service>.inputs.ts`, each operation's input type and the Zod schema that casts it (`service-inputs.ts.jig`). The
 * inputs are a file of their own because the service file imports the service file's helpers under the names the
 * service file gives them, and a helper may have any name that does not start with `$` (`z`, `Work`): so that file
 * declares nothing at module level without a `$` except a `declare namespace <alias>` for a namespace import the service
 * file itself makes (the alias cannot also name a helper of that file), and exports the value under its name with `export { $local as Work }`.
 * Neither path is one an entity's files use (`<entity>.types.ts`, `.validators.ts`, `.actions.ts`, ...).
 */

/** The scope roots a service function reads: a service has no record, so no `self` and no `before` (the build refused them). */
const ROOTS = ["input", "actor", "context"] as const;
/** A name an import can print bare; any other export name is printed as a string literal (`import { "a-b" as ab }`). */
const IDENTIFIER = /^[\p{ID_Start}$_][\p{ID_Continue}$‌‍]*$/u;

/** The service's generated files below the output directory, without the kind and extension: `domain/work/work`. */
export const servicePath = (service: Service): string => entityPath(service);

/** One operation's input: its type and its schema, as the inputs file exports them. */
export interface ServiceInput {
  /** The operation's name as written. */
  readonly operation: string;
  /** The input type: the operation's name in PascalCase, the service's and `Input` (`HandOverWorkInput`). */
  readonly typeName: string;
  /** Its schema: `schemaName(typeName)`, e.g. `handOverWorkInputSchema`. */
  readonly constName: string;
  /** The exported compile-time assertion that schema output and input type agree, e.g. `HandOverWorkInputShape`. */
  readonly shapeTypeName: string;
  /** True when the operation declares no input field: the type is then `{ [key: string]: never }`. */
  readonly empty: boolean;
  /** One member per field: `key?: type` when the caller may leave it out (nullable or with a default), with `| undefined`. */
  readonly members: readonly { readonly key: string; readonly optional: boolean; readonly type: string }[];
  /** The schema's properties, in the order of the members. */
  readonly fields: readonly SchemaField[];
  /** The schema's `$ruled` table as printed, or `null` when no field has a line rule (the schema is printed unwrapped). */
  readonly rules: string | null;
}

/**
 * What `service-inputs.ts.jig` renders: `<service>.inputs.ts`, one input type and one Zod schema per operation, in the
 * order of the service file. Every string is final; the template prints and loops. A project's own
 * `service-inputs.ts.jig` depends on this shape.
 */
export interface ServiceInputsView {
  /** The service file, project-relative, line terminators escaped as `\uXXXX`. */
  readonly serviceFile: string;
  readonly inputs: readonly ServiceInput[];
  /** True when a field is `json`: the file imports `jsonValue` from `@meshfw/runtime` as `$jsonValue`. */
  readonly json: boolean;
  /** True when a schema has a line rule: the file declares the `$ruled` helper. */
  readonly lineRules: boolean;
  /** Each concept a field holds, sorted by FQN: its type and schema under their locals. Always empty for now: the contract
   * refuses a concept field under an operation's `input` (`MESH_TAG_NOT_ALLOWED`). */
  readonly concepts: readonly ConceptImport[];
  /** The globals the file names (`$Date`, `$RegExp`), from `$globals.ts`; null when it names none. */
  readonly globals: GlobalsImport | null;
}

/** The input type and schema names of each operation, refusing two operations whose names give one (`fooBar`, `foo_bar`). */
function inputNamesOf(service: Service): { operation: Operation; typeName: string; constName: string }[] {
  const taken = new Map<string, string>();
  return service.operations.map((operation) => {
    const name = `${typeName(operation.name, operation.position)}${typeName(service.name, service.position)}Input`;
    const other = taken.get(name);
    if (other !== undefined)
      throw emitError("MESH_EMIT_NAME", `Service ${service.fqn} would generate the type ${name} twice: for :${other} and for :${operation.name}`, operation.position, "Rename one of the two operations");
    taken.set(name, operation.name);
    return { operation, typeName: name, constName: schemaName(name) };
  });
}

/** The names the barrel re-exports from the inputs file: each operation's input type. */
export function serviceInputTypes(service: Service): string[] {
  return inputNamesOf(service).map(({ typeName: name }) => name);
}

/** May the caller leave the field out? As for an action's argument (`inputOptional`): when it is nullable or has a default. */
const optionalField = (field: Argument) => field.nullable || field.default !== undefined;

export function serviceInputsView({ document }: EmitInput, service: Service): ServiceInputsView {
  const inputs = inputNamesOf(service).map(({ operation, typeName: name, constName }): ServiceInput => ({
    operation: operation.name,
    typeName: name,
    constName,
    shapeTypeName: `${name}Shape`,
    empty: operation.input.length === 0,
    members: operation.input.map((field) => ({ key: propertyName(field.name), optional: optionalField(field), type: `${valueType(field)}${optionalField(field) ? " | undefined" : ""}` })),
    fields: operation.input.map((field) => ({ name: field.name, key: propertyName(field.name), schema: fieldSchema(field, optionalField(field)) })),
    rules: ruleTable(operation.input),
  }));
  const fields = service.operations.flatMap((operation) => operation.input);
  const file = `${servicePath(service)}.inputs`;
  const view = {
    serviceFile: entityFileComment(service),
    inputs,
    json: fields.some((field) => field.type === "json"),
    lineRules: inputs.some((input) => input.rules !== null),
    concepts: conceptImports(document, conceptsUsed(fields), file),
  };
  return { ...view, globals: globalsImport(file, view) };
}

/** One operation of the service value. */
export interface ServiceOperation {
  /** The operation's name as an object key and method name: the name, JSON-quoted when it is not an identifier. */
  readonly key: string;
  /** The name as a quoted string literal, which the method passes to `call`. */
  readonly nameLiteral: string;
  /** The local the file imports its input type under, e.g. `$work$Work$HandOverWorkInput`. */
  readonly inputLocal: string;
  /** The local the file imports its input schema under, e.g. `$work$Work$handOverWorkInputSchema`. */
  readonly schemaLocal: string;
  /** The covering policies as `authorizer` takes them, an array literal (`policySpecs`); `[]` is a call that is forbidden. */
  readonly policies: string;
  /** The `uses` lines as an object literal: each entity's FQN and the actions of it the body may call, read or ask about. */
  readonly uses: string;
  /** How the file reads the body: `$expressions["handOver.run"]`. */
  readonly body: string;
}

/**
 * What `service.ts.jig` renders: `<service>.service.ts`. The service's functions (each operation's body, each policy's
 * functions) as `$expressions`, one function of the operation's scope each, printed as an entity's are; and the service
 * value, `service(fqn, operations, members)` from `@meshfw/runtime`, exported under the service's name. Every string is
 * final; the template prints and loops. A project's own `service.ts.jig` depends on this shape.
 */
export interface ServiceView {
  /** The service file, project-relative, line terminators escaped as `\uXXXX`. */
  readonly serviceFile: string;
  /** The service's name as the module barrel exports its value, e.g. `Work`. */
  readonly name: string;
  /** The FQN as a quoted string literal, e.g. `"work.Work"`. */
  readonly fqnLiteral: string;
  /** The local the file defines the value under, `entityLocal(service, "service")`, e.g. `$work$Work$service`. */
  readonly valueLocal: string;
  /** What the file imports from `@meshfw/runtime` as values, as printed inside the braces (`service as $service`, `Mesh`). */
  readonly runtimeValues: readonly string[];
  /** True when a scope type names `$SharedInput`: a policy covers operations with different inputs. */
  readonly usesSharedInput: boolean;
  /** The inputs file, quoted, e.g. `"./work.inputs"`. */
  readonly inputsFromLiteral: string;
  /** What the file imports from the inputs file, as printed (`HandOverWorkInput as $work$Work$HandOverWorkInput`, ...): the types and the schemas. */
  readonly inputTypeImports: readonly string[];
  readonly inputValueImports: readonly string[];
  /** The service file's helper imports the functions name, one per module, under the names the service file gives them. */
  readonly helperImports: readonly HelperImport[];
  /** The entity values (`Task as $work$Task$value`) and record types the functions name, one import per entity's actions file. */
  readonly entityImports: readonly { keyword: "import" | "import type"; names: string; fromLiteral: string }[];
  /** A namespace import the functions name in a type: `declare namespace w { export type Notification = $work$Notification$Record; }`. */
  readonly entityNamespaces: readonly { name: string; members: string }[];
  /** The scope type's name, `entityLocal(service, "ServiceScope")`, a generic over `I`, the operation's input. */
  readonly scopeName: string;
  readonly scopeType: string;
  /** One function per body and per policy function, the bodies first, each in the order of the service file. */
  readonly entries: readonly ExpressionEntry[];
  /** One entry per operation, in the order of the service file. */
  readonly operations: readonly ServiceOperation[];
  /** The globals the file names (`$Promise`), from `$globals.ts`; null when it names none. */
  readonly globals: GlobalsImport | null;
}

/** A function of the service and what it is: an operation's body (`operations` is that one) or a policy's (the operations it covers). */
interface Found { id: string; what: string; expression: Expression; body: boolean; operations: readonly Operation[] }

/** Does a service policy cover the operation? One with no `actions=` covers every operation. */
const covers = (policy: Service["policies"][number], operation: Operation) => !policy.actions || policy.actions.some((ref) => ref.name === operation.name);

export function serviceView({ document }: EmitInput, service: Service, generatedPath: string): ServiceView {
  const names = new Map(inputNamesOf(service).map(({ operation, typeName: name, constName }) => [operation, { type: entityLocal(service, name), schema: entityLocal(service, constName), name, constName }]));
  const found: Found[] = [
    ...service.operations.map((operation): Found => ({ id: `${operation.name}.run`, what: `operation :${operation.name} run`, expression: operation.run, body: true, operations: [operation] })),
    ...service.policies.flatMap((policy) => policyExpressions(policy).map(({ expression, id, what }): Found => ({ id, what, expression, body: false, operations: service.operations.filter((operation) => covers(policy, operation)) }))),
  ];
  const ids = new Map(found.map((f) => [f.expression, f.id]));
  const scopeName = entityLocal(service, "ServiceScope");
  // `actor` is the project's declared actor, as an entity's scope types it (`views/expressions.ts`); `input` the cast input.
  const scopeType = `$Scope<{ input: I; actor: $ActionContext extends infer C ? "actor" extends keyof C ? { [K in keyof C]-?: C[K] }["actor"] | (C extends { actor: unknown } ? never : undefined) : undefined : never; context: $ActionContext }>`;
  let shared = false;
  const inputOf = (operations: readonly Operation[]): string => {
    const locals = operations.map((operation) => names.get(operation)!.type);
    if (locals.length === 0) return "unknown";
    if (locals.length === 1) return locals[0]!;
    shared = true;
    return `$SharedInput<${locals.join(" | ")}>`;
  };

  // The imports the functions can name, by the name the service file gives each: helpers, `Mesh`, entities and
  // namespace aliases of entity files (a service file imports nothing else: the build refused it).
  const helperFrom = new Map<string, { from: string; imported: string; namespace?: true }>();
  for (const imported of service.imports)
    if (imported.helper)
      imported.identifiers.forEach((name, index) => helperFrom.set(name, { from: imported.from, imported: imported.imported?.[index] ?? name, ...(imported.namespace ? { namespace: true as const } : {}) }));
  const meshLocals = new Set(service.imports.filter((entry) => entry.mesh).flatMap((entry) => entry.identifiers));
  const targets = new Map<string, Entity>();
  const namespaceTargets = new Map<string, Entity[]>();
  for (const entry of service.imports) {
    if (entry.helper || entry.mesh) continue;
    const file = posix.normalize(posix.join(dirname(service.file), entry.from));
    entry.identifiers.forEach((local, index) => {
      const name = entry.imported?.[index] ?? local;
      const target = document.entities.find((candidate) => candidate.file === file && (entry.namespace || candidate.name === name));
      if (target && entry.namespace) namespaceTargets.set(local, [target]);
      else if (target) targets.set(local, target);
    });
  }
  const entitiesOf = (name: string): readonly Entity[] => namespaceTargets.get(name) ?? (targets.has(name) ? [targets.get(name)!] : []);
  // Entity values are bound as they are, not as the read-only views an action's step gets: what an operation's calls
  // resolve with goes back to application code (OD-8).
  const locals: EntityLocals = (name) => {
    const members = namespaceTargets.get(name);
    if (members) {
      const named = (local: (target: Entity) => string) => members.map((target) => `${typeName(target.name, target.position)}: ${local(target)}`);
      return {
        value: `{ ${named((target) => entityLocal(target, "value")).join(", ")} }`,
        type: `{ ${named((target) => `typeof ${entityLocal(target, "value")}`).map((member) => `readonly ${member}`).join("; ")} }`,
        record: "",
      };
    }
    const target = targets.get(name);
    if (!target) throw emitError("MESH_UNKNOWN_ENTITY", `Entity ${name} is not imported by ${service.file}`, service.position);
    return { value: entityLocal(target, "value"), type: `typeof ${entityLocal(target, "value")}`, record: entityLocal(target, "Record") };
  };

  const used = new Set<string>(found.flatMap(({ expression }) => expression.plain?.helpers ?? []));
  const unread = new Set([...helperFrom.keys()].filter((name) => !used.has(name)));
  const typed = new Set<string>();
  const valued = new Set<string>(found.flatMap(({ expression }) => expression.plain?.entities ?? []));
  const recordTypes = new Set<string>();
  const namespaceTypes = new Set<string>();
  const meshValues = new Set<string>(found.flatMap(({ expression }) => expression.plain?.mesh ?? []));
  const meshTypes = new Set<string>();
  const candidates = new Set([...unread, ...ROOTS, ...targets.keys(), ...namespaceTargets.keys(), ...meshLocals]);
  let emitted = emittedNothing();
  let usesExpr = false;
  const print = (f: Found, inTypes?: NamedInTypes) => {
    emitted = emittedNothing();
    return printExpression(f.expression, `${scopeName}<${inputOf(f.operations)}>`, !f.body, f.body, locals, inTypes, emitted);
  };
  // Every service function is plain (the build forces it), so each is printed with its authored text; what it names only
  // in a type is found in the printed function (`typeNames`), as for an entity's, and bound by a second print.
  const entries = found.map((f): ExpressionEntry => {
    let code = print(f);
    const { types, values } = typeNames(code, candidates);
    const inTypes: NamedInTypes = {
      roots: ROOTS.filter((name) => values.has(name)),
      values: [...values].filter((name) => (targets.has(name) || namespaceTargets.has(name)) && !helperFrom.has(name)).sort(),
      types: [...types].filter((name) => targets.has(name) && !helperFrom.has(name)).sort(),
    };
    for (const name of types) if (namespaceTargets.has(name) && !helperFrom.has(name)) namespaceTypes.add(name);
    for (const name of values) if (meshLocals.has(name)) meshTypes.add(name);
    for (const name of [...types, ...values]) if (unread.has(name)) typed.add(name);
    if (inTypes.roots.length || inTypes.values.length || inTypes.types.length) {
      inTypes.values.forEach((name) => valued.add(name));
      inTypes.types.forEach((name) => recordTypes.add(name));
      code = print(f, inTypes);
    }
    usesExpr ||= emitted.expr;
    return {
      key: JSON.stringify(f.id),
      comment: `${f.what}, plain (${f.expression.plain?.why ?? "service"}) (${f.expression.position.file}:${f.expression.position.line}:${f.expression.position.column + 1})`.replace(/[\r\n\u2028\u2029]/g, " "),
      code,
    };
  });
  const shadowsStructuredClone = found.some(({ expression }) => expression.plain?.structuredClone === true);

  // The entity imports: each value, and each record type a function names as a type, from the entity's actions file.
  const entityFrom = new Map<string, { names: Set<string>; value: boolean }>();
  for (const name of [...new Set([...valued, ...recordTypes, ...namespaceTypes])].sort()) {
    for (const target of entitiesOf(name)) {
      let from = relative(dirname(servicePath(service)), `${entityPath(target)}.actions`).replace(/\\/g, "/");
      if (!from.startsWith(".")) from = `./${from}`;
      const exported = typeName(target.name, target.position);
      const entry = entityFrom.get(from) ?? { names: new Set<string>(), value: false };
      if (valued.has(name)) { entry.names.add(`${exported} as ${entityLocal(target, "value")}`); entry.value = true; }
      if (recordTypes.has(name) || namespaceTypes.has(name)) entry.names.add(`type ${exported} as ${entityLocal(target, "Record")}`);
      entityFrom.set(from, entry);
    }
  }
  // The helper imports, rewritten relative to the generated file, as an entity's expressions file prints them.
  const byModule = new Map<string, string[]>();
  for (const name of [...used, ...typed].filter((n) => helperFrom.has(n)).sort()) {
    let from = posix.relative(dirname(generatedPath), posix.join(dirname(service.file), helperFrom.get(name)!.from));
    if (!from.startsWith(".")) from = `./${from}`;
    byModule.set(from, [...(byModule.get(from) ?? []), name]);
  }
  const helperImports = [...byModule].flatMap(([from, all]): HelperImport[] => {
    const named = (name: string) => {
      const { imported } = helperFrom.get(name)!;
      return imported === name ? name : `${IDENTIFIER.test(imported) ? imported : JSON.stringify(imported)} as ${name}`;
    };
    const namespaces = all.filter((name) => helperFrom.get(name)!.namespace).map((name): HelperImport => ({
      keyword: typed.has(name) && !used.has(name) ? "import type" : "import",
      bindings: `* as ${name}`,
      fromLiteral: JSON.stringify(from),
    }));
    const plain = all.filter((name) => !helperFrom.get(name)!.namespace);
    if (!plain.length) return namespaces;
    const typeOnly = plain.every((name) => typed.has(name));
    return [{
      keyword: typeOnly ? "import type" : "import",
      bindings: `{ ${plain.map((name) => (!typeOnly && typed.has(name) ? `type ${named(name)}` : named(name))).join(", ")} }`,
      fromLiteral: JSON.stringify(from),
    }, ...namespaces];
  });

  const operations = service.operations.map((operation): ServiceOperation => {
    const covering = service.policies.filter((policy) => covers(policy, operation));
    const uses = operation.uses.filter((use) => use.fqn !== undefined)
      .map((use) => `${JSON.stringify(use.fqn)}: [${use.actions.map((action) => JSON.stringify(action.name)).join(", ")}]`);
    return {
      key: propertyName(operation.name),
      nameLiteral: JSON.stringify(operation.name),
      inputLocal: names.get(operation)!.type,
      schemaLocal: names.get(operation)!.schema,
      policies: policySpecs(covering, (expression) => `$expressions[${JSON.stringify(ids.get(expression)!)}]`, "write"),
      uses: `{ ${uses.join(", ")} }`,
      body: `$expressions[${JSON.stringify(`${operation.name}.run`)}]`,
    };
  });
  const runtimeValues = [
    "service as $service",
    ...(usesExpr ? ["expr as $"] : []),
    ...(shadowsStructuredClone ? ["cloneValue as $cloneValue"] : []),
    ...[...new Set([...meshValues, ...meshTypes])].sort().map((name) => `${meshValues.has(name) ? "" : "type "}Mesh${name === "Mesh" ? "" : ` as ${name}`}`),
  ];
  const view = {
    serviceFile: entityFileComment(service),
    name: typeName(service.name, service.position),
    fqnLiteral: JSON.stringify(service.fqn),
    valueLocal: entityLocal(service, "service"),
    runtimeValues,
    usesSharedInput: shared,
    inputsFromLiteral: JSON.stringify(`./${entitySegment(service)}.inputs`),
    inputTypeImports: [...names.values()].map(({ name, type }) => `${name} as ${type}`),
    inputValueImports: [...names.values()].map(({ constName, schema }) => `${constName} as ${schema}`),
    helperImports,
    entityImports: [...entityFrom].sort(([a], [b]) => compareText(a, b)).map(([from, { names: imported, value }]) => ({
      keyword: value ? "import" as const : "import type" as const,
      names: [...imported].map((name) => (value ? name : name.replace(/^type /, ""))).join(", "),
      fromLiteral: JSON.stringify(from),
    })),
    entityNamespaces: [...namespaceTypes].sort().map((name) => ({
      name,
      members: (namespaceTargets.get(name) ?? []).map((target) => `export type ${typeName(target.name, target.position)} = ${entityLocal(target, "Record")};`).join(" "),
    })),
    scopeName,
    scopeType,
    entries,
    operations,
  };
  // The method's result is the body's (`$Returns`, declared in the file), so the file names no global of its own; a
  // project's template that prints one gets it from `$globals.ts`.
  return { ...view, globals: globalsImport(`${servicePath(service)}.service`, { scopeType, operations }) };
}
