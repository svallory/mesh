import { existsSync, readdirSync, readFileSync } from "node:fs";
import { extname, join, relative, sep } from "node:path";
import { parseData, type DataDiagnostic } from "@mxlang/data";
import { parse } from "./helpers.ts";

// ADR-0043: only packages declaring tag contracts may mention MX; extensions join in M6.
export const MX_IMPORT_PACKAGES = ["packages/compiler"] as const;

/**
 * The one `@mxlang` mention allowed outside those packages.
 *
 * The docs site highlights `mx` fences with MX's own tree-sitter highlighter,
 * which is the published `@mxlang/tree-sitter-mx` (ADR-0065). It is a build-time
 * grammar for the documentation, not the entity vocabulary, so `@mxlang/core` and
 * `@mxlang/data` stay forbidden everywhere outside `packages/compiler` and only
 * this one package name passes in `apps/docs`. A blanket exemption for the docs
 * app would have let the vocabulary's own packages back in.
 */
export const MX_HIGHLIGHTER_PACKAGE = "@mxlang/tree-sitter-mx";

/**
 * The offset of the first `@mxlang` mention in `source` that is not the
 * highlighter, or -1. `@mxlang/tree-sitter-mx-something` does not pass: the name
 * must end where the package name ends.
 */
function firstForbiddenMxMention(source: string): number {
  for (let at = 0; ;) {
    const found = source.indexOf("@mxlang", at);
    if (found === -1) return -1;
    const end = found + MX_HIGHLIGHTER_PACKAGE.length;
    const next = source[end];
    if (source.startsWith(MX_HIGHLIGHTER_PACKAGE, found) && (next === undefined || !/[\w.-]/.test(next))) {
      at = end;
      continue;
    }
    return found;
  }
}
const sourceExtensions = new Set([".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs", ".json"]);
const lockFiles = new Set(["bun.lock", "bun.lockb", "bun.lock.json", "package-lock.json", "npm-shrinkwrap.json", "yarn.lock", "pnpm-lock.yaml"]);
const within = (path: string, dir: string) => path === dir || path.startsWith(`${dir}/`);

function walk(root: string, dir: string, allFiles = false): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const file = join(dir, entry.name);
    // Only host separators delimit segments; a POSIX backslash is a filename character.
    const path = relative(root, file).split(sep).join("/");
    if (!allFiles && (path.split("/").includes("node_modules") || within(path, "apps/docs/site") || within(path, "apps/docs/docs") ||
      MX_IMPORT_PACKAGES.some((pkg) => within(path, pkg)))) return [];
    // Never follow symlinks into dependencies or outside the checkout.
    if (entry.isDirectory()) return walk(root, file, allFiles);
    return entry.isFile() && (allFiles || (sourceExtensions.has(extname(file)) && !lockFiles.has(entry.name))) ? [file] : [];
  });
}

/** Deliberately text-only: comments, strings, wrappers and dependency fields all count.
 * Specifiers assembled at run time from pieces cannot be caught by this substring rule;
 * the package.json dependency rule plus code review are the backstop.
 *
 * The one exception is `MX_HIGHLIGHTER_PACKAGE`, the docs site's grammar (ADR-0065).
 */
export function checkMxImports(root: string): string[] {
  return ["packages", "apps", "examples"].flatMap((group) => walk(root, join(root, group))).sort().flatMap((file) => {
    const source = readFileSync(file, "utf8");
    const first = firstForbiddenMxMention(source);
    if (first === -1) return [];
    const path = relative(root, file).split(sep).join("/");
    const line = source.slice(0, first).split(/\r\n|\r|\n/).length;
    return [`${path}:${line}: Mention of @mxlang is forbidden here (ADR-0043), including comments and strings; move the code into packages/compiler or remove the mention`];
  });
}

const runtimeForbidden = ["@mesh/model", "@mesh/compiler", "drizzle-orm", "drizzle-kit"];

/** M2's text rules reuse M1's directory walker, scanning every runtime source file. */
export function checkRuntime(root: string, rule: "imports" | "web"): string[] {
  const dir = join(root, "packages/runtime/src");
  const files = existsSync(dir) ? walk(root, dir, true).sort() : [];
  const errors: string[] = [];
  if (files.length === 0) errors.push("packages/runtime/src: No runtime source files scanned");
  const report = (file: string, source: string, index: number, reason: string) => {
    const path = relative(root, file).split(sep).join("/");
    errors.push(`${path}:${source.slice(0, index).split(/\r\n|\r|\n/).length}: ${reason}`);
  };
  for (const file of files) {
    const source = readFileSync(file, "utf8");
    if (rule === "imports") {
      for (const name of runtimeForbidden) {
        const index = source.indexOf(name);
        if (index !== -1) report(file, source, index, `Runtime must not mention ${name}; move build-time or database-specific code out of runtime`);
      }
    } else {
      // Plain text on purpose, like M1: even comments and strings fail.
      // No parsing or token adjacency assumptions: inter-token comments cannot hide a mention.
      for (const match of source.matchAll(/bun:|node:|\bBun\b/g)) {
        report(file, source, match.index, `Runtime must use web-standard APIs; forbidden text ${match[0]} (including comments and strings)`);
      }
    }
  }
  if (rule === "imports") {
    const file = join(root, "packages/runtime/package.json");
    if (!existsSync(file)) errors.push("packages/runtime/package.json: Missing runtime manifest");
    else {
      const source = readFileSync(file, "utf8");
      // Scan the whole manifest text, including values such as npm: dependency aliases.
      for (const name of runtimeForbidden) {
        const index = source.indexOf(name);
        if (index !== -1) report(file, source, index, `Runtime manifest must not mention ${name} anywhere, including keys and values`);
      }
    }
  }
  return errors;
}

/**
 * The Docs pages write the entity root tag as `entity` (the operator's ruling of
 * 2026-10-04). The tag contracts still know `resource`, so before parsing, the
 * check rewrites the root tag in memory: every Docs sample is still parsed by
 * today's contracts, and the check keeps its teeth.
 *
 * What the rename task will change is anything the vocabulary itself touches.
 * A block that fails only for one of those reasons is deferred, counted per
 * reason and printed; any other failure is a finding in the page.
 */
export const DOCS_ROOT_TAG_PENDING_RENAME = "entity";

/** Diagnostic text that names something the entity/module rename or the import rule will change. */
const RENAME_AFFECTED = /\b(entity|module|domain|import)\b/i;

function withCurrentRootTag(block: string) {
  return block.replace(new RegExp(`^(\\s*)${DOCS_ROOT_TAG_PENDING_RENAME}(\\s*=)`, "m"), "$1resource$2");
}

interface DocsBlock {
  /** Page the fence is on. */
  name: string;
  /** 1-based line of the opening fence. */
  line: number;
  /** The fence's lines, with a figure's `// @key:` annotations removed. */
  block: string[];
  /** False when the fence was never closed. */
  closed: boolean;
}

/** Every ```mx and ```mx-figure fence on the Docs pages, in page and file order. */
function docsMxBlocks(dir: string): DocsBlock[] {
  const blocks: DocsBlock[] = [];
  for (const name of readdirSync(dir).filter((entry) => entry.endsWith(".md")).sort()) {
    const lines = readFileSync(join(dir, name), "utf8").split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const opening = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(lines[i]!);
      if (!opening) continue;
      const fence = opening[1]!;
      const line = i + 1;
      let block: string[] = [];
      let closed = false;
      while (++i < lines.length) {
        const closing = /^ {0,3}(`{3,}|~{3,})\s*$/.exec(lines[i]!);
        if (closing && closing[1]![0] === fence[0] && closing[1]!.length >= fence.length) { closed = true; break; }
        block.push(lines[i]!);
      }
      const language = opening[2]!.trim().split(/\s+/)[0];
      // The figure is one entity file too, once its `// @key:` annotations are removed.
      if (language === "mx-figure") block = block.filter((text) => !/^\s*\/\/\s*@/.test(text));
      else if (language !== "mx") continue;
      blocks.push({ name, line, block, closed });
    }
  }
  return blocks;
}

/**
 * Syntax v4 (ADR-0067): :name declares, &name refers to a member, and another
 * entity is imported. The pinned parser predates MX's syntax table, so one
 * normalisation below adapts only those spellings before a real, static parse.
 * Contracts still know the resource vocabulary: that parse alone is deferred,
 * counted and printed. Name resolution and Mesh semantics await realignment.
 */
export const DOCS_SYNTAX = "syntax v4";

/** The one named reason a v4 block's contracts parse is deferred under. */
export const DOCS_SYNTAX_PENDING_TABLE = `${DOCS_SYNTAX}, pending the MX syntax table`;

/** A complete v4 entity file: comments and imports may come first, then `entity :Name`. */
export function isV4EntityFile(block: string): boolean {
  for (const line of block.split("\n")) {
    const text = line.trim();
    if (text === "" || text.startsWith("//")) continue;
    if (text.startsWith("import ")) continue;
    return /^entity\s+:\w+/.test(text);
  }
  return false;
}

/**
 * An option whose value is a single name or enum value, written as a string:
 * `default="draft"`, `on:load="visible"`. A list is handled
 * by `V4_LIST_OF_QUOTED_NAMES` below.
 */
const V4_QUOTED_NAME =
  /(?:^|[\s])(auto|types|actions|load|sort|default|on|on:load|entity)=("[^"]*")/;

/**
 * An option whose value is a list written as quoted identifiers: `fields=[
 * "status", "amount"]`, `accept=["title"]`. Any option may hold such a list,
 * including one an extension adds (`audit fields=[...]`), because a list of
 * quoted identifiers is a list of names wherever it appears.
 *
 * The one exclusion is an option whose value is genuinely a list of text.
 * None of the v1 vocabulary has one — `table`, `message`, `code`, `of`,
 * `match` and `domain` are all single strings, and `values` holds enum values,
 * which are atoms, not text — so the set is empty and is kept as a named,
 * auditable place to add one. A *single* quoted value is not caught here: for
 * an option nobody has declared, `"some text"` and a name look the same, and
 * guessing would produce false findings on ordinary text.
 */
const V4_TEXT_LIST_OPTIONS = new Set<string>();
const V4_LIST_OF_QUOTED_NAMES =
  /(\b[a-z][a-z0-9-]*)=(\[\s*(?:"[\w-]+"\s*,?\s*)+\])/g;

/**
 * The first line of a block that is not written in syntax v4, or `null`.
 *
 * The parser cannot see any of this: `accept=["title"]` and `sort=[:dueOn]`
 * are perfectly good input to MX, so the block would parse and the page would
 * drift back to the old syntax without any check noticing. These are the rules
 * of the syntax the docs enforce, and this is where it enforces them.
 */
export function oldSpellingInV4(block: string): string | null {
  for (const [index, line] of block.split("\n").entries()) {
    const text = line.trim();
    if (text === "" || text.startsWith("//")) continue;
    if (/(?:^|\s)(?:accept|require)\s*=|^arguments\b/.test(text)) {
      return `line ${index + 1}: action input belongs in one \`input\` section (${text})`;
    }
    if (/\b(?:belongs-to|has-many|has-one)\s*=/.test(text) || /\bentity\s*=\s*:/.test(text)) {
      return `line ${index + 1}: a relationship is \`kind :name entity=ImportedName\` (${text})`;
    }
    if (/^(?:asc|desc)\s+:|^:\w+\s*=|\b(?:load|actions|fields)\s*=\s*\[[^\]]*:\w|\bon:load\s*=\s*:/.test(text)) {
      return `line ${index + 1}: a member reference is \`&name\`, not an atom (${text})`;
    }
    if (/^&\w+\s+\S/.test(text)) {
      return `line ${index + 1}: an input member takes no options; rules belong on its declaration (${text})`;
    }
    // A read's order is a `sort` section with `asc`/`desc` lines (ADR-0066).
    if (/(?:^|[\s])sort=/.test(text)) {
      return `line ${index + 1}: a read's order is a \`sort\` section with \`asc &field\` and \`desc &field\` lines, not a \`sort=\` option (${text})`;
    }
    const name = V4_QUOTED_NAME.exec(text);
    if (name) {
      return `line ${index + 1}: \`${name[1]}\` takes an atom, member reference or imported name, not a string (${text})`;
    }
    V4_LIST_OF_QUOTED_NAMES.lastIndex = 0;
    for (let list = V4_LIST_OF_QUOTED_NAMES.exec(text); list; list = V4_LIST_OF_QUOTED_NAMES.exec(text)) {
      if (V4_TEXT_LIST_OPTIONS.has(list[1]!)) continue;
      return `line ${index + 1}: \`${list[1]}\` takes atoms or member references, not strings (${text})`;
    }
    const oldName = /^[a-z][a-z0-9-]*\s+#(\w+)/.exec(text);
    if (oldName) return `line ${index + 1}: a declaration is \`kind :name options\`; \`#${oldName[1]}\` is the old spelling (${text})`;
  }
  return null;
}

/**
 * Temporary spelling bridge for alpha.5, removed when Mesh pins MX's syntax
 * table (MX decision 182 addendum 1, including lineTriggers). Never changes the
 * page or evaluates code. Imports pass through alpha.5's imports:pass option.
 * Quoted text, expression comments, regex literals and infix &/&& stay untouched.
 */
export function normaliseV4(source: string): string {
  // alpha.5 also rejects comments under structural:reject (owed to MX).
  // Blank only leading file comments, keeping rows. In-body comments remain
  // untouched so a column-0 comment cannot silently hide an indentation error.
  let beforeEntity = true;
  const uncommented = source.split("\n").map((line) => {
    if (/^entity\b/.test(line)) beforeEntity = false;
    return beforeEntity && /^\/\//.test(line) ? "" : line;
  }).join("\n");
  // Tokenise before adapting line triggers too: a line inside a quoted template
  // must never be rewritten. The core's after-kind reference positions are sort
  // directions; `return &x` is an operand, not a declaration named :x.
  const lines = uncommented;
  const tokens = /\/\/[^\n]*|\/\*[\s\S]*?\*\/|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`|\/(?:\\.|[^/\n\\])+\/[a-z]*|&[A-Za-z_]\w*|[A-Za-z_$][\w$]*|\d+(?:\.\d+)?|===|!==|=>|&&|\|\||==|!=|<=|>=|\S/g;
  let previous = "";
  return lines.replace(tokens, (token, offset: number) => {
    if (token.startsWith("//") || token.startsWith("/*")) return token;
    const prefix = lines.slice(lines.lastIndexOf("\n", offset - 1) + 1, offset);
    const lineReference = /^[\t ]*$/.test(prefix) || /^[\t ]*(?:asc|desc)[\t ]+$/.test(prefix);
    const operand = previous === "" || /^(?:return|throw|typeof|void|delete|yield|await)$/.test(previous) ||
      /^(?:=>|&&|\|\||===|!==|==|!=|<=|>=|[=([{,:?!+*/%<>|&^~-])$/.test(previous);
    const result = /^&\w/.test(token)
      ? lineReference ? `:${token.slice(1)}` : operand ? `self.${token.slice(1)}` : token
      : token;
    previous = token;
    return result;
  });
}

/** A parser crash is a finding, not an exception. */
export function parseV4(source: string, file: string): DataDiagnostic[] {
  try {
    return parseData(normaliseV4(source), file, { structural: "reject", imports: "pass" }).diagnostics;
  } catch (cause) {
    return [{ severity: "error", message: `MX could not parse the block at all: ${(cause as Error).message.split("\n")[0]}`, line: 1, column: 0, offset: 0 }];
  }
}

/**
 * The stricter companion: every MX fence on the Docs pages must be a complete v4
 * entity file, so a page cannot drift back to another syntax, and every one of them
 * must parse. A block whose root is not `entity :Name` fails here.
 */
export function checkDocsSyntaxV4(dir: string) {
  let checked = 0;
  const errors: string[] = [];
  for (const { name, line, block, closed } of docsMxBlocks(dir)) {
    const where = `${name}:${line}`;
    if (!closed) { errors.push(`${where}: unclosed MX fence`); continue; }
    if (!isV4EntityFile(block.join("\n"))) {
      errors.push(`${where}: MX fence is not a complete ${DOCS_SYNTAX} entity file: its root must be \`entity :Name\``);
      continue;
    }
    checked++;
    const quoted = oldSpellingInV4(block.join("\n"));
    if (quoted) errors.push(`${where}: MX fence is not written in ${DOCS_SYNTAX}: ${quoted}`);
    for (const diagnostic of parseV4(`${block.join("\n")}\n`, where)) {
      errors.push(`${where}: MX block ${diagnostic.line}:${diagnostic.column + 1}: ${diagnostic.message}`);
    }
  }
  console.log(`Docs ${DOCS_SYNTAX} entity files: ${checked} checked with parseData, no contracts, ${errors.length} findings`);
  if (checked === 0) errors.push(`Docs ${DOCS_SYNTAX} check found no entity file on any Docs page`);
  return { checked, errors };
}

export function checkDocsSamples(dir: string) {
  let parsed = 0;
  let skipped = 0;
  let v4 = 0;
  const deferred: { at: string; reason: string }[] = [];
  const errors: string[] = [];
  for (const { name, line, block, closed } of docsMxBlocks(dir)) {
    const where = `${name}:${line}`;
    if (!closed) errors.push(`${where}: unclosed MX fence`);
    // A v4 entity file still gets a real parse; only its contracts are deferred.
    if (isV4EntityFile(block.join("\n"))) {
      v4++;
      parsed++;
      deferred.push({ at: where, reason: DOCS_SYNTAX_PENDING_TABLE });
      const old = oldSpellingInV4(block.join("\n"));
      if (old) errors.push(`${where}: ${old}`);
      for (const diagnostic of parseV4(`${block.join("\n")}\n`, where)) {
        errors.push(`${where}: MX block ${diagnostic.line}:${diagnostic.column + 1}: ${diagnostic.message}`);
      }
      continue;
    }
    const root = block.find((text) => text.trim() !== "")?.trimStart() ?? "";
    // An entity file may open with its imports, so an `import` line heads a complete block too.
    if (!/^(resource\b|import\s)/.test(root) && !root.startsWith(DOCS_ROOT_TAG_PENDING_RENAME)) { skipped++; continue; }
    const diagnostics = parse(withCurrentRootTag(`${block.join("\n")}\n`), join(dir, name)).diagnostics;
    const renaming = diagnostics.filter((diagnostic) => RENAME_AFFECTED.test(diagnostic.message));
    if (renaming.length > 0 && renaming.length === diagnostics.length) {
      deferred.push({ at: where, reason: renaming[0]!.message });
      continue;
    }
    parsed++;
    for (const diagnostic of diagnostics) {
      errors.push(`${where}: MX block ${diagnostic.line}:${diagnostic.column + 1}: ${diagnostic.message}`);
    }
  }
  const byReason = new Map<string, number>();
  for (const { reason } of deferred) byReason.set(reason, (byReason.get(reason) ?? 0) + 1);
  console.log(`Docs MX samples: parsed ${parsed} (${v4} of them ${DOCS_SYNTAX} entity files, parsed without contracts), deferred ${deferred.length}, skipped ${skipped} fragments`);
  for (const [reason, count] of byReason) console.log(`  deferred (${count}): ${reason}`);
  if (parsed === 0 && deferred.length === 0) errors.push("Docs sample check parsed no complete entity blocks");
  return { parsed, skipped, deferred, errors };
}
