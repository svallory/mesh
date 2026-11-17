/**
 * Concept files (`notes/architecture/concepts-design.md`, section 3.3; ruling D36). A file directly in a folder named
 * `concepts` (the dialect manifest's `tagDirs`) is a tag file: MX names a tag after it (the file `Money` in `concepts/` is
 * the tag `Money`), and the first call of that tag asks the dialect's `tagFile` hook, `conceptTagFile`, for its contract.
 * The hook returns `CONCEPT_USE`, the contract of a concept use (`Money :total`), when the file is a sound concept, and
 * its problems otherwise, so MX fails each use with `MESH_TAG_FILE_ERROR` and reports the file's own problems at the
 * file. The build checks the same problems with `conceptFileProblems` (`buildConcept` in `build.ts`), whose messages are
 * the hook's, so a problem reached both ways is reported once.
 *
 * The hook runs in every tool (it ships in `meshfw`'s `dist/dialect.js`, which MX loads for a file routed to the
 * dialect), so this file imports only types from MX and nothing that pulls in the expression translator.
 */
import type { CustomTag, SpannedIr, TagFileContext, TagFileDiagnostic, TagFileInput, TagFileResult } from "@mxlang/core";
import { MESH_EXTENSIONS } from "./extensions.ts";

type IrNode = SpannedIr["body"][number];
type Tag = Extract<IrNode, { kind: "DelegatedTag" }>["tag"];

/** What a concept use takes: its name, `nullable`, and `optional` (a command's field only, `checkFieldOptions`). OD6. */
export const CONCEPT_USE: Omit<CustomTag, "parseOptions" | "template"> = Object.freeze({
  parents: Object.freeze(["attributes", "event", "command", "concept"]) as unknown as string[],
  attributes: Object.freeze({
    name: Object.freeze({ type: "mesh:Atom", required: true, pattern: "^[A-Za-z_][A-Za-z0-9_]*$" }),
    nullable: Object.freeze({ type: "boolean", literalOnly: true }),
    optional: Object.freeze({ type: "boolean", literalOnly: true }),
  }),
  attributeTags: Object.freeze({}),
  children: Object.freeze({}),
}) as Omit<CustomTag, "parseOptions" | "template">;

/** A concept's name, as its use is written: a PascalCase line head (R6). */
export const PASCAL_CASE = /^[A-Z][A-Za-z0-9]*$/;
/** The field kinds a concept cannot hold yet: JSON keeps no `Date` (OD5). */
const DATE_TYPES: ReadonlySet<string> = new Set(["date", "datetime", "timestamp"]);
/** The one name no member may take (`PROTOTYPE_SETTING_NAME` in `build.ts`, which this file must not import). */
const PROTO = "__proto__";

/** One problem, at a UTF-16 offset of the concept file. */
export interface ConceptFileProblem {
  readonly code: string;
  readonly message: string;
  readonly offset: number;
}

const nameOf = (tag: Tag): { name: string; offset: number } | undefined => {
  const a = tag.attrs.find((each) => each.kind === "static" && each.name === "name");
  const node = a?.kind === "static" ? (a.node as { type?: string; name?: string; span?: { sourceStart: number } } | undefined) : undefined;
  return node?.type === "mesh:Atom" && typeof node.name === "string"
    ? { name: node.name, offset: node.span?.sourceStart ?? tag.nameSpan?.sourceStart ?? 0 }
    : undefined;
};
const tagsOf = (nodes: readonly IrNode[]): Tag[] => nodes.flatMap((n) => (n.kind === "DelegatedTag" ? [n.tag] : []));
const headOffset = (tag: Tag) => tag.nameSpan?.sourceStart ?? 0;
/** The concept file as a message names it: its `concepts` folder and its file name. */
export const conceptFileLabel = (path: string): string => {
  const parts = path.replace(/\\/g, "/").split("/");
  return parts.slice(-2).join("/");
};
const pascal = (name: string) => name.replace(/^_+/, "").split(/[^A-Za-z0-9]+/).filter(Boolean).map((w) => w[0]!.toUpperCase() + w.slice(1)).join("");

/**
 * The fix for a declared name that is not the file's (R5), offering only names that are themselves legal (R6): write the
 * file's name when it is PascalCase, rename the file when the declared name is, and both otherwise.
 */
function nameFix(declared: string, tagName: string): string {
  const file = (name: string) => `${name}${MESH_EXTENSIONS[0]}`;
  if (PASCAL_CASE.test(tagName))
    return PASCAL_CASE.test(declared) ? `write \`concept :${tagName}\` or rename the file ${file(declared)}` : `write \`concept :${tagName}\``;
  if (PASCAL_CASE.test(declared)) return `rename the file ${file(declared)}`;
  const fixed = pascal(declared) || pascal(tagName) || "Name";
  return `name the file ${file(fixed)} and write \`concept :${fixed}\``;
}

/**
 * Everything wrong with a concept file that its IR alone shows (R1, R5, R6, R18, R19, OD5, OD9). `tagName` is the name
 * MX gives the tag, the file name less its extension; `path` names the file in a message. Only the root, the name and the
 * fields are checked: the placement and the imports need the build's view of the project (`buildConcept`).
 */
export function conceptFileProblems(body: readonly IrNode[], tagName: string, path: string): ConceptFileProblem[] {
  const roots = tagsOf(body);
  const root = roots[0];
  const label = conceptFileLabel(path);
  // A file with no root (empty, or comments only) is still a concept file to MX: refused, so each use is
  // `MESH_TAG_FILE_ERROR` and never a clean use of a concept the build cannot index.
  if (!root) {
    const hint = PASCAL_CASE.test(tagName)
      ? `write \`concept :${tagName}\` and its field lines`
      : `write \`concept :Name\` and its field lines in a file named Name${MESH_EXTENSIONS[0]}`;
    return [{
      code: "MESH_CONCEPT_PLACE",
      message: `${label} is in a \`concepts\` folder, so it declares one concept, and it declares nothing: ${hint}, or move the file out of the folder`,
      offset: 0,
    }];
  }
  if (root.name !== "concept") {
    const declared = nameOf(root)?.name;
    const suggestion = pascal(declared ?? tagName) || "Name";
    return [{
      code: "MESH_CONCEPT_PLACE",
      message: `${label} is in a \`concepts\` folder, so it declares one concept: move this ${root.name} out of the folder, or write \`concept :${suggestion}\``,
      offset: headOffset(root),
    }];
  }
  if (roots.length > 1)
    return [{ code: "MESH_DUPLICATE_ENTITY", message: "A concept file declares exactly one concept", offset: headOffset(roots[1]!) }];
  const problems: ConceptFileProblem[] = [];
  const named = nameOf(root);
  if (named && named.name !== tagName)
    problems.push({
      code: "MESH_CONCEPT_NAME",
      message: `${label} declares \`concept :${named.name}\`: a concept's name is its file name, so ${nameFix(named.name, tagName)}`,
      offset: named.offset,
    });
  else if (named && !PASCAL_CASE.test(named.name)) {
    const fixed = pascal(named.name) || "Name";
    problems.push({
      code: "MESH_CONCEPT_NAME",
      message: `concept :${named.name} is not PascalCase: a concept is used as a PascalCase line head (\`${fixed} :price\`), so name the file ${fixed}${MESH_EXTENSIONS[0]} and write \`concept :${fixed}\``,
      offset: named.offset,
    });
  }
  const fields = tagsOf(root.children ?? []);
  if (fields.length === 0)
    problems.push({ code: "MESH_MISSING_CHILD", message: "`concept`: a concept needs at least one field line", offset: headOffset(root) });
  const seen = new Set<string>();
  for (const field of fields) {
    const fieldName = nameOf(field)?.name;
    if (fieldName === undefined) continue;
    if (seen.has(fieldName)) problems.push({ code: "MESH_DUPLICATE_MEMBER", message: `Duplicate member :${fieldName}`, offset: headOffset(field) });
    seen.add(fieldName);
    if (fieldName === PROTO)
      problems.push({
        code: "MESH_ATTRIBUTE_NAME",
        message: `:${PROTO} cannot be a field name: ${PROTO} sets an object's prototype instead of adding a property. Choose another name.`,
        offset: headOffset(field),
      });
    if (DATE_TYPES.has(field.name))
      problems.push({
        code: "MESH_CONCEPT_FIELD",
        message: `\`${field.name} :${fieldName}\` cannot be a field of a concept yet: a concept is stored as one JSON value, which keeps no date; write it as a \`string\`, or declare it on the entity`,
        offset: headOffset(field),
      });
  }
  return problems;
}

/** A 1-based line and a 0-based column of a UTF-16 offset, counted as MX counts them (`positionAt` in `model/`). */
function lineColumn(source: string, offset: number): { line: number; column: number } {
  const before = source.slice(0, offset);
  return { line: before.split("\n").length, column: offset - (before.lastIndexOf("\n") + 1) };
}

/**
 * `Dialect.tagFile`: a file in a `concepts` folder becomes the contract of a concept use. A parse error or a cycle passes
 * MX's diagnostics on as they are (MX keeps an `MX_` code only on the object `ctx.lower` returned, unchanged), and each
 * use is then `MESH_TAG_FILE_ERROR`. `lowered.diagnostics` may hold errors although the file lowered (a field's
 * `optional`, from `checkFieldOptions`): MX then fails each use whatever this returns, which is R17.
 */
export function conceptTagFile(file: TagFileInput, ctx: TagFileContext): TagFileResult {
  const lowered = ctx.lower();
  if (!lowered.ir) return { diagnostics: lowered.diagnostics as readonly TagFileDiagnostic[] };
  const problems: TagFileDiagnostic[] = conceptFileProblems(lowered.ir.body, file.name, file.path).map((problem) => ({
    severity: "error",
    code: problem.code,
    message: problem.message,
    ...lineColumn(file.source, problem.offset),
  }));
  const passed = lowered.diagnostics as readonly TagFileDiagnostic[];
  return problems.length > 0 ? { diagnostics: [...passed, ...problems] } : { contract: CONCEPT_USE, diagnostics: passed };
}
