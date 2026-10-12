// `typeNames` finds the helpers a printed plain function names only in its types, which MX strips from the node the
// front end reads. Each case is one printed function and the candidates it reads in a type position no scope hides.
import { expect, test } from "bun:test";
import { typeNames } from "../src/typescript/type-names.ts";

const candidates = new Set(["Money", "fmt", "input", "Box"]);

test.each([
  // Read: a type reference, a `typeof` query, a qualified name's first part, an `extends` clause, a nested function's type.
  ["const x: Money = 1; return x", ["Money"]],
  ["const f: typeof fmt = (n: number) => String(n); return f(1)", ["fmt"]],
  ["const x: Money.Amount = 1; return x", ["Money"]],
  ["interface I extends Money {} return 1", ["Money"]],
  ["return { a: (x: Money) => x }.a(1)", ["Money"]],
  ["return (x: { fmt: typeof fmt }) => x", ["fmt"]],
  ["return 1 as unknown as Box<Money>", ["Box", "Money"]],
  // A variable has no type meaning, so it hides no type of its name (TypeScript resolves `Money` to the import).
  ["const Money = 1; const x: Money = Money; return x", ["Money"]],
  ["const { input } = $s; const y: typeof input = input; let z: input; return y", ["input"]],
  // A local type in another block does not reach this one.
  ["if (1) { type Money = 1 } const x: Money = 1; return x", ["Money"]],
  // Hidden: a local variable for `typeof`, a local type, interface, class or enum, a type parameter, `infer`, a mapped key.
  ["const fmt = 1; const f: typeof fmt = 2; return f", []],
  ["return (fmt: number) => { const y: typeof fmt = fmt; return y }", []],
  ["type Money = string; const x: Money = ''; return x", []],
  ["interface Money { a: 1 } const x: Money = { a: 1 }; return x", []],
  ["class Money {} const x: Money = new Money(); return x", []],
  ["enum Money { A } const x: Money = Money.A; return x", []],
  ["return <Money,>(x: Money) => x", []],
  ["function g<Money>(x: Money): Money { return x } return g(1)", []],
  ["type T<X> = X extends [infer Money] ? Money : 0; return 1 as T<[1]>", []],
  ["type M = { [Money in 'a']: Money }; return 1", []],
  // Not a type position: a string, a member, a key.
  ["return 'Money' + fmt.length + { Box: 1 }.Box", []],
] as const)("%s", (body, expected) => {
  expect([...typeNames(`($s: S) => { ${body} }`, candidates)].sort()).toEqual([...expected].sort());
});

test("the branch of a conditional type that does not match sees no `infer` name", () => {
  expect([...typeNames("($s: S) => { type T<X> = X extends Box<infer Money> ? Money : Money; return 1 }", candidates)].sort()).toEqual(["Box", "Money"]);
});

test("code that names no candidate is not parsed, and code the parser refuses gives nothing", () => {
  expect([...typeNames("syntax error (", new Set(["Money"]))]).toEqual([]);
  expect([...typeNames("($s: S) => { syntax error ( Money", candidates)]).toEqual([]);
});
