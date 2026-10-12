import type { ExprNode, Expression } from "@meshfw/model";

/**
 * Prints an expression as TypeScript over `@meshfw/runtime`'s `expr` namespace (imported as
 * `$`), reading the model only. A tree becomes a call chain, so the generated file shows the
 * rule; a plain expression keeps its authored text with `&name` and `:atom` desugared.
 */
/**
 * Internal names are `$` (the functions) and `$s` (the scope). An authored name can be anything,
 * so every authored local is printed with the prefix `l$`, which neither internal name has.
 */
const SCOPE = "$s";
const local = (name: string) => `l$${name}`;
const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
/** The names of the scope a function is handed, in the order a function binds them. */
export const ROOTS = ["self", "input", "actor", "context", "before"] as const;

function access(name: string, optional: boolean): string {
  return IDENTIFIER.test(name) ? `${optional ? "?." : "."}${name}` : `${optional ? "?." : ""}[${JSON.stringify(name)}]`;
}

/** A tree as one TypeScript expression of the scope `$s`. `bool` says the value sits where a boolean is required. */
export function printTree(n: ExprNode, bool = false): string {
  switch (n.kind) {
    case "literal": return JSON.stringify(n.value);
    case "atom": return JSON.stringify(n.value);
    case "var": return ROOTS.includes(n.name as (typeof ROOTS)[number]) ? `${SCOPE}.${n.name}` : local(n.name);
    case "member": {
      // Every access is `?.` except on the roots that are never null: a null anywhere in a chain gives null, as a left join does.
      const safe = n.object.kind === "var" && (n.object.name === "self" || !ROOTS.includes(n.object.name as (typeof ROOTS)[number]));
      return `${printTree(n.object)}${access(n.name, n.optional || !safe)}`;
    }
    case "call": {
      if (n.fn === "now" || n.fn === "today") return `$.${n.fn}(${SCOPE})`;
      const booleanArgs = n.fn === "and" || n.fn === "or" || n.fn === "not";
      const args = n.args.map((a, i) => printTree(a, booleanArgs || (n.fn === "cond" && i === 0)));
      return `$.${n.fn}(${args.join(", ")})`;
    }
    case "helper": {
      // Through `$.pure`: an imported function a translated expression calls must not return a promise (EXP-03).
      const call = `$.pure(${n.name}(${n.args.map((a) => printTree(a)).join(", ")}), ${JSON.stringify(n.name)})`;
      return bool ? `$.asBool(${call})` : call;
    }
    case "quantify": return `$.${n.op}(${printTree(n.source)}, (${local(n.param)}: any) => ${printTree(n.body, true)})`;
  }
}

/**
 * What a plain function names only in its types, which the front end does not see (MX strips the types from the node it
 * reads), as `typeNames` found it in the function printed without it. Each is bound as the names the function reads as
 * values are.
 */
export interface NamedInTypes {
  /** Scope roots read only in a `typeof` (`typeof input.id`): bound with the roots the function reads. */
  readonly roots: readonly string[];
  /** Entities read only in a `typeof` (`typeof List`): bound to their value, as an entity the function reads is. */
  readonly values: readonly string[];
  /** Entities named as a type (`List | null`): bound to their record type, `type List = $b$List$Record`. */
  readonly types: readonly string[];
  /** Names of the file's `Mesh` import read only in a `typeof` (`ReturnType<typeof Mesh.now>`): bound as a `Mesh` read as a value is. */
  readonly mesh?: readonly string[];
}
const NOTHING: NamedInTypes = { roots: [], values: [], types: [] };

/** The whole function of one expression: `(s: Scope) => ...`. */
export function printExpression(e: Expression, scopeType: string, boolean: boolean, async = false, entities: EntityLocals = NO_ENTITIES, inTypes: NamedInTypes = NOTHING): string {
  const withScope = (body: string) => `(${/\$s(?![A-Za-z0-9_$])/.test(body) ? SCOPE : `_${SCOPE}`}: ${scopeType}) => ${body}`;
  if (e.tree) return withScope(printTree(e.tree, boolean));
  const plain = e.plain!;
  let text = e.source;
  for (const edit of [...plain.edits].sort((a, b) => b.from - a.from))
    text = text.slice(0, edit.from) + edit.text + text.slice(edit.to);
  // A `run` body may await: it is the one plain function that is async (a returned promise is awaited by the action).
  const authored = plain.method ? `function ${text}` : text;
  const fn = async && !/^\s*async\b/.test(authored) ? `async ${authored}` : authored;
  // The scope names the function reads without its parameters binding them: the front end found the ones read as values
  // in the syntax tree, `typeNames` the ones read only in a type.
  const roots = ROOTS.filter((name) => plain.roots.includes(name) || inTypes.roots.includes(name));
  // Each name the file imports `Mesh` under: Mesh's functions as this evaluation sees them, `now` and `today` reading the
  // scope's instant, so a plain function and a translated one read one instant (PRJ-22).
  const mesh = [...new Set([...(plain.mesh ?? []), ...(inTypes.mesh ?? [])])].sort();
  const declare = (roots.length ? `const { ${roots.join(", ")} } = ${SCOPE}; ` : "") +
    mesh.map((name) => `const ${name} = ${MESH}(${SCOPE}); `).join("") +
    // `structuredClone` cannot copy the read-only views a function is handed (they are proxies); `cloneValue` can. It is
    // bound here, not at module level, so the file declares no name an entity file's helper import could also have.
    (plain.structuredClone ? `const structuredClone = ${CLONE_VALUE}; ` : "") +
    // Each entity the function names, bound when the function runs (an import cycle between two entities' files has
    // finished loading by then) and typed so that what its actions resolve with is read-only (CMP-16).
    [...(plain.entities ?? []), ...inTypes.values].map((name) => {
      const { value, type } = entities(name);
      return `const ${name}: ${type} = ${value}; `;
    }).join("") +
    // An entity named as a type is its record type, as the barrel exports it with the value (CMP-17).
    inTypes.types.map((name) => `type ${name} = ${entities(name).record}; `).join("");
  return withScope(`{ ${declare}return (${fn})(${e.takesScope || e.params.length ? SCOPE : ""}); }`);
}

/** How the expressions file imports `meshIn`, which gives `Mesh` as one evaluation sees it (PRJ-22). */
export const MESH = "$mesh";
/** How the expressions file imports `cloneValue`, which a function that calls the global `structuredClone` binds under that name. */
export const CLONE_VALUE = "$cloneValue";
/**
 * The locals the expressions file imports an entity value, its read-only type and its record type under, by the name a
 * function of the entity file gives the entity (CMP-16): `List` (or the alias `BList`) to `{ value: "$b$List$value",
 * type: "$b$List$ReadOnly", record: "$b$List$Record" }`.
 */
export type EntityLocals = (name: string) => { readonly value: string; readonly type: string; readonly record: string };
const NO_ENTITIES: EntityLocals = (name) => {
  throw new Error(`No local for the entity ${name}`);
};
