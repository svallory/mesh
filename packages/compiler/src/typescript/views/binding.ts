import { relative } from "node:path";
import type { EmitInput } from "../emit.ts";
import { DOMAIN_FOLDER } from "./inputs.ts";

/**
 * What `binding.ts.jig` renders: `.mesh/binding.ts`, Mesh's own file that binds the domain. It holds `bind`, which
 * hands the root barrel to `@meshfw/runtime`'s `bindDomain` (which walks it and binds every entity value it reaches)
 * with the project's async frame, the one `AsyncLocalStorage` that keeps a binding in scope (the only host
 * import in generated code), the default binding `connect()` opens and `disconnect()` closes, the top-level
 * `transaction`, and the `Binding` type. `#mesh` (`.mesh/index.ts`) re-exports them. Every string is final; the template prints, loops and
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
}

/** A module specifier relative to the output folder, quoted: `"./domain/blog/post.actions"`. */
export const quote = (path: string) => JSON.stringify(path.startsWith(".") ? path : `./${path}`);

/** The binding view of the whole model. Pure and synchronous. */
export function bindingView(input: EmitInput): BindingView {
  const { config } = input;
  const configModule = relative(config.output, config.configFile).replace(/\\/g, "/").replace(/\.ts$/, "");
  return {
    configFromLiteral: quote(configModule),
    domainFromLiteral: quote(`${DOMAIN_FOLDER}/index`),
    events: (input.document.events?.length ?? 0) > 0,
  };
}
