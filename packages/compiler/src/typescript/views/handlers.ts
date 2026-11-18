import { dirname, posix, relative } from "node:path";
import type { Aggregate, Entity, HandlerDeclaration } from "@meshfw/model";
import type { EmitInput } from "../emit.ts";
import { emitError } from "../emit-error.ts";
import { compareText } from "../emitters/order.ts";
import { emittedNothing, printExpression, type EntityLocals, type NamedInTypes } from "../expression-printer.ts";
import { typeNames } from "../type-names.ts";
import { classLocal, className, declarationPath, declarationsOf, type Declaration } from "./declarations.ts";
import type { HelperImport } from "./expressions.ts";
import { globalsImport, type GlobalsImport } from "./globals.ts";
import { entityLocal, entityPath, typeName } from "./inputs.ts";
import { entityFileComment } from "./types.ts";

/**
 * The file of an owner's `handlers` section (handlers design, sections 5.5 and 7; ruling D44): `<owner>.handlers.ts`
 * beside the owner's other generated files, exporting `$handlers`, the section's handlers by kind and key with where
 * each is written, which the generated `bind` merges (`mergeHandlers`) and hands to `bindDomain`. An owner is an entity
 * or an aggregate; nothing is generated for one without a handler line.
 */

/** An owner of a `handlers` section: an entity or an aggregate. */
export type HandlerOwner = Entity | Aggregate;

/** The scope roots of a handler body: the event and the context it runs with (rule H12). */
const ROOTS = ["event", "context"] as const;
/** A name an import can print bare; any other export name is printed as a string literal (`import { "a-b" as ab }`). */
const IDENTIFIER = /^[\p{ID_Start}$_][\p{ID_Continue}$\u200C\u200D]*$/u;

/** The owner's generated handlers file below the output directory, without the extension: `domain/billing/invoice.handlers`. */
export const handlersPath = (owner: HandlerOwner): string => `${entityPath(owner)}.handlers`;

/** The local the binding imports an owner's `$handlers` under: `$billing$Invoice$handlers`. */
export const handlersLocal = (owner: HandlerOwner): string => entityLocal(owner, "handlers");

/** The owners whose `handlers` section has a line, entities then aggregates, each group by file. */
export function handlerOwners(document: EmitInput["document"]): HandlerOwner[] {
  const byFile = (a: HandlerOwner, b: HandlerOwner) => compareText(a.file, b.file);
  return [
    ...document.entities.filter((entity) => entity.handlers?.length).sort(byFile),
    ...(document.aggregates ?? []).filter((aggregate) => aggregate.handlers?.length).sort(byFile),
  ];
}

/** One handler of the section, as `$handlers` lists it under its kind. */
export interface HandlerEntry {
  /** What it is and where it is written: the kind, the name and the file, line and column. */
  readonly comment: string;
  /** The key, quoted: `"billing.Invoice.receipt"`. */
  readonly keyLiteral: string;
  /** Where it is written (file, line and column), quoted, as the start errors name it. */
  readonly atLiteral: string;
  /** The listed events' classes as the array `events` takes, in written order: `[$billing$InvoicePaid$class]`. */
  readonly eventsLiteral: string;
  /** The body's scope type, over the union of the listed events: `$HandlerScope<$billing$InvoicePaid$class>`. */
  readonly scopeType: string;
  /** The body, printed as a plain function of that scope: `($s: ...) => { ...; return (function ...)($s); }`. */
  readonly code: string;
  /** `renamed-from=` as the former key, quoted (`"billing.Invoice.mailReceipt"`); null without one. */
  readonly renamedFromLiteral: string | null;
}

/**
 * What `handlers.ts.jig` renders for one owner. Every string is final; the template prints and loops. A project's own
 * `handlers.ts.jig` depends on this shape.
 */
export interface HandlersView {
  /** The owner's file, project-relative, line terminators escaped as `\uXXXX`. */
  readonly ownerFile: string;
  /** The owner's FQN, for the comments: `billing.Invoice`. */
  readonly ownerFqn: string;
  /** What the file imports from `@meshfw/runtime` as values, as printed inside the braces: `handler as $handler`, `Mesh`, `cloneValue as $cloneValue`. */
  readonly runtimeValues: readonly string[];
  /** The owner file's helper imports the bodies name, one per module, under the names the owner file gives them. */
  readonly helperImports: readonly HelperImport[];
  /** The entity values (`Invoice as $billing$Invoice$value, type $ReadOnly as $billing$Invoice$ReadOnly`) and record types the bodies name, one import per entity's actions file. */
  readonly entityImports: readonly { keyword: "import" | "import type"; names: string; fromLiteral: string }[];
  /** The event and command classes the file names, one import per declaration's file: the listed events, and those a body names. */
  readonly classImports: readonly { keyword: "import" | "import type"; names: string; fromLiteral: string }[];
  /** A namespace import of entity files the bodies name in a type: `declare namespace b { export type Invoice = $billing$Invoice$Record; }`. */
  readonly entityNamespaces: readonly { name: string; members: string }[];
  /** The `process` handlers, then the `listen` ones, each in the order of the section. */
  readonly processHandlers: readonly HandlerEntry[];
  readonly listenHandlers: readonly HandlerEntry[];
  /** The globals the file names (`$Promise`), from `$globals.ts`; null when it names none. */
  readonly globals: GlobalsImport | null;
}

/** The view of one owner's handlers file. Pure and synchronous. */
export function handlersView({ document }: EmitInput, owner: HandlerOwner, generatedPath: string): HandlersView {
  const handlers: readonly HandlerDeclaration[] = owner.handlers ?? [];
  const declared = declarationsOf(document);
  const byFqn = new Map(declared.map((declaration) => [declaration.fqn, declaration]));
  const isEntity = (candidate: HandlerOwner): candidate is Entity => "attributes" in candidate;

  // The imports the bodies can name, by the name the owner file gives each: helpers, `Mesh`, entities (an entity's own
  // name included), events and commands, and namespace aliases of their files.
  const helperFrom = new Map<string, { from: string; imported: string; namespace?: true }>();
  for (const imported of owner.imports)
    if (imported.helper)
      imported.identifiers.forEach((name, index) => helperFrom.set(name, { from: imported.from, imported: imported.imported?.[index] ?? name, ...(imported.namespace ? { namespace: true as const } : {}) }));
  const meshLocals = new Set(owner.imports.filter((entry) => entry.mesh).flatMap((entry) => entry.identifiers));
  const targets = new Map<string, Entity>();
  const namespaceTargets = new Map<string, Entity[]>();
  const eventTargets = new Map<string, Declaration>();
  const eventNamespaces = new Map<string, Declaration[]>();
  if (isEntity(owner)) targets.set(owner.name, owner);
  for (const target of declared) if (target.file === owner.file) eventTargets.set(className(target), target);
  for (const entry of owner.imports) {
    if (entry.helper || entry.mesh) continue;
    const file = posix.normalize(posix.join(dirname(owner.file), entry.from));
    const inFile = declared.filter((candidate) => candidate.file === file);
    entry.identifiers.forEach((local, index) => {
      const name = entry.imported?.[index] ?? local;
      const target = document.entities.find((candidate) => candidate.file === file && (entry.namespace || candidate.name === name));
      if (target && entry.namespace) namespaceTargets.set(local, [target]);
      else if (target) targets.set(local, target);
      if (entry.namespace) { if (inFile.length) eventNamespaces.set(local, inFile); }
      else {
        const event = inFile.find((candidate) => className(candidate) === name);
        if (event) eventTargets.set(local, event);
      }
    });
  }
  const entitiesOf = (name: string): readonly Entity[] => namespaceTargets.get(name) ?? (targets.has(name) ? [targets.get(name)!] : []);
  // An entity is bound as a read-only view of its value, as a run step's is; a class is bound to itself; a namespace
  // alias to one object of its file's entity values and classes.
  const locals: EntityLocals = (name) => {
    const event = eventTargets.get(name);
    if (event) return { value: classLocal(event), type: `typeof ${classLocal(event)}`, record: classLocal(event) };
    const classes = eventNamespaces.get(name) ?? [];
    const members = namespaceTargets.get(name) ?? [];
    if (classes.length || members.length) {
      const named = (local: (target: Entity) => string) => members.map((target) => `${typeName(target.name, target.position)}: ${local(target)}`);
      return {
        value: `{ ${[...named((target) => entityLocal(target, "value")), ...classes.map((target) => `${className(target)}: ${classLocal(target)}`)].join(", ")} }`,
        type: `{ ${[...named((target) => entityLocal(target, "ReadOnly")), ...classes.map((target) => `${className(target)}: typeof ${classLocal(target)}`)].map((member) => `readonly ${member}`).join("; ")} }`,
        record: "",
      };
    }
    const target = targets.get(name);
    if (!target) throw emitError("MESH_UNKNOWN_ENTITY", `Entity ${name} is not imported by ${owner.file}`, owner.position);
    return { value: entityLocal(target, "value"), type: entityLocal(target, "ReadOnly"), record: entityLocal(target, "Record") };
  };

  const used = new Set<string>(handlers.flatMap(({ run }) => run.plain?.helpers ?? []));
  const unread = new Set([...helperFrom.keys()].filter((name) => !used.has(name)));
  const typed = new Set<string>();
  const valued = new Set<string>(handlers.flatMap(({ run }) => [...(run.plain?.entities ?? []), ...(run.plain?.events ?? [])]));
  const recordTypes = new Set<string>();
  const namespaceTypes = new Set<string>();
  const meshValues = new Set<string>(handlers.flatMap(({ run }) => run.plain?.mesh ?? []));
  const meshTypes = new Set<string>();
  const candidates = new Set([...unread, ...ROOTS, ...targets.keys(), ...namespaceTargets.keys(), ...eventTargets.keys(), ...eventNamespaces.keys(), ...meshLocals]);
  // The classes the file imports: each listed event's as a value (`events: [...]`), and each one a body names.
  const classFrom = new Map<string, { local: string; exported: string; value: boolean }>();
  const classOf = (target: Declaration, asValue: boolean) => {
    let from = relative(dirname(entityPath(owner)), declarationPath(target)).replace(/\\/g, "/");
    if (!from.startsWith(".")) from = `./${from}`;
    const found = classFrom.get(from) ?? { local: classLocal(target), exported: className(target), value: false };
    found.value ||= asValue;
    classFrom.set(from, found);
  };

  const entryOf = (handler: HandlerDeclaration): HandlerEntry => {
    const classes = handler.events.map((ref) => {
      const target = byFqn.get(ref.fqn);
      if (!target || target.kind !== "event") throw emitError("MESH_UNKNOWN_EVENT", `${ref.identifier} is not an event of this project`, ref.position);
      classOf(target, true);
      return classLocal(target);
    });
    const scopeType = `$HandlerScope<${classes.join(" | ")}>`;
    let emitted = emittedNothing();
    const print = (inTypes?: NamedInTypes) => {
      emitted = emittedNothing();
      return printExpression(handler.run, scopeType, false, true, locals, inTypes, emitted, "", ROOTS);
    };
    // A body is always plain, so it is printed with its authored text; what it names only in a type is found in the
    // printed function (`typeNames`) and bound by a second print, as for an entity's run step.
    let code = print();
    const { types, values } = typeNames(code, candidates);
    const inTypes: NamedInTypes = {
      roots: ROOTS.filter((name) => values.has(name)),
      values: [...values].filter((name) => (targets.has(name) || namespaceTargets.has(name) || eventTargets.has(name) || eventNamespaces.has(name)) && !(ROOTS as readonly string[]).includes(name) && !helperFrom.has(name)).sort(),
      types: [...types].filter((name) => (targets.has(name) || eventTargets.has(name)) && !helperFrom.has(name)).sort(),
    };
    for (const name of types) if ((namespaceTargets.has(name) || eventNamespaces.has(name)) && !helperFrom.has(name)) namespaceTypes.add(name);
    for (const name of values) if (meshLocals.has(name) && !(ROOTS as readonly string[]).includes(name)) meshTypes.add(name);
    for (const name of [...types, ...[...values].filter((name) => !(ROOTS as readonly string[]).includes(name))]) if (unread.has(name)) typed.add(name);
    if (inTypes.roots.length || inTypes.values.length || inTypes.types.length) {
      inTypes.values.forEach((name) => valued.add(name));
      inTypes.types.forEach((name) => recordTypes.add(name));
      code = print(inTypes);
    }
    const at = `${handler.position.file}:${handler.position.line}:${handler.position.column + 1}`;
    return {
      comment: `${handler.kind} :${handler.name} (${at})`.replace(/[\r\n\u2028\u2029]/g, " "),
      keyLiteral: JSON.stringify(handler.key),
      atLiteral: JSON.stringify(at),
      eventsLiteral: `[${classes.join(", ")}]`,
      scopeType,
      code,
      renamedFromLiteral: handler.renamedFrom === undefined ? null : JSON.stringify(handler.renamedFrom),
    };
  };
  const processHandlers = handlers.filter((handler) => handler.kind === "process").map(entryOf);
  const listenHandlers = handlers.filter((handler) => handler.kind === "listen").map(entryOf);
  for (const name of [...new Set([...valued, ...recordTypes, ...namespaceTypes])].sort()) {
    const event = eventTargets.get(name);
    for (const target of event ? [event] : eventNamespaces.get(name) ?? []) classOf(target, valued.has(name));
  }

  // The entity imports: each value with its read-only type, and each record type a body names as a type, from the
  // entity's actions file.
  const entityFrom = new Map<string, { names: Set<string>; value: boolean }>();
  for (const name of [...new Set([...valued, ...recordTypes, ...namespaceTypes])].sort()) {
    for (const target of entitiesOf(name)) {
      let from = relative(dirname(entityPath(owner)), `${entityPath(target)}.actions`).replace(/\\/g, "/");
      if (!from.startsWith(".")) from = `./${from}`;
      const exported = typeName(target.name, target.position);
      const entry = entityFrom.get(from) ?? { names: new Set<string>(), value: false };
      if (valued.has(name)) { entry.names.add(`${exported} as ${entityLocal(target, "value")}`).add(`type $ReadOnly as ${entityLocal(target, "ReadOnly")}`); entry.value = true; }
      if (recordTypes.has(name) || namespaceTypes.has(name)) entry.names.add(`type ${exported} as ${entityLocal(target, "Record")}`);
      entityFrom.set(from, entry);
    }
  }
  // The helper imports, rewritten relative to the generated file, as an entity's expressions file prints them.
  const byModule = new Map<string, string[]>();
  for (const name of [...used, ...typed].filter((n) => helperFrom.has(n)).sort()) {
    let from = posix.relative(dirname(generatedPath), posix.join(dirname(owner.file), helperFrom.get(name)!.from));
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
  const shadowsStructuredClone = handlers.some(({ run }) => run.plain?.structuredClone === true);
  const runtimeValues = [
    "handler as $handler",
    ...(shadowsStructuredClone ? ["cloneValue as $cloneValue"] : []),
    ...[...new Set([...meshValues, ...meshTypes])].sort().map((name) => `${meshValues.has(name) ? "" : "type "}Mesh${name === "Mesh" ? "" : ` as ${name}`}`),
  ];
  const view = {
    ownerFile: entityFileComment(owner),
    ownerFqn: owner.fqn,
    runtimeValues,
    helperImports,
    entityImports: [...entityFrom].sort(([a], [b]) => compareText(a, b)).map(([from, { names: imported, value }]) => ({
      keyword: value ? "import" as const : "import type" as const,
      names: [...imported].map((name) => (value ? name : name.replace(/^type /, ""))).join(", "),
      fromLiteral: JSON.stringify(from),
    })),
    classImports: [...classFrom].sort(([a], [b]) => compareText(a, b)).map(([from, { local, exported, value }]) => ({
      keyword: value ? "import" as const : "import type" as const,
      names: `${exported} as ${local}`,
      fromLiteral: JSON.stringify(from),
    })),
    entityNamespaces: [...namespaceTypes].sort().map((name) => ({
      name,
      members: [
        ...(namespaceTargets.get(name) ?? []).map((target) => `export type ${typeName(target.name, target.position)} = ${entityLocal(target, "Record")};`),
        ...(eventNamespaces.get(name) ?? []).map((target) => `export type ${className(target)} = ${classLocal(target)};`),
      ].join(" "),
    })),
    processHandlers,
    listenHandlers,
  };
  return { ...view, globals: globalsImport(handlersPath(owner), { processHandlers, listenHandlers }) };
}
