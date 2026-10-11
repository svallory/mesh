import type { EmitInput } from "../emit.ts";
import { orderedEntities } from "../emitters/order.ts";
import { moduleSpecifier } from "./inputs.ts";
import { modulesOf } from "./module.ts";

/**
 * What `index.ts.jig` renders: `.mesh/index.ts`, which a project imports as `#mesh` (ADR-0047, ADR-0058). It holds
 * only the framework's exports: `bind`, `connect`, `disconnect` and `transaction` from `./binding`, the types of
 * `actions` and `tx` from `./composition`, and the adapter's `tables` from `./schema`. An entity's action functions and
 * types are its module's (`#mesh/domain/<module>`, CMP-17), never re-exported here. Every string is final; the
 * template prints and loops. A project's own `index.ts.jig` depends on this shape.
 */
export interface IndexView {
  /** The import specifier of every module that holds an entity, by module path, e.g. `#mesh/domain/blog`: named in the header only. */
  readonly modules: readonly string[];
}

/** The index view of the whole model. Pure and synchronous. */
export function indexView(input: EmitInput): IndexView {
  return { modules: modulesOf(orderedEntities(input.document)).map(({ module }) => moduleSpecifier(module)) };
}
