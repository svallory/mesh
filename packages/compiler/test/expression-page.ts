import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { FUNCTIONS } from "@meshfw/model";
import { EXPRESSION_TABLES, QUANTIFIER_TABLES } from "@meshfw/runtime/testing";

/** The reference page for the function tables. Generated from the test data, so the page and the tests cannot differ; `expressions.test.ts` fails when the file is stale. */
export const PAGE_PATH = join(import.meta.dir, "../../../apps/docs/docs/architecture/in-depth/expression-functions.md");

const show = (v: unknown): string => {
  if (v === null || v === undefined) return "null";
  if (v instanceof Date) return `D(${v.getTime()})`;
  if (Array.isArray(v)) return `[${v.map(show).join(", ")}]`;
  if (typeof v === "object") {
    const entries = Object.entries(v as Record<string, unknown>);
    return entries.length ? `{ ${entries.map(([key, value]) => `${key}: ${show(value)}`).join(", ")} }` : "{}";
  }
  // Non-ASCII text is shown as code points, so a precomposed and a decomposed letter differ on the page.
  if (typeof v === "string") return JSON.stringify(v).replace(/[^\x20-\x7e]/gu, (c) => `\\u{${c.codePointAt(0)!.toString(16)}}`);
  if (Object.is(v, -0)) return "-0";
  return String(v);
};
const cell = (v: string) => `\`${v.replace(/\|/g, "\\|")}\``;

export function renderExpressionPage(): string {
  const out: string[] = [
    "---",
    'title: "Expression functions"',
    'description: "Every function and operator a translated expression may use, with its inputs and outputs, null cases included. The written definition of ADR-0012."',
    "---",
    "",
    "# Expression functions",
    "",
    "This page is generated from the test data (`EXPRESSION_TABLES` and `QUANTIFIER_TABLES` in `@meshfw/runtime/testing`); a test fails when it is out of date. It is the written definition of [ADR-0012](../decisions/0012-expression-semantics.md), option A: Mesh defines each function, follows SQL's three-valued logic where the databases agree, and the in-memory form and every SQL evaluator must give these answers. How the rules are applied is in [Expressions](./expressions.md).",
    "",
    "`null` is both NULL and an unknown boolean. `D(n)` is the instant `n` milliseconds after the epoch. `T` stands for one class of number, string, boolean, date or enum, the same on both sides.",
    "",
    "In memory, the right side of `&&`, `||` and `??` and both branches of `?:` are evaluated only when the left side or the test lets them: `a && b` does not evaluate `b` when `a` is false, `a || b` not when `a` is true, `a ?? b` not when `a` is not null, and `c ? x : y` only the branch it takes. An unknown (`null`) left side still evaluates `b`, as SQL would, and a test that is unknown takes the else branch. The tables hold the results; they do not change with this. An imported helper behind such a guard therefore runs only when the guard lets it.",
    "",
    "Anything not listed here (string ordering, truthiness, `==`, string concatenation, string methods) is not translated: it stays plain TypeScript with JavaScript's rules, and the build warns.",
    "",
    "`%.now` and `%.today` are properties of `%`, the current transaction: its instant and its date, values and not calls, written with no import. One transaction has one instant: every action and read that joins it reads the instant of the call or `transaction` that opened it. `Mesh.isSystem(context)` is one of Mesh's own functions, members of `Mesh`, which an entity file imports from `meshfw`: `import { Mesh } from \"meshfw\"` (or under an alias, `import { Mesh as M } from \"meshfw\"`, then `M.isSystem(context)`).",
    "",
  ];
  for (const spec of FUNCTIONS) {
    out.push(`## \`${spec.spelling}\` (${spec.id})`, "", `Signature: \`${spec.signature}\`. Null behaviour: ${spec.nulls}.`, "");
    const cases = EXPRESSION_TABLES[spec.id]!;
    const head = spec.arity === 0 ? ["Clock"] : Array.from({ length: spec.arity }, (_, i) => `Argument ${i + 1}`);
    out.push(`| ${[...head, "Result"].join(" | ")} |`, `|${[...head, "Result"].map(() => ":--").join("|")}|`);
    for (const c of cases) {
      const args = spec.arity === 0 ? [`D(${c.clock})`] : c.args.map(show);
      out.push(`| ${[...args, show(c.result)].map(cell).join(" | ")} |`);
    }
    out.push("");
  }
  out.push("## Quantifiers over a loaded has-many", "",
    "`some`, `every`, `find` and `filter` take a list and a predicate. The column lists the predicate's result for each element, in order (`T` true, `F` false, `N` unknown); the elements are numbered from 0. An unknown predicate never makes `some` true and always makes `every` false; M10 translates `every(p)` as `NOT EXISTS (… WHERE p IS NOT TRUE)`. A list that was not loaded throws `FrameworkError`.", "");
  for (const op of ["some", "every", "find", "filter"] as const) {
    out.push(`### \`${op}\``, "", "| Predicate results | Result |", "|:--|:--|");
    for (const c of QUANTIFIER_TABLES[op])
      out.push(`| ${cell(`[${c.outcomes.map((o) => (o === null ? "N" : o ? "T" : "F")).join(", ")}]`)} | ${cell(show(c.result))} |`);
    out.push("");
  }
  return `${out.join("\n").trimEnd()}\n`;
}

if (import.meta.main) {
  writeFileSync(PAGE_PATH, renderExpressionPage());
  console.log(`wrote ${PAGE_PATH}`);
}
