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
  if (typeof v === "object") return "{…}";
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
    "Anything not listed here (string ordering, truthiness, `==`, string concatenation, string methods) is not translated: it stays plain TypeScript with JavaScript's rules, and the build warns.",
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
