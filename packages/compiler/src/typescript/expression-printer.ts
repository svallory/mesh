import { lazyOperands, type ExprNode, type Expression } from "@meshfw/model";

/**
 * Prints an expression as TypeScript over `@meshfw/runtime`'s `expr` namespace (imported as
 * `$`), reading the model only. A tree becomes a call chain, so the generated file shows the
 * rule; a plain expression keeps its authored text with `&name` and `:atom` desugared.
 */
/**
 * Internal names are `$` (the functions) and `$s` (the scope). An authored name can be anything,
 * so every authored local is printed with the prefix `l$`, which neither internal name has. A plain
 * function keeps its authored names, so it reads neither: its edits read the names `internal` gives
 * the record and the instant (`$self`, `$now`, `$today`), which its text does not spell.
 */
const SCOPE = "$s";
const local = (name: string) => `l$${name}`;
const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
/** The names of the scope a function is handed, in the order a function binds them. */
export const ROOTS = ["self", "input", "actor", "context", "before"] as const;

function access(name: string, optional: boolean): string {
  return IDENTIFIER.test(name) ? `${optional ? "?." : "."}${name}` : `${optional ? "?." : ""}[${JSON.stringify(name)}]`;
}

/**
 * What the printer itself wrote into a function, recorded as it writes, so the file's imports and the function's
 * parameter name follow from what was printed and never from a search of the text, where an author's string or comment
 * could spell `$.` or `$s`.
 */
export interface Emitted {
  /** The printer wrote a call on the runtime's `expr` namespace (`$.`), so the file imports it. */
  expr: boolean;
  /** The printer wrote a read of the scope (`$s`), so the function's parameter is named. */
  scope: boolean;
}
export const emittedNothing = (): Emitted => ({ expr: false, scope: false });

/** A tree as one TypeScript expression of the scope `$s`. `bool` says the value sits where a boolean is required. */
export function printTree(n: ExprNode, bool = false, emitted: Emitted = emittedNothing()): string {
  switch (n.kind) {
    case "literal": return JSON.stringify(n.value);
    case "atom": return JSON.stringify(n.value);
    case "var": {
      if (!ROOTS.includes(n.name as (typeof ROOTS)[number])) return local(n.name);
      emitted.scope = true;
      return `${SCOPE}.${n.name}`;
    }
    case "member": {
      // Every access is `?.` except on the roots that are never null: a null anywhere in a chain gives null, as a left join does.
      const safe = n.object.kind === "var" && (n.object.name === "self" || !ROOTS.includes(n.object.name as (typeof ROOTS)[number]));
      return `${printTree(n.object, false, emitted)}${access(n.name, n.optional || !safe)}`;
    }
    case "call": {
      emitted.expr = true;
      if (n.fn === "now" || n.fn === "today") {
        emitted.scope = true;
        return `$.${n.fn}(${SCOPE})`;
      }
      const booleanArgs = n.fn === "and" || n.fn === "or" || n.fn === "not";
      // The right side of `&&`, `||` and `??` and both branches of `?:` are thunks, so what a guard rules out never runs.
      const lazy = lazyOperands(n.fn);
      const args = n.args.map((a, i) => {
        const text = printTree(a, booleanArgs || (n.fn === "cond" && i === 0), emitted);
        return lazy.includes(i) ? `() => ${text.startsWith("{") ? `(${text})` : text}` : text;
      });
      return `$.${n.fn}(${args.join(", ")})`;
    }
    case "helper": {
      emitted.expr = true;
      // Through `$.pure`: an imported function a translated expression calls must not return a promise.
      const call = `$.pure(${n.name}(${n.args.map((a) => printTree(a, false, emitted)).join(", ")}), ${JSON.stringify(n.name)})`;
      return bool ? `$.asBool(${call})` : call;
    }
    case "quantify": emitted.expr = true; return `$.${n.op}(${printTree(n.source, false, emitted)}, (${local(n.param)}: any) => ${printTree(n.body, true, emitted)})`;
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
}
const NOTHING: NamedInTypes = { roots: [], values: [], types: [] };

/** The whole function of one expression: `(s: Scope) => ...`. */
export function printExpression(e: Expression, scopeType: string, boolean: boolean, async = false, entities: EntityLocals = NO_ENTITIES, inTypes: NamedInTypes = NOTHING, emitted: Emitted = emittedNothing()): string {
  // The parameter is `_$s` unless the printed body reads it: an unused parameter fails `noUnusedParameters`.
  const withScope = (body: string) => `(${emitted.scope ? SCOPE : `_${SCOPE}`}: ${scopeType}) => ${body}`;
  if (e.tree) return withScope(printTree(e.tree, boolean, emitted));
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
  // What Mesh's own edits read, under names the authored text does not spell, so no local or parameter of the author's
  // (`self`, `$`, `$s`) hides them: `&name` reads the record (`$self.name`), and `%.now` and `%.today` call the functions
  // a translated expression calls (`$now()`), so a plain function and a translated one read one instant, a fresh
  // `Date` each read. `Mesh` is the file's import, as a helper is.
  const internal = plain.internal ?? {};
  if (roots.length || internal.self || internal.now || internal.today || e.takesScope || e.params.length) emitted.scope = true;
  if (internal.now || internal.today) emitted.expr = true;
  const declare = (roots.length ? `const { ${roots.join(", ")} } = ${SCOPE}; ` : "") +
    (internal.self ? `const ${internal.self} = ${SCOPE}.self; ` : "") +
    (internal.now ? `const ${internal.now} = () => $.now(${SCOPE}); ` : "") +
    (internal.today ? `const ${internal.today} = () => $.today(${SCOPE}); ` : "") +
    // `structuredClone` cannot copy the read-only views a function is handed (they are proxies); `cloneValue` can. It is
    // bound here, not at module level, so the file declares no name an entity file's helper import could also have.
    (plain.structuredClone ? `const structuredClone = ${CLONE_VALUE}; ` : "") +
    // Each entity the function names, bound when the function runs (an import cycle between two entities' files has
    // finished loading by then) and typed so that what its actions resolve with is read-only.
    [...(plain.entities ?? []), ...inTypes.values].map((name) => {
      const { value, type } = entities(name);
      return `const ${name}: ${type} = ${value}; `;
    }).join("") +
    // An entity named as a type is its record type, as the barrel exports it with the value.
    inTypes.types.map((name) => `type ${name} = ${entities(name).record}; `).join("");
  return withScope(`{ ${declare}return (${fn})(${e.takesScope || e.params.length ? SCOPE : ""}); }`);
}

/** How the expressions file imports `cloneValue`, which a function that calls the global `structuredClone` binds under that name. */
export const CLONE_VALUE = "$cloneValue";
/**
 * The locals the expressions file imports an entity value, its read-only type and its record type under, by the name a
 * function of the entity file gives the entity: `List` (or the alias `BList`) to `{ value: "$b$List$value",
 * type: "$b$List$ReadOnly", record: "$b$List$Record" }`.
 */
export type EntityLocals = (name: string) => { readonly value: string; readonly type: string; readonly record: string };
const NO_ENTITIES: EntityLocals = (name) => {
  throw new Error(`No local for the entity ${name}`);
};
