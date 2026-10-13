// What the printer wrote decides what a generated file imports and binds, never a search of the printed text, where an
// author's string or comment could spell `$.` or `$s` (the PR #98 finding). The end-to-end case is in
// `packages/cli/test/decided-imports.test.ts`.
import { describe, expect, test } from "bun:test";
import type { Expression, ExprNode } from "@meshfw/model";
import { emittedNothing, printExpression, printTree } from "../src/typescript/expression-printer.ts";
import { globalsImport, withoutStrings } from "../src/typescript/views/globals.ts";

const at = { file: "t.mesh.mx", line: 1, column: 0, offset: 0 };
const literal = (value: string): ExprNode => ({ kind: "literal", value, position: at });
const tree = (node: ExprNode): Expression => ({ tree: node, position: at, source: "", params: [], takesScope: false } as unknown as Expression);
const plain = (source: string, extra: Record<string, unknown> = {}): Expression =>
  ({ plain: { why: "block-body", edits: [], roots: [], helpers: [], mesh: [], ...extra }, position: at, source, params: [], takesScope: false } as unknown as Expression);

describe("printExpression records what it wrote", () => {
  test("a literal that spells `$.` or `$s` writes neither the runtime nor the scope, and the parameter is `_$s`", () => {
    for (const text of ["$.", "$s", "$s $.", "/* $. */"]) {
      const emitted = emittedNothing();
      const code = printExpression(tree(literal(text)), "Scope", false, false, undefined, undefined, emitted);
      expect(emitted).toEqual({ expr: false, scope: false });
      expect(code).toStartWith("(_$s: Scope) => ");
    }
  });

  test("a call writes the runtime; a read of a scope root writes the scope, and the parameter is then `$s`", () => {
    const call: ExprNode = { kind: "call", fn: "ne", args: [literal("$."), literal("$s")], position: at } as ExprNode;
    const first = emittedNothing();
    expect(printExpression(tree(call), "Scope", true, false, undefined, undefined, first)).toStartWith("(_$s: Scope) => $.ne(");
    expect(first).toEqual({ expr: true, scope: false });
    const read: ExprNode = { kind: "member", object: { kind: "var", name: "self", position: at }, name: "n", optional: false, position: at } as ExprNode;
    const second = emittedNothing();
    expect(printExpression(tree(read), "Scope", false, false, undefined, undefined, second)).toStartWith("($s: Scope) => $s.self");
    expect(second).toEqual({ expr: false, scope: true });
  });

  test("a plain function whose text spells `$.` and `$s` in a string, a comment and a template writes neither", () => {
    const source = '() => { /* $. $s */ const a = "$."; const b = `$s ${a}`; return a + b }';
    const emitted = emittedNothing();
    const code = printExpression(plain(source), "Scope", false, false, undefined, undefined, emitted);
    expect(emitted).toEqual({ expr: false, scope: false });
    expect(code).toStartWith("(_$s: Scope) => ");
  });

  test("what Mesh's own edits read is recorded: the instant writes the runtime and the scope", () => {
    const emitted = emittedNothing();
    const code = printExpression(plain("() => 1", { internal: { now: "$now" } }), "Scope", false, false, undefined, undefined, emitted);
    expect(emitted).toEqual({ expr: true, scope: true });
    expect(code).toStartWith("($s: Scope) => ");
    expect(code).toContain("const $now = () => $.now($s);");
  });

  test("a printTree call without a record still prints", () => {
    expect(printTree(literal("$."))).toBe('"$."');
  });
});

describe("the globals a file imports", () => {
  test("a file path or an expression comment spelling `$Date` imports nothing; a string never does", () => {
    expect(globalsImport("a/b", { entityFile: "domain/$Date.mesh.mx", entries: [{ comment: "computed $Pick (domain/$Date.mesh.mx:1:1)", code: "1" }] })).toBeNull();
    expect(globalsImport("a/b", { text: 'x: "$Date" = 1' })).toBeNull();
    expect(globalsImport("a/b", { text: "x: $Date" })?.names).toBe("$Date");
  });

  test("withoutStrings empties double-quoted literals, escapes included", () => {
    expect(withoutStrings('a("$record", "q\\"$record") + $record')).toBe('a("", "") + $record');
  });
});
