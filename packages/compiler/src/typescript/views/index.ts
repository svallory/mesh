import type { EmitInput } from "../emit.ts";
import { orderedEntities } from "../emitters/order.ts";
import { classLocal, className, declarationPath, declarationsOf } from "./declarations.ts";
import { globalsImport, type GlobalsImport } from "./globals.ts";
import { entityLocal, entityPath, moduleSpecifier, propertyName, typeName } from "./inputs.ts";
import { modulesOf } from "./module.ts";

/**
 * What `index.ts.jig` renders: `.mesh/index.ts`, which a project imports as `#mesh` (ADR-0047, ADR-0058). It holds
 * only the framework's exports: `bind`, `connect`, `disconnect`, `transaction` and the `Binding` type from `./binding`,
 * the type `Privileged` from `@meshfw/runtime` (`Mesh.privileged` itself comes from `meshfw`), and the adapter's `tables` from `./schema`,
 * and, in a project that declares an event, the type `DomainEvent` and the table `eventClasses` (M6). An entity's value and
 * types are its module's (`#mesh/domain/<module>`), never re-exported here. Every string is final; the
 * template prints and loops. A project's own `index.ts.jig` depends on this shape.
 */
export interface IndexView {
  /** The import specifier of every module that holds an entity, an event or a command, by module path, e.g. `#mesh/domain/blog`: named in the header only. */
  readonly modules: readonly string[];
  /** The events of the project; `null` when it declares none, so the file is as it was. */
  readonly events: IndexEvents | null;
  /** The commands an action answers; `null` when none does, so the file is as it was. */
  readonly commands: IndexCommands | null;
}

/** What `#mesh` holds for the commands an action answers (`on=`): `dispatch`, and the types of its argument and result. */
export interface IndexCommands {
  /** One import per entity that answers a command: its value, from the entity's actions file. */
  readonly entities: readonly { readonly name: string; readonly local: string; readonly fromLiteral: string }[];
  /** One import per answered command class, under the local that names it in this file. */
  readonly imports: readonly { readonly name: string; readonly local: string; readonly fromLiteral: string }[];
  /** `DomainCommand` as printed: the union of the instance types of the answered command classes. */
  readonly union: string;
  /** One entry per answered command: the class local, the entity's local and the action's name, for `DispatchResult`. */
  readonly results: readonly { readonly command: string; readonly entity: string; readonly action: string }[];
  /** One entry per answered command: the FQN as a quoted string literal, the class local, the input object built from the command's fields (`{ id: command.id }`), and the call. */
  readonly table: readonly { readonly fqnLiteral: string; readonly command: string; readonly param: string; readonly input: string; readonly entity: string; readonly action: string }[];
  /** The globals the file names (`$Promise`), when `events` does not already import them. */
  readonly globals: GlobalsImport | null;
}

/** What `#mesh` holds for a project's events: `DomainEvent` and the table from FQN to class. */
export interface IndexEvents {
  /** One import per event class, under the local that names it in this file. */
  readonly imports: readonly { readonly name: string; readonly local: string; readonly fromLiteral: string }[];
  /** `DomainEvent` as printed, the union of every event class's instance type, e.g. `$billing$InvoicePaid$class | $billing$InvoiceVoided$class`. */
  readonly union: string;
  /** One entry per event class: the FQN as a quoted string literal and the local that holds the class. */
  readonly table: readonly { readonly fqnLiteral: string; readonly local: string }[];
  /** The globals the file names (`$Object`), from `$globals.ts`. */
  readonly globals: GlobalsImport;
  /** True when the configured bus declares `replay`: `readEvents` is exported. */
  readonly replay: boolean;
  /** True when the configured bus declares `subscribe`: `subscribe` is exported. */
  readonly subscribe: boolean;
  /**
   * The bus's capabilities as quoted string literals, in its manifest's order: each becomes a `true` member of
   * `EventBusCapabilities` (`declare module "@meshfw/runtime"`), so a handler option the bus cannot honour is a type error.
   */
  readonly busCapabilities: readonly string[];
}

/** The commands an action answers, for `dispatch`: each command with the entity and the action that answer it, in the order of the command files. */
function commandsView(input: EmitInput, declarations: ReturnType<typeof declarationsOf>, globalsFromEvents: boolean): IndexCommands | null {
  const answers = declarations.filter((declaration) => declaration.kind === "command").flatMap((command) => {
    for (const entity of input.document.entities)
      for (const action of entity.actions) if (action.command?.fqn === command.fqn) return [{ command, entity, action }];
    return [];
  });
  if (answers.length === 0) return null;
  const entities = new Map(answers.map(({ entity }) => [entity.fqn, entity] as const));
  const view = {
    entities: [...entities.values()].map((entity) => ({ name: typeName(entity.name, entity.position), local: entityLocal(entity, "value"), fromLiteral: JSON.stringify(`./${entityPath(entity)}.actions`) })),
    imports: answers.map(({ command }) => ({ name: className(command), local: classLocal(command), fromLiteral: JSON.stringify(`./${declarationPath(command)}`) })),
    union: answers.map(({ command }) => classLocal(command)).join(" | "),
    results: answers.map(({ command, entity, action }) => ({ command: classLocal(command), entity: entityLocal(entity, "value"), action: action.name })),
    table: answers.map(({ command, entity, action }) => ({
      fqnLiteral: JSON.stringify(command.fqn),
      command: classLocal(command),
      // a command with no fields leaves its parameter unread, which the strictest flags (`noUnusedParameters`) refuse
      param: command.fields.length ? "command" : "_command",
      input: `{ ${command.fields.map((field) => {
        const access = `command${/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(field.name) ? `.${field.name}` : `[${JSON.stringify(field.name)}]`}`;
        const property = `${propertyName(field.name)}: ${access}`;
        // A command's optional field keeps undefined. Do not turn omission into null or an own undefined input.
        return field.nullable || field.optional ? `...(${access} === undefined ? {} : { ${property} })` : property;
      }).join(", ")} }`,
      entity: entityLocal(entity, "value"),
      action: action.name,
    })),
  };
  return { ...view, globals: globalsFromEvents ? null : globalsImport("index", view, ["Promise"]) };
}

/** The index view of the whole model. Pure and synchronous. */
export function indexView(input: EmitInput): IndexView {
  const declarations = declarationsOf(input.document);
  const modules = modulesOf(orderedEntities(input.document), declarations).map(({ module }) => moduleSpecifier(module));
  const events = declarations.filter((declaration) => declaration.kind === "event");
  const commands = commandsView(input, declarations, events.length > 0);
  if (events.length === 0) return { modules, events: null, commands };
  const view = {
    imports: events.map((event) => ({ name: className(event), local: classLocal(event), fromLiteral: JSON.stringify(`./${declarationPath(event)}`) })),
    union: events.map(classLocal).join(" | "),
    table: events.map((event) => ({ fqnLiteral: JSON.stringify(event.fqn), local: classLocal(event) })),
  };
  const capabilities: readonly string[] = input.config.events?.bus?.manifest.capabilities ?? [];
  return { modules, commands, events: {
    ...view, globals: globalsImport("index", view, commands ? ["Object", "Promise"] : ["Object"])!,
    replay: capabilities.includes("replay"), subscribe: capabilities.includes("subscribe"),
    busCapabilities: capabilities.map((capability) => JSON.stringify(capability)),
  } };
}
