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
const ROOTS = ["self", "input", "actor", "context", "before", "tx"] as const;

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
      const call = `${n.name}(${n.args.map((a) => printTree(a)).join(", ")})`;
      return bool ? `$.asBool(${call})` : call;
    }
    case "quantify": return `$.${n.op}(${printTree(n.source)}, (${local(n.param)}: any) => ${printTree(n.body, true)})`;
  }
}

/** The whole function of one expression: `(s: Scope) => ...`. */
export function printExpression(e: Expression, scopeType: string, boolean: boolean, async = false): string {
  const withScope = (body: string) => `(${/\$s(?![A-Za-z0-9_$])/.test(body) ? SCOPE : `_${SCOPE}`}: ${scopeType}) => ${body}`;
  if (e.tree) return withScope(printTree(e.tree, boolean));
  const plain = e.plain!;
  let text = e.source;
  for (const edit of [...plain.edits].sort((a, b) => b.from - a.from))
    text = text.slice(0, edit.from) + edit.text + text.slice(edit.to);
  // A `run` body may await: it is the one plain function that is async (a returned promise is awaited by the action).
  const authored = plain.method ? `function ${text}` : text;
  const fn = async && !/^\s*async\b/.test(authored) ? `async ${authored}` : authored;
  // Roots the authored parameters destructure are bound by the function itself; the rest it reads from the scope.
  const used = ROOTS.filter((root) => !e.params.includes(root) && new RegExp(`(?<![A-Za-z0-9_$.])${root}\\b`).test(text));
  const declare = used.length ? `const { ${used.join(", ")} } = ${SCOPE}; ` : "";
  return withScope(`{ ${declare}return (${fn})(${e.params.length ? SCOPE : ""}); }`);
}

/** Names in `names` that a plain expression's authored text mentions. */
export function mentioned(e: Expression, names: Iterable<string>): string[] {
  return [...names].filter((name) => new RegExp(`(?<![A-Za-z0-9_$.])${name.replace(/\$/g, "\\$")}\\b`).test(e.source));
}
