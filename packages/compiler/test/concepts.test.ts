// Concept files in a build (notes/architecture/concepts-design.md, sections 2, 5 and 6; ruling D36), on projects on disk:
// MX finds concept files by scanning `concepts` folders, so the projects depend on `meshfw` and the hook MX runs is the
// built `dist/dialect.js`. A concept file builds into `document.concepts`; a concept use (`Money :total`) is
// `MESH_NOT_IMPLEMENTED` until concept-typed members are built, and its message names the concept the use resolved to,
// which is how these tests see which concept the nearest `concepts` folder gave.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { buildModel } from "../src/front-end/build.ts";
import { buildDialect, conceptProject } from "./helpers.ts";

const D = "src/domain/";
const disposers: (() => void)[] = [];
beforeAll(() => buildDialect(), 60_000);
afterAll(() => disposers.forEach((dispose) => dispose()));

function build(files: Record<string, string>, options: Parameters<typeof conceptProject>[1] = {}) {
  const made = conceptProject(files, options);
  disposers.push(made.dispose);
  return buildModel(made.project);
}
const said = (result: ReturnType<typeof buildModel>) =>
  result.diagnostics.map((d) => `${d.position.file.slice(D.length)}:${d.position.line}:${d.position.column} ${d.code} ${d.message}`);
const codes = (result: ReturnType<typeof buildModel>) => result.diagnostics.map((d) => `${d.position.file.slice(D.length)}:${d.position.line} ${d.code}`);

const MONEY = "concept :Money\n  string :currency match=/^[A-Z]{3}$/\n  integer :amount min=0\n";
const ENTITY = (name: string, lines = "") => `entity :${name}\n  attributes\n    uuid :id primary-key\n${lines}`;
const NOT_BUILT = (fqn: string, head = "Money") =>
  `MESH_NOT_IMPLEMENTED \`${head}\` is the concept ${fqn}, and a concept-typed member is not built yet: a concept file builds and generates its type and schema, but no attribute or field can hold a concept so far`;

describe("a concept file builds", () => {
  test("into document.concepts, by file, with its module, FQN and fields; nothing else changes", () => {
    const result = build({
      [`${D}concepts/Money.mesh.mx`]: MONEY,
      [`${D}billing/concepts/Money.mesh.mx`]: "concept :Money\n  decimal :value nullable\n  enum :kind values=[:cash, :card]\n",
      [`${D}billing/_payments/concepts/Fee.mesh.mx`]: "concept :Fee\n  integer :cents max=100\n  json :extra\n  string :constructor\n",
      [`${D}billing/invoice.mesh.mx`]: ENTITY("Invoice"),
    });
    expect(said(result)).toEqual([]);
    expect(result.document!.concepts!.map(({ name, fqn, file, module }) => [name, fqn, file, module])).toEqual([
      ["Fee", "billing.Fee", `${D}billing/_payments/concepts/Fee.mesh.mx`, "billing"],
      ["Money", "billing.Money", `${D}billing/concepts/Money.mesh.mx`, "billing"],
      ["Money", "Money", `${D}concepts/Money.mesh.mx`, ""],
    ]);
    const [, , money] = result.document!.concepts!;
    expect(money!.fields.map(({ position: _, ...field }) => field)).toEqual([
      { name: "currency", type: "string", nullable: false, match: { pattern: "^[A-Z]{3}$", flags: "" } },
      { name: "amount", type: "integer", nullable: false, min: 0 },
    ]);
    expect(money!.position).toMatchObject({ file: `${D}concepts/Money.mesh.mx`, line: 1, column: 0 });
    expect(result.document!.concepts![1]!.fields.map((f) => [f.name, f.type, f.nullable, f.values?.map((v) => v.value)])).toEqual([
      ["value", "decimal", true, undefined],
      ["kind", "enum", false, ["cash", "card"]],
    ]);
  });

  test("a project with no concept has no `concepts` key", () => {
    const result = build({ [`${D}a.mesh.mx`]: ENTITY("A") });
    expect(said(result)).toEqual([]);
    expect("concepts" in result.document!).toBe(false);
  });
});

describe("a concept use resolves to the nearest concept, and is not built yet", () => {
  const files = {
    [`${D}concepts/Money.mesh.mx`]: MONEY,
    [`${D}concepts/Price.mesh.mx`]: "concept :Price\n  Money :net\n",
    [`${D}concepts/A.mesh.mx`]: "concept :A\n  Z :z\n",
    [`${D}concepts/Z.mesh.mx`]: "concept :Z\n  integer :z\n",
    [`${D}billing/concepts/Money.mesh.mx`]: "concept :Money\n  decimal :value\n",
    [`${D}billing/invoice.mesh.mx`]: ENTITY("Invoice", "    Money :total\n    Money :refund nullable\n"),
    [`${D}billing/price-set.mesh.mx`]: "event :PriceSet\n  uuid :id\n  Price :price\n",
    [`${D}shop/order.mesh.mx`]: ENTITY("Order", "    Money :total\n"),
    [`${D}shop/pay.mesh.mx`]: "command :Pay\n  uuid :id\n  Money :amount optional\n",
  };
  const result = build(files);

  test("the nearer folder wins with no message (R11, R12); the domain root's elsewhere", () => {
    expect(said(result).filter((line) => line.startsWith("billing/invoice") || line.startsWith("shop/order"))).toEqual([
      `billing/invoice.mesh.mx:4:4 ${NOT_BUILT("billing.Money")}`,
      `billing/invoice.mesh.mx:5:4 ${NOT_BUILT("billing.Money")}`,
      `shop/order.mesh.mx:4:4 ${NOT_BUILT("Money")}`,
    ]);
  });

  test("a use in an event, a command (with `optional`) and a concept is reported the same way", () => {
    expect(said(result).filter((line) => !line.startsWith("billing/invoice") && !line.startsWith("shop/order") && !line.includes("MESH_COMMAND_UNANSWERED"))).toEqual([
      `billing/price-set.mesh.mx:3:2 ${NOT_BUILT("Price", "Price")}`,
      // A concept used inside another resolves from the concept file's own folder (R13), and one whose file sorts later resolves.
      `concepts/A.mesh.mx:2:2 ${NOT_BUILT("Z", "Z")}`,
      `concepts/Price.mesh.mx:2:2 ${NOT_BUILT("Money")}`,
      `shop/pay.mesh.mx:3:2 ${NOT_BUILT("Money")}`,
    ]);
  });

  test.each([
    ["tag parameters", "    Money|x| :p\n", "a.mesh.mx:4:4 MESH_SYNTAX tag parameters and variable bindings are not entity declarations"],
    // MX refuses these three itself, from the contract the hook gives (`CONCEPT_USE`), each once.
    ["a tag variable", "    Money/v :p\n", "a.mesh.mx:4:10 MESH_SYNTAX `/var` on `Money` is not supported: it has no template, so it has no `return` to bind"],
    ["a bound option", "    Money :p name:=x\n", "a.mesh.mx:4:19 MESH_OPTION_VALUE `Money`: option `name` must be atom, got expression; write it as `:x`"],
    ["a name that is not an atom", "    Money name=\"p\"\n", "a.mesh.mx:4:15 MESH_OPTION_VALUE `Money`: option `name` must be atom, got string"],
  ])("a use takes no %s (R22)", (_, line, expected) => {
    const r = build({ [`${D}concepts/Money.mesh.mx`]: MONEY, [`${D}a.mesh.mx`]: ENTITY("A", line) });
    expect(said(r)).toEqual([expected]);
  });

  test("where a use may stand and what it takes is the contract's", () => {
    const r = (lines: string) => codes(build({ [`${D}concepts/Money.mesh.mx`]: MONEY, [`${D}a.mesh.mx`]: lines }));
    expect(r("entity :A\n  attributes\n    uuid :id primary-key\n  relationships\n    Money :m\n")).toEqual(["a.mesh.mx:5 MESH_TAG_NOT_ALLOWED"]);
    expect(r("entity :A\n  attributes\n    uuid :id primary-key\n  computed\n    Money :m\n")).toEqual(["a.mesh.mx:5 MESH_TAG_NOT_ALLOWED"]);
    expect(r("entity :A\n  attributes\n    uuid :id primary-key\n  actions\n    create :c\n      input\n        Money :m\n")).toEqual(["a.mesh.mx:7 MESH_TAG_NOT_ALLOWED"]);
    expect(r("Money :m\n")).toEqual(["a.mesh.mx:1 MESH_PARENT_NOT_ALLOWED"]);
    expect(r(ENTITY("A", "    Money :m min=1\n"))).toEqual(["a.mesh.mx:4 MESH_UNKNOWN_OPTION"]);
    expect(r(ENTITY("A", "    Money :m optional\n"))).toEqual(["a.mesh.mx:4 MESH_UNKNOWN_OPTION"]);
    expect(r("event :E\n  uuid :id\n  Money :m optional\n")).toEqual(["a.mesh.mx:3 MESH_UNKNOWN_OPTION"]);
    // An unknown PascalCase head is still MX's unknown tag, the concepts in scope suggested.
    expect(r(ENTITY("A", "    Mony :m\n"))).toEqual(["a.mesh.mx:4 MESH_UNKNOWN_TAG"]);
  });
});

describe("a concept file's own problems", () => {
  test("a use of a concept whose file has errors is MESH_TAG_FILE_ERROR at each use; the file's error is reported once (R17)", () => {
    const r = build({
      [`${D}concepts/Wrong.mesh.mx`]: "concept :Right\n  integer :x\n",
      [`${D}a.mesh.mx`]: ENTITY("A", "    Wrong :w\n    Wrong :v\n"),
      [`${D}b.mesh.mx`]: ENTITY("B", "    Wrong :w\n"),
    });
    expect(codes(r)).toEqual([
      "a.mesh.mx:4 MESH_TAG_FILE_ERROR",
      "a.mesh.mx:5 MESH_TAG_FILE_ERROR",
      "b.mesh.mx:4 MESH_TAG_FILE_ERROR",
      "concepts/Wrong.mesh.mx:1 MESH_CONCEPT_NAME",
    ]);
  });

  test("a concept that holds itself, directly or through another, is MESH_TAG_FILE_CYCLE (R15)", () => {
    const self = build({ [`${D}concepts/Loop.mesh.mx`]: "concept :Loop\n  Loop :again\n" });
    expect(codes(self)).toContain("concepts/Loop.mesh.mx:2 MESH_TAG_FILE_CYCLE");
    const two = build({ [`${D}concepts/Ping.mesh.mx`]: "concept :Ping\n  Pong :p\n", [`${D}concepts/Pong.mesh.mx`]: "concept :Pong\n  Ping :p\n" });
    expect(codes(two).some((line) => line.endsWith("MESH_TAG_FILE_CYCLE"))).toBe(true);
    expect(two.document).toBeNull();
    // A legal neighbour: one concept holding another twice is no cycle (here not built yet, but no cycle).
    const twice = build({ [`${D}concepts/Money.mesh.mx`]: MONEY, [`${D}concepts/Price.mesh.mx`]: "concept :Price\n  Money :net\n  Money :gross\n" });
    expect(codes(twice)).toEqual(["concepts/Price.mesh.mx:2 MESH_NOT_IMPLEMENTED", "concepts/Price.mesh.mx:3 MESH_NOT_IMPLEMENTED"]);
  });

  test("a concept file named like a Mesh tag is MESH_RESERVED_TAG once a build, and the tag keeps its meaning (R14)", () => {
    const r = build({
      [`${D}concepts/string.mesh.mx`]: "concept :string\n  integer :x\n",
      [`${D}concepts/Str.mesh.mx`]: "concept :Str\n  integer :x\n",
      [`${D}a.mesh.mx`]: ENTITY("A", "    string :title\n"),
      [`${D}b.mesh.mx`]: ENTITY("B"),
    });
    expect(said(r).filter((line) => line.includes("MESH_RESERVED_TAG"))).toEqual([
      "concepts/string.mesh.mx:1:0 MESH_RESERVED_TAG string is a Mesh tag, so a concept file cannot take its name: rename concepts/string.mesh.mx and its `concept :string` line",
    ]);
    // `string :title` is still the attribute type, and `Str` beside it is fine.
    expect(codes(r).filter((line) => !line.startsWith("concepts/string"))).toEqual([]);
    expect(codes(build({ [`${D}concepts/concept.mesh.mx`]: "concept :concept\n  integer :x\n" }))).toContain("concepts/concept.mesh.mx:1 MESH_RESERVED_TAG");
  });

  test.each([
    ["a name other than the file's (R5)", "concepts/Wrong.mesh.mx", "concept :Right\n  integer :x\n",
      "concepts/Wrong.mesh.mx:1:8 MESH_CONCEPT_NAME concepts/Wrong.mesh.mx declares `concept :Right`: a concept's name is its file name, so write `concept :Wrong` or rename the file Right.mesh.mx"],
    ["a lower-case file (R6)", "concepts/money.mesh.mx", "concept :money\n  integer :x\n",
      "concepts/money.mesh.mx:1:8 MESH_CONCEPT_NAME concept :money is not PascalCase: a concept is used as a PascalCase line head (`Money :price`), so name the file Money.mesh.mx and write `concept :Money`"],
    ["no field line (OD9)", "concepts/Empty.mesh.mx", "concept :Empty\n", "concepts/Empty.mesh.mx:1:0 MESH_MISSING_CHILD `concept`: a concept needs at least one field line"],
    ["two fields of one name (R18)", "concepts/Two.mesh.mx", "concept :Two\n  integer :x\n  string :x\n", "concepts/Two.mesh.mx:3:2 MESH_DUPLICATE_MEMBER Duplicate member :x"],
    ["a `__proto__` field (R19)", "concepts/Proto.mesh.mx", "concept :Proto\n  string :__proto__\n",
      "concepts/Proto.mesh.mx:2:2 MESH_ATTRIBUTE_NAME :__proto__ cannot be a field name: __proto__ sets an object's prototype instead of adding a property. Choose another name."],
    ["a date field (OD5)", "concepts/Dated.mesh.mx", "concept :Dated\n  timestamp :at\n",
      "concepts/Dated.mesh.mx:2:2 MESH_CONCEPT_FIELD `timestamp :at` cannot be a field of a concept yet: a concept is stored as one JSON value, which keeps no date; write it as a `string`, or declare it on the entity"],
    ["two roots", "concepts/Twice.mesh.mx", "concept :Twice\n  integer :x\nconcept :Again\n  integer :x\n", "concepts/Twice.mesh.mx:3:0 MESH_DUPLICATE_ENTITY A concept file declares exactly one concept"],
    ["an import", "concepts/Imp.mesh.mx", "import { A } from \"../a.mesh.mx\"\nconcept :Imp\n  integer :x\n",
      "concepts/Imp.mesh.mx:1:0 MESH_UNKNOWN_IMPORT A concept file takes no import: its fields are attribute types and concepts"],
    ["an option on the root (R4)", "concepts/Opt.mesh.mx", "concept :Opt table=\"t\"\n  integer :x\n", "concepts/Opt.mesh.mx:1:13 MESH_UNKNOWN_OPTION `concept`: unknown option `table`"],
    ["`optional` on a field (R20)", "concepts/Opt.mesh.mx", "concept :Opt\n  integer :x optional\n", "concepts/Opt.mesh.mx:2:13 MESH_UNKNOWN_OPTION `optional` is only an option of a command's field"],
  ])("%s is one error", (_, path, source, expected) => {
    expect(said(build({ [`${D}${path}`]: source, [`${D}a.mesh.mx`]: ENTITY("A") }))).toEqual([expected]);
  });

  test.each(["default=1", "unique", "primary-key", "value=() => 1"])("`%s` on a field is the builder's MESH_UNKNOWN_OPTION (R2)", (option) => {
    const lines = said(build({ [`${D}concepts/Opt.mesh.mx`]: `concept :Opt\n  integer :x ${option}\n` }));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^concepts\/Opt\.mesh\.mx:2:\d+ MESH_UNKNOWN_OPTION `[a-z-]+` is not an option of a field of a concept: a field has no row behind it/);
  });
  test("`on=` on a timestamp field is refused too, beside the date rule", () => {
    expect(codes(build({ [`${D}concepts/Opt.mesh.mx`]: "concept :Opt\n  timestamp :at on=:create\n" }))).toEqual([
      "concepts/Opt.mesh.mx:2 MESH_CONCEPT_FIELD",
      "concepts/Opt.mesh.mx:2 MESH_UNKNOWN_OPTION",
    ]);
  });
});

describe("where a concept file may be (OD4, R10)", () => {
  test("a concept file outside a `concepts` folder, or below one, is MESH_CONCEPT_PLACE (case a)", () => {
    expect(said(build({
      [`${D}billing/Money.mesh.mx`]: "concept :Money\n  integer :x\n",
      [`${D}concepts/finance/Deep.mesh.mx`]: "concept :Deep\n  integer :x\n",
    }))).toEqual([
      "billing/Money.mesh.mx:1:0 MESH_CONCEPT_PLACE A concept file sits directly in a folder named `concepts`, where Mesh finds it: move billing/Money.mesh.mx to billing/concepts/Money.mesh.mx",
      "concepts/finance/Deep.mesh.mx:1:0 MESH_CONCEPT_PLACE A concept file sits directly in a folder named `concepts`, where Mesh finds it: move concepts/finance/Deep.mesh.mx to concepts/Deep.mesh.mx",
    ]);
  });

  test("a file in a `concepts` folder that declares no concept is MESH_CONCEPT_PLACE (case b) and is not built", () => {
    const r = build({ [`${D}billing/concepts/order.mesh.mx`]: ENTITY("Order"), [`${D}billing/order.mesh.mx`]: ENTITY("Order") });
    expect(said(r)).toEqual([
      "billing/concepts/order.mesh.mx:1:0 MESH_CONCEPT_PLACE concepts/order.mesh.mx is in a `concepts` folder, so it declares one concept: move this entity out of the folder, or write `concept :Order`",
    ]);
  });

  test.each([["empty", ""], ["comment-only", "// nothing\n"]])("an %s file in a `concepts` folder is case b at the file and MESH_TAG_FILE_ERROR at each use", (_, text) => {
    const r = build({ [`${D}concepts/C.mesh.mx`]: text, [`${D}a.mesh.mx`]: ENTITY("A", "    C :c\n") });
    expect(codes(r)).toEqual(["a.mesh.mx:4 MESH_TAG_FILE_ERROR", "concepts/C.mesh.mx:1 MESH_CONCEPT_PLACE"]);
    expect(said(r)[1]).toBe(
      "concepts/C.mesh.mx:1:0 MESH_CONCEPT_PLACE concepts/C.mesh.mx is in a `concepts` folder, so it declares one concept, and it declares nothing: write `concept :C` and its field lines, or move the file out of the folder",
    );
    // Unused, it is still refused, in the concept wording and never as an entity file.
    expect(codes(build({ [`${D}concepts/C.mesh.mx`]: text }))).toEqual(["concepts/C.mesh.mx:1 MESH_CONCEPT_PLACE"]);
  });

  test("case a moves a lower-case file under the declared name, and R5 offers only the rename", () => {
    expect(said(build({ [`${D}billing/money.mesh.mx`]: "concept :Money\n  integer :x\n" }))).toEqual([
      "billing/money.mesh.mx:1:0 MESH_CONCEPT_PLACE A concept file sits directly in a folder named `concepts`, where Mesh finds it: move billing/money.mesh.mx to billing/concepts/Money.mesh.mx",
      "billing/money.mesh.mx:1:8 MESH_CONCEPT_NAME billing/money.mesh.mx declares `concept :Money`: a concept's name is its file name, so rename the file Money.mesh.mx",
    ]);
  });

  test.each([
    ["_/concepts/Money.mesh.mx", "MESH_GROUP_NAME"],
    ["bad.seg/concepts/Money.mesh.mx", "MESH_MODULE_NAME"],
  ])("a concept in %s takes its module from the folder above, so a bad folder is %s", (path, code) => {
    expect(codes(build({ [`${D}${path}`]: MONEY }))).toEqual([`${path}:1 ${code}`]);
  });

  test("a scan diagnostic about a concept file the build does not read is not reported", () => {
    expect(said(build({ "src/concepts/string.mesh.mx": "concept :string\n  integer :x\n", [`${D}a.mesh.mx`]: ENTITY("A") }))).toEqual([]);
    const ignored = build({ [`${D}concepts/string.mesh.mx`]: "concept :string\n  integer :x\n", [`${D}a.mesh.mx`]: ENTITY("A") }, { ignored: [`${D}concepts/string.mesh.mx`] });
    expect(said(ignored)).toEqual([]);
    expect(ignored.document).not.toBeNull();
  });

  test("a use of a concept with errors outside the domain root is MESH_TAG_FILE_ERROR, with the file's error named at 1:0", () => {
    // MX fails the use before the build sees a tree, so case c cannot be reported; the file's own error says where it is.
    const r = build({ "src/concepts/Far.mesh.mx": "concept :Near\n  integer :x\n", [`${D}a.mesh.mx`]: ENTITY("A", "    Far :f\n") });
    expect(codes(r)).toEqual(["a.mesh.mx:1 MESH_CONCEPT_NAME", "a.mesh.mx:4 MESH_TAG_FILE_ERROR"]);
    expect(said(r)[0]).toContain("(in `src/concepts/Far.mesh.mx`)");
  });

  test("a use of a concept the build does not read is MESH_CONCEPT_PLACE at the use (case c)", () => {
    const outside = build({ "src/concepts/Far.mesh.mx": "concept :Far\n  integer :x\n", [`${D}a.mesh.mx`]: ENTITY("A", "    Far :f\n") });
    expect(said(outside)).toEqual([
      "a.mesh.mx:4:4 MESH_CONCEPT_PLACE Far is declared in src/concepts/Far.mesh.mx, which the build does not read (outside the domain root src/domain, or excluded by `ignore`): move it into a `concepts` folder under the domain root",
    ]);
    const ignored = build(
      { [`${D}concepts/Money.mesh.mx`]: MONEY, [`${D}a.mesh.mx`]: ENTITY("A", "    Money :m\n") },
      { ignored: [`${D}concepts/Money.mesh.mx`] },
    );
    expect(codes(ignored)).toEqual(["a.mesh.mx:4 MESH_CONCEPT_PLACE"]);
  });
});

describe("names", () => {
  test("a concept file is never imported (R9)", () => {
    const r = build({
      [`${D}concepts/Money.mesh.mx`]: MONEY,
      [`${D}a.mesh.mx`]: `import { Money } from "./concepts/Money.mesh.mx"\n${ENTITY("A")}`,
      [`${D}b.mesh.mx`]: `import * as m from "./concepts/Money.mesh.mx"\n${ENTITY("B")}`,
    });
    expect(said(r)).toEqual([
      "a.mesh.mx:1:0 MESH_UNKNOWN_IMPORT Money is a concept, and a concept is never imported: write `Money :price` and Mesh finds it in the nearest `concepts` folder",
      "b.mesh.mx:1:0 MESH_UNKNOWN_IMPORT Money is a concept, and a concept is never imported: write `Money :price` and Mesh finds it in the nearest `concepts` folder",
    ]);
  });

  test("two concepts of one FQN (R21), and a concept and an entity of one FQN, are MESH_DUPLICATE_ENTITY at the later file", () => {
    expect(said(build({
      [`${D}billing/concepts/Money.mesh.mx`]: MONEY,
      [`${D}billing/_payments/concepts/Money.mesh.mx`]: MONEY,
    }))).toEqual([
      "billing/concepts/Money.mesh.mx:1:0 MESH_DUPLICATE_ENTITY Duplicate name billing.Money: concept in src/domain/billing/_payments/concepts/Money.mesh.mx and concept in src/domain/billing/concepts/Money.mesh.mx",
    ]);
    expect(said(build({ [`${D}billing/concepts/Money.mesh.mx`]: MONEY, [`${D}billing/money.mesh.mx`]: ENTITY("Money") }))).toEqual([
      "billing/money.mesh.mx:1:0 MESH_DUPLICATE_ENTITY Duplicate name billing.Money: concept in src/domain/billing/concepts/Money.mesh.mx and entity in src/domain/billing/money.mesh.mx",
    ]);
    expect(codes(build({ [`${D}billing/concepts/Paid.mesh.mx`]: MONEY.replace("Money", "Paid"), [`${D}billing/paid.mesh.mx`]: "event :Paid\n  uuid :id\n" }))).toEqual([
      "billing/paid.mesh.mx:1 MESH_DUPLICATE_ENTITY",
    ]);
  });

  test("legal neighbours: a root concept beside a module's of one name, a concept beside an entity of another name", () => {
    expect(said(build({
      [`${D}concepts/Money.mesh.mx`]: MONEY,
      [`${D}billing/concepts/Money.mesh.mx`]: MONEY,
      [`${D}billing/money-transfer.mesh.mx`]: ENTITY("MoneyTransfer"),
    }))).toEqual([]);
  });
});
