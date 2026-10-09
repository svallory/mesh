import { lstat, open, readFile } from "node:fs/promises";
import { constants, type Stats } from "node:fs";
import { join, resolve } from "node:path";
import type { Generator } from "./emit.ts";
import { emitError } from "./emit-error.ts";
import { errorCode } from "./paths.ts";
import type { Template } from "./render.ts";

/** Mesh's own templates, shipped in the package next to `src/`. */
export const MESH_TEMPLATES_DIR = resolve(import.meta.dir, "../templates");

/** The project folder whose templates replace Mesh's, per template; `mesh export generators` writes it. */
export const PROJECT_TEMPLATES_DIR = ".mesh-generators";

/** The template each generator renders, keyed by template file name. */
export type Templates = ReadonlyMap<string, Template>;

/**
 * Choose and read the template of every generator, once per build: the project's
 * `.mesh-generators/<template>` when it is a regular file, Mesh's own copy when
 * nothing is there. Like the writer, the lookup never follows a symlink: a
 * symlinked `.mesh-generators/` or template is refused, and so is anything at the
 * template's path that is not a regular file or cannot be read
 * (`MESH_TEMPLATE_READ`, naming the project-relative path). The chosen path is the
 * one render errors name: project-relative for an override, absolute for Mesh's.
 */
export async function loadTemplates(generators: readonly Generator[], projectRoot: string): Promise<Templates> {
  const templates = new Map<string, Template>();
  const folder = await entry(join(projectRoot, PROJECT_TEMPLATES_DIR), PROJECT_TEMPLATES_DIR);
  if (folder?.isSymbolicLink()) throw readError(PROJECT_TEMPLATES_DIR, `"${PROJECT_TEMPLATES_DIR}" is a symlink; make it a real directory`);
  if (folder && !folder.isDirectory()) throw readError(PROJECT_TEMPLATES_DIR, `"${PROJECT_TEMPLATES_DIR}" is not a directory; delete or move it`);
  for (const { template } of generators) {
    const path = `${PROJECT_TEMPLATES_DIR}/${template}`;
    const contents = folder ? await readOverride(join(projectRoot, path), path) : null;
    if (contents === null) {
      const mesh = join(MESH_TEMPLATES_DIR, template);
      templates.set(template, { path: mesh, contents: await readFile(mesh, "utf8") });
    } else templates.set(template, { path, contents });
  }
  return templates;
}

/**
 * Read a project template, or `null` when nothing is at its path. The file is opened
 * with `O_NOFOLLOW` (and `O_NONBLOCK`, so a FIFO cannot hang the build) and checked through the open handle, so what is checked is what
 * is read: no symlink is followed and nothing can be swapped in between.
 */
async function readOverride(absolute: string, path: string): Promise<string | null> {
  let handle;
  try { handle = await open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch (cause) {
    const code = errorCode(cause);
    if (code === "ENOENT") return null;
    if (code === "ELOOP") throw readError(path, `The template "${path}" is a symlink; reading it would follow the link. Copy the file in instead`);
    throw readError(path, `Cannot read the template "${path}" (${code ?? "UNKNOWN"}); fix its permissions`);
  }
  try {
    if (!(await handle.stat()).isFile()) throw readError(path, `The template "${path}" is not a regular file; delete or move it`);
    try { return await handle.readFile("utf8"); }
    catch (cause) { throw readError(path, `Cannot read the template "${path}" (${errorCode(cause) ?? "UNKNOWN"}); fix its permissions`); }
  } finally { await handle.close(); }
}

/** `lstat`, with a missing entry as `null`; any other failure is a read error. */
async function entry(absolute: string, path: string): Promise<Stats | null> {
  try { return await lstat(absolute); }
  catch (cause) {
    if (errorCode(cause) === "ENOENT") return null;
    throw readError(path, `Cannot inspect "${path}" (${errorCode(cause) ?? "UNKNOWN"}); fix its permissions`);
  }
}

function readError(path: string, message: string) {
  return emitError("MESH_TEMPLATE_READ", message, { file: path, line: 1, column: 0, offset: 0 },
    `Mesh uses ${PROJECT_TEMPLATES_DIR}/<template> when it is a regular file and its own template when nothing is there`);
}
