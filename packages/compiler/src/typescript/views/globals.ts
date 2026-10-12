import { dirname, relative } from "node:path";

/**
 * The JavaScript globals generated code uses, each reached through `<output>/$globals.ts` under a `$` name. No name an
 * entity file declares or imports can be one: CMP-06 refuses a `$` at the start of every import binding (a helper or an
 * entity's alias), and an entity's type name keeps only letters, digits and leading underscores. So an entity named
 * `Promise`, `Date`, `Pick` or `Set`, or an alias or helper so named, hides nothing the generated code reads (PRJ-20:
 * Mesh imposes no rule on a name because of the code it generates). `Record` is not among them: generated code writes
 * an index signature instead, since the actions file already imports its entity's record type as `$Record`.
 */
export const GLOBAL_ALIASES = Object.freeze([
  { global: "Date", value: true, type: "Date", params: "" },
  { global: "Object", value: true, type: null, params: "" },
  { global: "Omit", value: false, type: "Omit<T, K>", params: "<T, K extends keyof any>" },
  { global: "Partial", value: false, type: "Partial<T>", params: "<T>" },
  { global: "Pick", value: false, type: "Pick<T, K>", params: "<T, K extends keyof T>" },
  { global: "Promise", value: false, type: "Promise<T>", params: "<T>" },
  { global: "RegExp", value: true, type: null, params: "" },
  { global: "Set", value: true, type: null, params: "" },
] as const);

export type GlobalName = (typeof GLOBAL_ALIASES)[number]["global"];

/** How generated code names a global: `$Date`, `$Promise`. */
export const globalAlias = (name: GlobalName): string => `$${name}`;

/**
 * What `globals.ts.jig` renders: `<output>/$globals.ts`, one alias per global (`export const $Date = Date;` and
 * `export type $Date = Date;`). It imports nothing and declares no entity name, so each right-hand side is the global.
 * A project's own `globals.ts.jig` depends on this shape.
 */
export interface GlobalsView {
  readonly aliases: readonly GlobalAlias[];
}

/** One global under its `$` name: a value alias when `value` is set, a type alias when `type` is. */
export interface GlobalAlias {
  /** The alias, e.g. `$Promise`. */
  readonly name: string;
  /** The global value it stands for (`Date`), or null when generated code uses only the type. */
  readonly value: string | null;
  /** The type it stands for, over `params` (`Promise<T>`), or null when generated code uses only the value. */
  readonly type: string | null;
  /** The alias's type parameters as printed (`<T>`), or the empty string. */
  readonly params: string;
}

export function globalsView(): GlobalsView {
  return {
    aliases: GLOBAL_ALIASES.map((entry) => ({
      name: globalAlias(entry.global),
      value: entry.value ? entry.global : null,
      type: entry.type,
      params: entry.params,
    })),
  };
}

/** The file's import of the globals it uses: `import { $Date, type $Pick } from "../../$globals";`, or `import type` when it uses no value. */
export interface GlobalsImport {
  /** True when every name is imported as a type. */
  readonly typeOnly: boolean;
  /** `import type` when `typeOnly`, else `import`. */
  readonly keyword: "import" | "import type";
  /** The names as printed: `$Date, type $Pick`, or `$Pick, $Promise` when `typeOnly`. */
  readonly names: string;
  /** The specifier of `$globals.ts` from the importing file, a quoted string literal, e.g. `"../../$globals"`. */
  readonly fromLiteral: string;
}

/** `$Date` as a reference: not a member (`x.$Date`), not part of a longer name, not a property key (`$Date: 1`). */
const ALIAS = new RegExp(`(?<![A-Za-z0-9_$.])\\$(${GLOBAL_ALIASES.map((entry) => entry.global).join("|")})(?![A-Za-z0-9_$]|\\??:)`, "g");
/** A double-quoted string literal, as `JSON.stringify` prints one: an authored message is never a reference. */
const STRING = /"(?:[^"\\]|\\.)*"/g;

/** Every string in `value`, at any depth: what a view prints. */
function stringsOf(value: unknown, into: string[]): string[] {
  if (typeof value === "string") into.push(value);
  else if (Array.isArray(value)) for (const item of value) stringsOf(item, into);
  else if (value && typeof value === "object") for (const item of Object.values(value)) stringsOf(item, into);
  return into;
}

/**
 * The import of the globals a generated file uses: those its view's strings name (outside string literals) and the ones
 * its template prints itself (`fixed`). `file` is the importing file's path below the output directory, without its
 * extension (`domain/work/task.actions`). `types` says the file names them only as types (a types file), so even `$Date`
 * is imported with `import type`. Null when it uses none.
 */
export function globalsImport(file: string, view: unknown, fixed: readonly GlobalName[] = [], types = false): GlobalsImport | null {
  const used = new Set<string>(fixed);
  for (const text of stringsOf(view, [])) for (const match of text.replace(STRING, '""').matchAll(ALIAS)) used.add(match[1]!);
  const entries = GLOBAL_ALIASES.filter((entry) => used.has(entry.global));
  if (entries.length === 0) return null;
  const typeOnly = types || entries.every((entry) => !entry.value);
  let path = relative(dirname(file), "$globals").replace(/\\/g, "/");
  if (!path.startsWith(".")) path = `./${path}`;
  return {
    typeOnly,
    keyword: typeOnly ? "import type" : "import",
    names: entries.map((entry) => `${typeOnly || entry.value ? "" : "type "}${globalAlias(entry.global)}`).join(", "),
    fromLiteral: JSON.stringify(path),
  };
}
