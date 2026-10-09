import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { Generator } from "./emit.ts";
import type { Template } from "./render.ts";

/** Mesh's own templates, shipped in the package next to `src/`. */
export const MESH_TEMPLATES_DIR = resolve(import.meta.dir, "../templates");

/** The template each generator renders, keyed by template file name. */
export type Templates = ReadonlyMap<string, Template>;

/** Read the template of every generator, once per build. */
export async function loadTemplates(generators: readonly Generator[]): Promise<Templates> {
  const templates = new Map<string, Template>();
  for (const { template } of generators) {
    const path = join(MESH_TEMPLATES_DIR, template);
    templates.set(template, { path, contents: await readFile(path, "utf8") });
  }
  return templates;
}
