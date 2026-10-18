import type { EmitInput } from "../emit.ts";
import { orderedEntities } from "../emitters/order.ts";
import { classLocal, className, declarationPath, declarationsOf } from "./declarations.ts";
import { globalsImport, type GlobalsImport } from "./globals.ts";
import { moduleSpecifier } from "./inputs.ts";
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

/** The index view of the whole model. Pure and synchronous. */
export function indexView(input: EmitInput): IndexView {
  const declarations = declarationsOf(input.document);
  const modules = modulesOf(orderedEntities(input.document), declarations).map(({ module }) => moduleSpecifier(module));
  const events = declarations.filter((declaration) => declaration.kind === "event");
  if (events.length === 0) return { modules, events: null };
  const view = {
    imports: events.map((event) => ({ name: className(event), local: classLocal(event), fromLiteral: JSON.stringify(`./${declarationPath(event)}`) })),
    union: events.map(classLocal).join(" | "),
    table: events.map((event) => ({ fqnLiteral: JSON.stringify(event.fqn), local: classLocal(event) })),
  };
  const capabilities: readonly string[] = input.config.events?.bus?.manifest.capabilities ?? [];
  return { modules, events: {
    ...view, globals: globalsImport("index", view, ["Object"])!,
    replay: capabilities.includes("replay"), subscribe: capabilities.includes("subscribe"),
    busCapabilities: capabilities.map((capability) => JSON.stringify(capability)),
  } };
}
