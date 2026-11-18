import { readFileSync } from "node:fs";
import { MESH_EXTENSIONS } from "./extensions.ts";

/**
 * The mixins Mesh ships (`notes/spec/other-file-kinds.md`, "Mixin files"; ruling D37, OD1): an entity file imports them by
 * name from this package path (`import { Timestamps } from "meshfw/mixins"`) and includes one with `use mixin=Timestamps`.
 * The path is resolved by the compiler, not by a package export (OD9): MX passes imports through, and generated code never
 * imports a mixin.
 */
export const MESHFW_MIXINS = "meshfw/mixins";

/** Each shipped mixin's name, as its file declares it, and its file in `src/mixins/` (`timestamps` and the entity file extension). */
const FILES = { Timestamps: `timestamps${MESH_EXTENSIONS[0]}`, Versioned: `versioned${MESH_EXTENSIONS[0]}` } as const;

/** The names `"meshfw/mixins"` gives, in the order messages list them. */
export const SHIPPED_MIXIN_NAMES: readonly string[] = Object.freeze(Object.keys(FILES));

/**
 * The text of the shipped mixin `name`, with the name its lines are lowered under (`meshfw/mixins/<file>`: no file of the
 * project, so MX compares no dialect mark against a `package.json`), or undefined for a name the path does not give. Read
 * from disk on each call; the builder parses it once and caches the result.
 */
export function shippedMixinText(name: string): { source: string; file: string } | undefined {
  if (!Object.hasOwn(FILES, name)) return undefined;
  const file = FILES[name as keyof typeof FILES];
  return { source: readFileSync(new URL(`../mixins/${file}`, import.meta.url), "utf8"), file: `${MESHFW_MIXINS}/${file}` };
}
