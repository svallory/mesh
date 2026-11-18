import { relative } from "node:path";
import type { EmitInput } from "../emit.ts";
import { compareText } from "../emitters/order.ts";
import { handlerOwners, handlersLocal, handlersPath } from "./handlers.ts";
import { DOMAIN_FOLDER } from "./inputs.ts";

/**
 * What `binding.ts.jig` renders: `.mesh/binding.ts`, Mesh's own file that binds the domain. It holds `bind`, which
 * hands the root barrel to `@meshfw/runtime`'s `bindDomain` (which walks it and binds every entity value it reaches)
 * with the project's async frame, the one `AsyncLocalStorage` that keeps a binding in scope (the only host
 * import in generated code), the default binding `connect()` opens and `disconnect()` closes, the top-level
 * `transaction`, `query` when the data adapter declares `raw-sql`, and the `Binding` type. `#mesh` (`.mesh/index.ts`) re-exports them. Every string is final; the template prints, loops and
 * branches on these fields and computes nothing. A project's own `binding.ts.jig` depends on this shape.
 */
export interface BindingView {
  /** The relative module specifier of `mesh.config.ts` from the output folder, quoted, e.g. `"../mesh.config"`. */
  readonly configFromLiteral: string;
  /** The root barrel from the output folder, quoted: `"./domain/index"`. */
  readonly domainFromLiteral: string;
  /**
   * True when the project declares an event (M6): the file then exports `published` and `readEvents`, and `connect()`
   * passes the config's `events` to the binding and loads the events module; false leaves the file as it was.
   */
  readonly events: boolean;
  /**
   * True when the project declares an event and the configured bus declares `replay`: the file then exports
   * `readEvents` (spec, Events and commands, "Capabilities").
   */
  readonly replay: boolean;
  /** True when the project declares an event and the configured bus declares `subscribe`: the file then exports `subscribe`. */
  readonly subscribe: boolean;
  /**
   * True when the project declares an event and the configured bus declares `multi-process` (delivery from several
   * processes): the file then exports `adoptHandler`.
   */
  readonly multiProcess: boolean;
  /**
   * True when the project declares an event and the configured bus declares `dead-letters`: the file then exports
   * `retryFailed`, which replays a handler's set-aside events.
   */
  readonly deadLetters: boolean;
  /**
   * True when the data adapter's manifest declares `raw-sql` (ADR-0087): the file then exports `query`, one read-only SQL
   * statement written by hand; false leaves the file as it was.
   */
  readonly rawSql: boolean;
  /**
   * One per entity or aggregate whose `handlers` section has a line, by path: its handlers file, quoted
   * (`"./domain/billing/invoice.handlers"`), and the local its `$handlers` is imported under (`$billing$Invoice$handlers`).
   * `bind` hands them to `bindDomain` merged (`mergeHandlers`); empty leaves the file as it was.
   */
  readonly handlerModules: readonly { readonly fromLiteral: string; readonly local: string }[];
  /** The locals of `handlerModules` as the array `mergeHandlers` takes: `[$billing$Invoice$handlers]`. */
  readonly handlersLiteral: string;
}

/** A module specifier relative to the output folder, quoted: `"./domain/blog/post.actions"`. */
export const quote = (path: string) => JSON.stringify(path.startsWith(".") ? path : `./${path}`);

/** True when the configured data adapter's manifest declares `raw-sql`: `#mesh` then exports `query`. */
export const declaresRawSql = (input: EmitInput): boolean =>
  ((input.config.data.capabilities?.capabilities ?? []) as readonly string[]).includes("raw-sql");

/** The binding view of the whole model. Pure and synchronous. */
export function bindingView(input: EmitInput): BindingView {
  const { config } = input;
  const handlerModules = handlerOwners(input.document)
    .map((owner) => ({ path: handlersPath(owner), local: handlersLocal(owner) }))
    .sort((a, b) => compareText(a.path, b.path))
    .map(({ path, local }) => ({ fromLiteral: quote(path), local }));
  const events = (input.document.events?.length ?? 0) > 0;
  const capabilities: readonly string[] = config.events?.bus?.manifest.capabilities ?? [];
  const configModule = relative(config.output, config.configFile).replace(/\\/g, "/").replace(/\.ts$/, "");
  return {
    configFromLiteral: quote(configModule),
    domainFromLiteral: quote(`${DOMAIN_FOLDER}/index`),
    events,
    replay: events && capabilities.includes("replay"),
    subscribe: events && capabilities.includes("subscribe"),
    multiProcess: events && capabilities.includes("multi-process"),
    deadLetters: events && capabilities.includes("dead-letters"),
    rawSql: declaresRawSql(input),
    handlerModules,
    handlersLiteral: `[${handlerModules.map(({ local }) => local).join(", ")}]`,
  };
}
