import { lstat, mkdir, open, rename, unlink } from "node:fs/promises";
import type { Stats } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, join, relative, resolve, sep } from "node:path";
import { isProjectRelativePath, type Diagnostic, type ModelDocument } from "@meshfw/model";
import type { ResolvedConfig } from "./config.ts";
import { errorCode, inside } from "./paths.ts";
import { EmitError, emitError } from "./emit-error.ts";
import { modelJsonEmitter } from "./emitters/model-json.ts";
import { typesGenerator } from "./emitters/types.ts";
import { validatorsGenerator } from "./emitters/validators.ts";
import { compareText, outputPrefix } from "./emitters/order.ts";
import { formatTypescript } from "./format.ts";
import { renderTemplate, type Template } from "./render.ts";
import { loadTemplates, type Templates } from "./templates.ts";

export { EmitError } from "./emit-error.ts";

/**
 * One generated file: a project-relative path with `/` separators (so it names the
 * same file on every host) and the exact text to write. Nothing else: an emitter
 * does not decide how a file reaches the disk, and it never writes.
 */
export interface GeneratedFile {
  readonly path: string;
  readonly contents: string;
}

/** What an emitter is given: the model document, and the resolved project config. */
export interface EmitInput {
  readonly document: ModelDocument;
  readonly config: ResolvedConfig;
}

/**
 * A source of generated files that is not a template: `model.json` is the model
 * serialised as data, so it has no view and no template a project could override.
 *
 * UNSTABLE UNTIL M6, like `Generator`: the extension host registers both shapes.
 */
export interface Emitter {
  /** Stable name, used in the error that two emitters wrote the same path. */
  readonly name: string;
  /** Bare packages imported by generated code, resolved from the consumer root. */
  readonly requires?: readonly string[];
  emit(input: EmitInput): Promise<readonly GeneratedFile[]>;
}

/** One file a generator writes: its project-relative path and the view its template renders. */
export interface GeneratedView<View extends object> {
  /** Project-relative path of the generated file, with `/` separators. */
  readonly path: string;
  /** The plain data the generator's template renders into that file. */
  readonly view: View;
}

/**
 * A generator is a view and a template (ADR-0061). `views` is pure and synchronous
 * and makes every decision; the template named by `template` only prints each view,
 * and `renderGenerator` formats the result. A project's `.mesh-generators/<template>`
 * replaces Mesh's copy of the template; the view type is the contract it renders.
 *
 * UNSTABLE UNTIL M6: from M6 the extension host registers generators through this
 * interface, so the shape may still change.
 */
export interface Generator<View extends object = object> {
  /** Stable name, used in errors: two generators writing one path, a template that fails to render. */
  readonly name: string;
  /** The template's file name, in Mesh's `templates/` folder and in a project's `.mesh-generators/`. */
  readonly template: string;
  /** Bare packages imported by generated code, resolved from the consumer root. */
  readonly requires?: readonly string[];
  /** One view per generated file; pure and synchronous, throwing `EmitError` for a model it cannot render. */
  views(input: EmitInput): readonly GeneratedView<View>[];
}

/** Render every view of one generator with its template and format the result. */
export async function renderGenerator<View extends object>(
  generator: Generator<View>,
  input: EmitInput,
  templates: Templates,
): Promise<GeneratedFile[]> {
  const template: Template | undefined = templates.get(generator.template);
  if (!template) throw new Error(`No template "${generator.template}" for generator "${generator.name}"`);
  // One file at a time, in view order, so the first error reported is always the same one.
  const files: GeneratedFile[] = [];
  for (const { path, view } of generator.views(input)) {
    const rendered = await renderTemplate(template, view, generator.name);
    try {
      files.push({ path, contents: await formatTypescript(rendered) });
    } catch (cause) {
      // A project template can print anything; text the formatter cannot parse is the
      // template's error, named on the template, not an unpositioned build failure.
      const reason = (cause instanceof Error ? cause.message : String(cause)).split("\n")[0];
      throw emitError(
        "MESH_TEMPLATE_RENDER",
        `Generator "${generator.name}" cannot render ${template.path}: rendered output for ${path} is not valid TypeScript: ${reason}`,
        { file: template.path, line: 1, column: 0, offset: 0 },
        "Fix the template so that it prints valid TypeScript",
      );
    }
  }
  return files;
}

/** The emitters of the core build, in a fixed order. The result is sorted by path anyway. */
export const EMITTERS: readonly (Emitter | Generator)[] = Object.freeze([modelJsonEmitter, typesGenerator, validatorsGenerator]);

/** The generators among `EMITTERS`: the ones with a template. */
export const GENERATORS: readonly Generator[] = Object.freeze(EMITTERS.filter(isGenerator));

function isGenerator(entry: Emitter | Generator): entry is Generator {
  return "template" in entry;
}

/** Preflight every generated import before writing; check/inspect need no installed runtime dependencies. */
export function generatedImportDiagnostics(projectRoot: string, emitters: readonly (Emitter | Generator)[] = EMITTERS): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const required = new Set(emitters.flatMap((emitter) => [...emitter.requires ?? []]));
  for (const specifier of [...required].sort(compareText)) {
    try { Bun.resolveSync(specifier, projectRoot); }
    catch {
      diagnostics.push({ severity: "error", code: "MESH_GENERATED_IMPORT",
        message: `generated code imports "${specifier}", which is not installed in this project. Run: bun add ${specifier}`,
        position: { file: "mesh.config.ts", line: 1, column: 0, offset: 0 }, fix: null });
    }
  }
  return diagnostics;
}

/**
 * Run every emitter and return the whole generated tree as text, sorted by path.
 * Nothing is written: this is what `mesh build --check` and `mesh inspect` compare
 * against the committed files. Two emitters writing one path is a build error, not
 * a last-one-wins merge. Templates are looked up once per call.
 */
export async function generateFiles(input: EmitInput): Promise<GeneratedFile[]> {
  const files: GeneratedFile[] = [];
  const owners = new Map<string, string>();
  const templates = await loadTemplates(GENERATORS, input.config.root);
  for (const emitter of EMITTERS) {
    const produced = isGenerator(emitter) ? await renderGenerator(emitter, input, templates) : await emitter.emit(input);
    for (const file of produced) {
      if (!isProjectRelativePath(file.path)) {
        throw new EmitError({
          severity: "error",
          code: "MESH_EMIT_PATH",
          message: `Emitter "${emitter.name}" produced the path "${file.path}", which is not a project-relative path`,
          position: { file: "mesh.config.ts", line: 1, column: 0, offset: 0 },
          fix: "Report this emitter bug: a generated path must be relative to the project root",
        });
      }
      const owner = owners.get(file.path);
      if (owner !== undefined) {
        throw new Error(`Emitters "${owner}" and "${emitter.name}" both write "${file.path}"`);
      }
      owners.set(file.path, emitter.name);
      files.push(file);
    }
  }
  return files.sort((a, b) => compareText(a.path, b.path));
}

/**
 * Refuse symlinks and wrong entry types at every level of the path being written,
 * starting at the output directory itself. Every existing component from the output
 * folder down to the target is inspected with `lstat`, which does not follow links:
 * an output folder that is a symlink is refused as firmly as a directory symlink in
 * the middle of the path or a symlinked file at the leaf, and whatever any of them
 * points at is left alone. A component that does not exist yet is where the writer
 * will create it, so it ends the walk.
 *
 * Nothing here rewrites separators. A generated path arrives with `/` from the
 * emitters, and the host path is joined with the host separator; on POSIX a
 * backslash in a file name is a character of that name, not a folder, so treating
 * it as one would compare two different files as if they were one.
 */
async function assertWritablePath(output: string, target: string, label: string, outputName: string): Promise<void> {
  const below = relative(output, target).split(sep).filter((segment) => segment.length > 0);
  const walked: string[] = [];
  const refuse = async (path: string, isOutput: boolean): Promise<boolean> => {
    const name = isOutput ? outputName : `${outputName}/${walked.join("/")}`;
    let info: Stats;
    try { info = await lstat(path); }
    catch (cause) {
      const code = errorCode(cause);
      // A component that does not exist yet is where the writer will create it.
      if (code === "ENOENT") return false;
      throw writeError(name, `Cannot inspect "${name}" before writing (${code ?? "UNKNOWN"}); fix its permissions and rebuild`);
    }
    if (info.isSymbolicLink()) throw writeError(name,
      isOutput
        ? `Cannot write the generated tree: the output directory "${outputName}" is a symlink; point \`output\` at a real directory`
        : `Cannot write the generated file "${label}": "${walked.join("/")}" in the output directory is a symlink; writing it would follow the link`,
    );
    const directory = isOutput || path !== target;
    if (directory ? !info.isDirectory() : !info.isFile()) {
      throw writeError(name, `Cannot write generated path "${name}": expected ${directory ? "a directory" : "a regular file"}, found ${entryKind(info)}; delete or move it and rebuild`);
    }
    return true;
  };
  if (await refuse(output, true)) {
    for (const segment of below) {
      walked.push(segment);
      if (!(await refuse(join(output, ...walked), false))) return;
    }
  }
}

function entryKind(info: Stats): string {
  if (info.isDirectory()) return "a directory";
  if (info.isFile()) return "a regular file";
  if (info.isFIFO()) return "a FIFO";
  if (info.isSocket()) return "a socket";
  if (info.isBlockDevice()) return "a block device";
  if (info.isCharacterDevice()) return "a character device";
  return "an unsupported filesystem entry";
}

function writeError(file: string, message: string): EmitError {
  return new EmitError({ severity: "error", code: "MESH_WRITE_PATH", message,
    position: { file, line: 1, column: 0, offset: 0 }, fix: null });
}

/** Replace, never truncate, an existing inode. Exclusive creation means a
 * colliding existing path is not touched or cleaned up as though it were ours.
 * chmod on the new handle restores exactly 0644 even under a restrictive umask.
 */
async function replaceFile(target: string, file: GeneratedFile, targets: ReadonlySet<string>): Promise<void> {
  let temporary: string;
  do { temporary = join(dirname(target), `.mesh-${randomUUID()}.tmp`); }
  while (targets.has(temporary.toLowerCase()));
  let created = false;
  try {
    await mkdir(dirname(target), { recursive: true });
    const handle = await open(temporary, "wx", 0o644);
    created = true;
    try {
      await handle.chmod(0o644);
      await handle.writeFile(file.contents, "utf8");
    } finally { await handle.close(); }
    await rename(temporary, target);
    created = false;
  } catch (cause) {
    if (created) {
      try { await unlink(temporary); }
      catch (cleanup) {
        const tempName = `${file.path.slice(0, file.path.lastIndexOf("/") + 1)}${temporary.slice(temporary.lastIndexOf(sep) + 1)}`;
        throw writeError(file.path, `Cannot replace generated file "${file.path}" (${errorCode(cause) ?? "UNKNOWN"}); cannot remove temporary file "${tempName}" (${errorCode(cleanup) ?? "UNKNOWN"}); remove it and rebuild`);
      }
    }
    throw writeError(file.path, `Cannot replace generated file "${file.path}" (${errorCode(cause) ?? "UNKNOWN"}); fix the output path or permissions and rebuild`);
  }
}

/**
 * Write a generated tree under the configured output directory, creating the folders
 * it needs. Returns the absolute paths written, in the order they were given.
 *
 * Containment is checked physically, not by spelling, at the moment of writing:
 * a target outside the output directory is refused, and so is any component inside
 * it that is a symlink, whatever it points at, because writing through one would
 * change a file Mesh does not own. Every existing target must be a regular file,
 * and every existing ancestor from output down must be a directory. The whole
 * tree is preflighted before any write, without opening special files.
 * Each file is then replaced via an exclusive same-directory temporary file and
 * rename: hard links and unreadable old permissions cannot corrupt the result.
 * Failed writes/renames clean up their temporary file. This is per-file atomicity,
 * not a transaction across the tree; a later I/O failure can follow earlier writes.
 * No existing stray is deleted. Concurrent filesystem mutation is not supported.
 */
export async function writeGeneratedFiles(files: readonly GeneratedFile[], config: ResolvedConfig): Promise<string[]> {
  const output = resolve(config.output);
  const outputName = outputPrefix(config);
  const targets: string[] = [];
  for (const file of files) {
    if (!isProjectRelativePath(file.path)) {
      throw new Error(`Cannot write the generated file "${file.path}": it is not a project-relative path`);
    }
    const absolute = resolve(config.root, file.path);
    if (!inside(output, absolute)) {
      throw new Error(
        `Cannot write the generated file "${file.path}": it resolves outside the output directory "${outputName}"`,
      );
    }
    await assertWritablePath(output, absolute, file.path, outputName);
    targets.push(absolute);
  }
  const written: string[] = [];
  const produced = new Set(targets.map((target) => target.toLowerCase()));
  for (const [index, absolute] of targets.entries()) {
    await replaceFile(absolute, files[index]!, produced);
    written.push(absolute);
  }
  return written;
}