import { lstat, mkdir, open as openFile, readFile } from "node:fs/promises";
import type { Stats } from "node:fs";
import { join } from "node:path";
import { GENERATORS, MESH_TEMPLATES_DIR, PROJECT_TEMPLATES_DIR, type Generator } from "@meshfw/compiler";
import type { Diagnostic } from "@meshfw/model";
import { diagnostic } from "./diagnostics.ts";

export interface ExportResult {
  /** Project-relative paths written, in template order. */
  readonly written: readonly string[];
  /** Why nothing was written; empty on success. */
  readonly diagnostics: readonly Diagnostic[];
}

const errorCode = (cause: unknown): string =>
  typeof cause === "object" && cause !== null && "code" in cause ? String(cause.code) : "UNKNOWN";

async function entry(absolute: string): Promise<Stats | null> {
  try { return await lstat(absolute); }
  catch (cause) { if (errorCode(cause) === "ENOENT") return null; throw cause; }
}

/**
 * `mesh export generators`: copy every template Mesh ships, then the data adapter's
 * (`adapterGenerators`, each read from its `templateDir`), into `<root>/.mesh-generators/`. Everything is compared before anything is written:
 * a target that exists and differs from Mesh's template stops the whole export,
 * so a project's edited template is never overwritten. Byte-identical targets are
 * left alone; absent ones are created. Symlinks are refused, never followed.
 * If creating a later file fails, the files already written are kept and named in
 * the error. `open` is replaceable only so that tests can make a creation fail.
 */
export async function exportGenerators(root: string, adapterGenerators: readonly Generator[] = [], open: typeof openFile = openFile): Promise<ExportResult> {
  const diagnostics: Diagnostic[] = [];
  const folder = join(root, PROJECT_TEMPLATES_DIR);
  const folderInfo = await entry(folder);
  if (folderInfo?.isSymbolicLink()) diagnostics.push(diagnostic(PROJECT_TEMPLATES_DIR, `"${PROJECT_TEMPLATES_DIR}" is a symlink; make it a real directory`));
  else if (folderInfo && !folderInfo.isDirectory()) diagnostics.push(diagnostic(PROJECT_TEMPLATES_DIR, `"${PROJECT_TEMPLATES_DIR}" is not a directory; delete or move it`));
  if (diagnostics.length) return { written: [], diagnostics };

  const pending: { path: string; contents: string }[] = [];
  for (const { template, templateDir = MESH_TEMPLATES_DIR } of [...GENERATORS, ...adapterGenerators]) {
    const path = `${PROJECT_TEMPLATES_DIR}/${template}`;
    const contents = await readFile(join(templateDir, template), "utf8");
    const info = folderInfo ? await entry(join(root, path)) : null;
    if (info === null) pending.push({ path, contents });
    else if (info.isSymbolicLink()) diagnostics.push(diagnostic(path, "Is a symlink; export never writes through one. Delete or move it, then export again"));
    else if (!info.isFile()) diagnostics.push(diagnostic(path, "Is not a regular file; delete or move it, then export again"));
    else {
      let existing: Buffer;
      try { existing = await readFile(join(root, path)); }
      catch (cause) { diagnostics.push(diagnostic(path, `Cannot read it to compare (${errorCode(cause)}); fix its permissions`)); continue; }
      if (!existing.equals(Buffer.from(contents, "utf8")))
        diagnostics.push(diagnostic(path, "Differs from Mesh's template; nothing was exported. Move your template aside to export Mesh's, or keep it and export nothing"));
    }
  }
  if (diagnostics.length) return { written: [], diagnostics };

  const written: string[] = [];
  if (pending.length) await mkdir(folder, { recursive: true });
  for (const { path, contents } of pending) {
    try {
      // Exclusive creation: a file that appeared since the comparison is not replaced.
      const handle = await open(join(root, path), "wx", 0o644);
      try { await handle.writeFile(contents, "utf8"); }
      finally { await handle.close(); }
    } catch (cause) {
      // Files already written are kept (they are Mesh's templates, byte for byte)
      // and named, so a failed export never leaves an unreported change.
      const kept = written.length ? `; already written: ${written.join(", ")}` : "; nothing was written";
      return { written, diagnostics: [diagnostic(path, `Cannot create it (${errorCode(cause)})${kept}`)] };
    }
    written.push(path);
  }
  return { written, diagnostics };
}
