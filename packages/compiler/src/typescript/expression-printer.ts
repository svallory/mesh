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
const ROOTS = ["self", "input", "actor", "context", "before"] as const;

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

/** The whole function of one expression: `(s: Scope) => ...`. */
export function printExpression(e: Expression, scopeType: string, boolean: boolean, async = false, entities: EntityLocals = NO_ENTITIES): string {
  const withScope = (body: string) => `(${/\$s(?![A-Za-z0-9_$])/.test(body) ? SCOPE : `_${SCOPE}`}: ${scopeType}) => ${body}`;
  if (e.tree) return withScope(printTree(e.tree, boolean));
  const plain = e.plain!;
  let text = e.source;
  for (const edit of [...plain.edits].sort((a, b) => b.from - a.from))
    text = text.slice(0, edit.from) + edit.text + text.slice(edit.to);
  // A `run` body may await: it is the one plain function that is async (a returned promise is awaited by the action).
  const authored = plain.method ? `function ${text}` : text;
  const fn = async && !/^\s*async\b/.test(authored) ? `async ${authored}` : authored;
  // The scope names the function reads without its parameters binding them (the front end found them in the syntax tree).
  const declare = (plain.roots.length ? `const { ${plain.roots.join(", ")} } = ${SCOPE}; ` : "") +
    (plain.clock ?? []).map((name) => `const ${name} = () => $.${name}(${SCOPE}); `).join("") +
    (plain.isSystem ? "const isSystem = $.isSystem; " : "") +
    (plain.privileged ? `const privileged = ${PRIVILEGED}; ` : "") +
    // Each entity the function names, bound when the function runs (an import cycle between two entities' files has
    // finished loading by then) and typed so that what its actions resolve with is read-only (CMP-16).
    (plain.entities ?? []).map((name) => {
      const { value, type } = entities(name);
      return `const ${name}: ${type} = ${value}; `;
    }).join("");
  return withScope(`{ ${declare}return (${fn})(${e.takesScope || e.params.length ? SCOPE : ""}); }`);
}

/** How the expressions file imports `privileged` (TXN-16). */
export const PRIVILEGED = "$privileged";
/**
 * The locals the expressions file imports an entity value and its read-only type under, by the name a function of the
 * entity file gives the entity (CMP-16): `List` (or the alias `BList`) to `{ value: "$b$List$value", type: "$b$List$ReadOnly" }`.
 */
export type EntityLocals = (name: string) => { readonly value: string; readonly type: string };
const NO_ENTITIES: EntityLocals = (name) => {
  throw new Error(`No local for the entity ${name}`);
};

/** Names in `names` that a plain expression's authored text mentions. */
export function mentioned(e: Expression, names: Iterable<string>): string[] {
  return [...names].filter((name) => new RegExp(`(?<![A-Za-z0-9_$.])${name.replace(/\$/g, "\\$")}\\b`).test(e.source));
}
