// `typeNames` finds what a printed plain function names only in its types (helpers, scope roots, entities), which MX
// strips from the node the front end reads. Each case is one printed function and the candidates it reads in a type
// position no scope hides.
import { expect, test } from "bun:test";
import { typeNames } from "../src/typescript/type-names.ts";

const candidates = new Set(["Money", "fmt", "input", "Box"]);
/** Every candidate `code` reads in a type position, as a type or in a `typeof`. */
const all = (code: string, names: ReadonlySet<string> = candidates) => {
  const { types, values } = typeNames(code, names);
  return [...new Set([...types, ...values])].sort();
};

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
  expect(all(`($s: S) => { ${body} }`)).toEqual([...expected].sort());
});

test("the branch of a conditional type that does not match sees no `infer` name", () => {
  expect(all("($s: S) => { type T<X> = X extends Box<infer Money> ? Money : Money; return 1 }")).toEqual(["Box", "Money"]);
});

test("code that names no candidate is not parsed, and code the parser refuses gives nothing", () => {
  expect(all("syntax error (", new Set(["Money"]))).toEqual([]);
  expect(all("($s: S) => { syntax error ( Money")).toEqual([]);
});

test.each([
  // A type reference reads a type, a `typeof` query a value: `input` in `typeof input.id` is the scope root, while the
  // `input` of `let z: input` is a type of that name (a root is a value, as a parameter is).
  ["const id: typeof input.id = 'x'; let z: input; return id", { types: ["input"], values: ["input"] }],
  ["const x: Money = 1; const f: typeof fmt = String; return [x, f]", { types: ["Money"], values: ["fmt"] }],
  ["class C implements Box {} return new C()", { types: ["Box"], values: [] }],
] as const)("types and values apart: %s", (body, expected) => {
  const { types, values } = typeNames(`($s: S) => { ${body} }`, candidates);
  expect({ types: [...types].sort(), values: [...values].sort() }).toEqual({ types: [...expected.types], values: [...expected.values] });
});

test.each([
  // PR #94 review, item 3: a signature type's parameter is in scope in that signature, so `typeof fmt` reads it, not the
  // helper. Before, each of these imported the helper `fmt` as a type, unused (TS6133 under `--noUnusedLocals`).
  ["type F = (fmt: string) => typeof fmt; return 1", []],
  ["type F = (a: string, fmt: number) => typeof fmt; return 1", []],
  ["type F = ({ fmt }: { fmt: string }) => typeof fmt; return 1", []],
  ["type C = new (fmt: string) => typeof fmt; return 1", []],
  ["type C = abstract new (...fmt: string[]) => typeof fmt; return 1", []],
  ["interface M { m(fmt: string): typeof fmt } return 1", []],
  ["type M = { m(fmt: string): typeof fmt }; return 1", []],
  ["interface K { (fmt: string): typeof fmt } return 1", []],
  ["interface N { new (fmt: string): typeof fmt } return 1", []],
  // Its own annotation reads it too (TypeScript reports the cycle, TS2502).
  ["type F = (fmt: typeof fmt) => void; return 1", []],
  // A parameter hides only the value, and only in its signature: another signature and a type of its name read the import.
  ["type F = (fmt: string) => void; type G = () => typeof fmt; return 1", ["fmt"]],
  ["type F = (Money: string) => Money; return 1", ["Money"]],
] as const)("a signature's parameters: %s", (body, expected) => {
  expect(all(`($s: S) => { ${body} }`)).toEqual([...expected].sort());
});
