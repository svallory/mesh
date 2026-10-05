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
 * The operator's entity file syntax v3 (ruling of 2026-10-05 evening, ADR-0066):
 * a declaration is `kind :name` and every name, reference and fixed-set value is
 * an atom, so every Docs sample is a v3 entity file and today's contracts cannot
 * read one. Two rules keep the check honest while the atoms realignment has not
 * run:
 *
 *  - a v3 block is parsed for real, by `parseData` with no contracts, after one
 *    in-memory normalisation of the spellings MX does not parse yet;
 *  - its parse with the contracts is deferred, counted and printed under one name.
 *
 * The spellings the normalisation covers are the ones MX has queued (decisions
 * 145 and 146): an atom in a value, and a tagless `:field=value` line, which
 * needs the parent's `defaultTag`.
 */
export const DOCS_SYNTAX = "syntax v3";

/** The one named reason a v3 block's contracts parse is deferred under. */
export const DOCS_SYNTAX_PENDING_ATOMS = `${DOCS_SYNTAX}, pending the atoms realignment`;

/** A complete v3 entity file: comments and imports may come first, then `entity :Name`. */
export function isV3EntityFile(block: string): boolean {
  for (const line of block.split("\n")) {
    const text = line.trim();
    if (text === "" || text.startsWith("//")) continue;
    if (text.startsWith("import ")) continue;
    return /^entity\s+:\w+/.test(text);
  }
  return false;
}

/**
 * Rewrites the v3 spellings MX cannot parse yet into today's, in memory only.
 * One function, four rules, in the order they must run:
 *
 *  - a relationship names its destination as an atom, `belongs-to=:Customer :customer`,
 *    becomes `belongs-to#customer=:Customer`: a value cannot be glued to a name
 *    (MX decision 146);
 *  - a tagless line in `set`, `:status=:sent`, becomes `#status=:sent`, the form
 *    today's parser reads as a line of the parent's default tag
 *    (MX decision 145, `defaultTag`);
 *  - a declaration name, `kind :name`, becomes `kind#name`, the one name sigil
 *    alpha.2 parses (it arrives as the tag's `name`);
 *  - every remaining atom becomes a string: `accept=[:title, :listId]`,
 *    `default=:draft`, `on=:create`, `on:load=:visible`, `self.status === :sent`.
 *    An atom is only recognised after the start of a line, whitespace, `=`, `[`,
 *    `(` or `,`, so an attribute name that contains a colon (`on:load`) and the
 *    ` : ` of a ternary are both left alone.
 *
 * Indentation, literals, arrow functions and block bodies are already today's
 * syntax and are kept exactly as written, as is every comment. This whole
 * function disappears when Mesh pins the MX alpha that parses atoms (decision
 * 156); nothing else in the check changes with it.
 */
const ATOM_AS_VALUE = /(^|[\s=[(,])\s*:([A-Za-z][\w-]*)/g;

export function normaliseV3(source: string): string {
  return source.split("\n").map((line) => {
    if (line.trim() === "" || line.trimStart().startsWith("//")) return line;
    const indent = line.slice(0, line.length - line.trimStart().length);
    const rest = line.trimStart();
    const relationship = /^([a-z][a-z0-9-]*)=:(\w+)\s+:(\w+)(.*)$/.exec(rest);
    const field = /^:(\w+)=(.*)$/.exec(rest);
    const named = /^([a-z][a-z0-9-]*)\s+:(\w+)(.*)$/.exec(rest);
    let rewritten = rest;
    if (relationship) rewritten = `${relationship[1]}#${relationship[3]}="${relationship[2]}"${relationship[4]}`;
    else if (field) rewritten = `#${field[1]}=${field[2]}`;
    else if (named) rewritten = `${named[1]}#${named[2]}${named[3]}`;
    // The last rule runs on the whole line, so an atom in the options of a
    // declaration (`create :create accept=[:title]`) is normalised as well.
    return `${indent}${rewritten.replace(ATOM_AS_VALUE, '$1"$2"')}`;
  }).join("\n");
}

/**
 * The options whose value is a name, a list of names or an enum value, and so
 * takes atoms and not strings ([ADR-0066](./0066-names-and-references-are-atoms.md)).
 * A quoted value in one of them is the old spelling, and a Docs page must not
 * carry it: `accept=["title"]` is the example the ruling calls out.
 */
const V3_ATOM_OPTIONS =
  /(?:^|[\s])(accept|auto|types|actions|load|sort|require|values|default|on|on:load|belongs-to|has-many|has-one)=("[^"]*"|\[[^\]]*"])/;

/**
 * The first line of a block that still writes a name as a string, or `null`.
 *
 * The parser cannot see this: `accept=["title"]` is perfectly good input to
 * MX, so the block would parse and the page would drift back to v2 without any
 * check noticing. Rule 2 of the syntax says this is an error, and this is where
 * the docs enforce it.
 */
export function quotedNameInV3(block: string): string | null {
  for (const [index, line] of block.split("\n").entries()) {
    const text = line.trim();
    if (text === "" || text.startsWith("//")) continue;
    // A `set` step's own line names a field with an atom, not an option, and the
    // first rule of the syntax is checked by the `entity :Name` root above.
    if (/^set\b/.test(text)) continue;
    const option = V3_ATOM_OPTIONS.exec(text);
    if (option) {
      const value = option[2]!;
      return `line ${index + 1}: \`${option[1]}\` takes ${value.startsWith("[") ? "names" : "a name"} as atoms, not strings (${text})`;
    }
    const oldName = /^[a-z][a-z0-9-]*\s+#(\w+)/.exec(text);
    if (oldName) return `line ${index + 1}: a declaration is \`kind :name options\`; \`#${oldName[1]}\` is the old spelling (${text})`;
  }
  return null;
}

/** Parses a v3 block with no contracts; a parser crash is a finding, not an exception. */
export function parseV3(source: string, file: string): DataDiagnostic[] {
  try {
    return parseData(normaliseV3(source), file).diagnostics;
  } catch (cause) {
    return [{ severity: "error", message: `MX could not parse the block at all: ${(cause as Error).message.split("\n")[0]}`, line: 1, column: 0, offset: 0 }];
  }
}

/**
 * The stricter companion: every MX fence on the Docs pages must be a complete v3
 * entity file, so a page cannot drift back to another syntax, and every one of them
 * must parse. A block whose root is not `entity :Name` fails here.
 */
export function checkDocsSyntaxV3(dir: string) {
  let checked = 0;
  const errors: string[] = [];
  for (const { name, line, block, closed } of docsMxBlocks(dir)) {
    const where = `${name}:${line}`;
    if (!closed) { errors.push(`${where}: unclosed MX fence`); continue; }
    if (!isV3EntityFile(block.join("\n"))) {
      errors.push(`${where}: MX fence is not a complete ${DOCS_SYNTAX} entity file: its root must be \`entity :Name\``);
      continue;
    }
    checked++;
    const quoted = quotedNameInV3(block.join("\n"));
    if (quoted) errors.push(`${where}: MX fence is not written in ${DOCS_SYNTAX}: ${quoted}`);
    for (const diagnostic of parseV3(`${block.join("\n")}\n`, where)) {
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
  let v3 = 0;
  const deferred: { at: string; reason: string }[] = [];
  const errors: string[] = [];
  for (const { name, line, block, closed } of docsMxBlocks(dir)) {
    const where = `${name}:${line}`;
    if (!closed) errors.push(`${where}: unclosed MX fence`);
    // A v3 entity file is parsed here for real, without the contracts, and its
    // contracts parse is deferred under one name rather than counted as a finding.
    if (isV3EntityFile(block.join("\n"))) {
      v3++;
      parsed++;
      deferred.push({ at: where, reason: DOCS_SYNTAX_PENDING_ATOMS });
      for (const diagnostic of parseV3(`${block.join("\n")}\n`, where)) {
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
  console.log(`Docs MX samples: parsed ${parsed} (${v3} of them ${DOCS_SYNTAX} entity files, parsed without contracts), deferred ${deferred.length}, skipped ${skipped} fragments`);
  for (const [reason, count] of byReason) console.log(`  deferred (${count}): ${reason}`);
  if (parsed === 0 && deferred.length === 0) errors.push("Docs sample check parsed no complete entity blocks");
  return { parsed, skipped, deferred, errors };
}
