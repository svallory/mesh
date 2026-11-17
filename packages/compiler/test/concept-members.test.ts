// Concept-typed members in a build (notes/architecture/concepts-design.md, sections 2, 5 and 6; ruling D36; concepts PR 2):
// a member or a field whose line head is a concept (`Money :total`) is one JSON value. These tests pin what the build says
// about such a member: no sort, filter or rollup over it, `set` literals checked against the concept's fields, a read
// inside it demoted to plain code, and commands matched by the concept's FQN. Projects live on disk (the scan reads
// directories), under ~/tmp/mesh-concepts/.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { buildModel } from "../src/front-end/build.ts";
import { buildDialect, conceptProject } from "./helpers.ts";

const D = "src/domain/";
const disposers: (() => void)[] = [];
beforeAll(() => buildDialect(), 60_000);
afterAll(() => disposers.forEach((dispose) => dispose()));

function build(files: Record<string, string>) {
  const made = conceptProject(files);
  disposers.push(made.dispose);
  return buildModel(made.project);
}
const said = (result: ReturnType<typeof buildModel>) =>
  result.diagnostics.map((d) => `${d.position.file.slice(D.length)}:${d.position.line}:${d.position.column} ${d.severity === "warning" ? "warning " : ""}${d.code} ${d.message}`);
const codes = (result: ReturnType<typeof buildModel>) =>
  result.diagnostics.filter((d) => d.code !== "MESH_COMMAND_UNANSWERED").map((d) => `${d.position.file.slice(D.length)}:${d.position.line} ${d.code}`);

const MONEY = "concept :Money\n  string :currency match=/^[A-Z]{3}$/\n  integer :amount min=0\n";
const STATUS = "concept :Status\n  enum :state values=[:open, :closed]\n  Money :fee nullable\n";
const ONE = "concept :One\n  string :value\n";
const CONCEPTS = { [`${D}concepts/Money.mesh.mx`]: MONEY, [`${D}concepts/Status.mesh.mx`]: STATUS, [`${D}concepts/One.mesh.mx`]: ONE };
/** An Invoice holding `Money :total`, `Money :refund nullable` and `Status :status`, then `rest` (sections after `attributes`). */
const invoice = (rest = "  actions auto=[:read]\n") => `entity :Invoice
  attributes
    uuid :id primary-key
    integer :n
    Money :total
    Money :refund nullable
    Status :status
${rest}`;
const one = (files: Record<string, string>) => build({ ...CONCEPTS, ...files });

describe("a concept member is no column a query reads", () => {
  test("a read's sort by it is MESH_SORT_TYPE, naming the concept", () => {
    expect(said(one({ [`${D}billing/invoice.mesh.mx`]: invoice("  actions auto=[:read]\n    read :ordered\n      sort\n        asc &total\n") }))).toEqual([
      "billing/invoice.mesh.mx:11:12 MESH_SORT_TYPE &total is the concept Money, which a sort cannot use: it is stored as one JSON value",
    ]);
  });

  test("a read's filter reading it, or inside it, is MESH_FILTER_TYPE, naming the concept (M10 does not translate it)", () => {
    for (const filter of ["() => &total === null", "() => &total.amount > 0", "() => &refund?.amount === 1"]) {
      const source = invoice(`  actions auto=[:read]\n    read :some filter=${filter}\n`);
      const diagnostics = one({ [`${D}billing/invoice.mesh.mx`]: source }).diagnostics.filter((d) => d.severity === "error");
      expect(diagnostics.map((d) => [d.code, d.message])).toEqual([[
        "MESH_FILTER_TYPE",
        `${filter.includes("refund") ? "&refund" : "&total"} is the concept Money, which a filter cannot use: it is stored as one JSON value`,
      ]]);
    }
  });

  test("a read policy reading it is MESH_FILTER_TYPE in the read policy's words; one reading inside it is plain, so MESH_EXPR_NOT_SQL", () => {
    const policy = (check: string) => invoice(`  actions auto=[:read, :create]\n  policies\n    policy :mine types=[:read]\n      authorize-if=${check}\n    policy :writes types=[:create]\n      authorize-if=() => true\n`);
    const errors = (check: string) => one({ [`${D}billing/invoice.mesh.mx`]: policy(check) }).diagnostics.filter((d) => d.severity === "error").map((d) => [d.code, d.message]);
    expect(errors("() => &total !== null")).toEqual([[
      "MESH_FILTER_TYPE", "&total is the concept Money, which a read policy cannot use: it is stored as one JSON value",
    ]]);
    // As a read inside a `json` member is: the expression checker demotes it first (ruling D36, OD7), and a plain function
    // where SQL is required is MESH_EXPR_NOT_SQL.
    expect(errors("() => &total.amount > 0")).toEqual([[
      "MESH_EXPR_NOT_SQL", "policy :mine authorize-if must run as SQL, since the policy covers read :read of billing.Invoice, and Mesh does not translate it (a member of a concept value)",
    ]]);
  });

  test.each(["sum", "avg", "min", "max"])("a %s rollup of it is MESH_ROLLUP_TYPE, naming the concept", (fn) => {
    const line = "import { Invoice } from \"./invoice.mesh.mx\"\nentity :Line\n  attributes\n    uuid :id primary-key\n    Money :price\n  relationships\n    belongs-to :invoice entity=Invoice\n  actions auto=[:read]\n";
    const source = `import { Line } from "./line.mesh.mx"\n${invoice(`  relationships\n    has-many :lines entity=Line\n  computed\n    ${fn} :biggest of=&lines.price\n  actions auto=[:read]\n`)}`;
    const result = one({ [`${D}billing/invoice.mesh.mx`]: source, [`${D}billing/line.mesh.mx`]: line });
    expect(result.diagnostics.map((d) => [d.code, d.message])).toEqual([[
      "MESH_ROLLUP_TYPE", `${fn} needs ${fn === "sum" || fn === "avg" ? "a number" : "a number, date or datetime"}, &price is the concept Money`,
    ]]);
  });
});

describe("`set &total=<literal>` takes an object literal of exactly the concept's fields", () => {
  const setIn = (place: "do" | "always", value: string, member = "total") =>
    place === "do"
      ? invoice(`  actions auto=[:read]\n    update :change\n      do\n        set\n          &${member}=${value}\n`)
      : invoice(`  actions auto=[:read, :update]\n    always types=[:update]\n      do\n        set\n          &${member}=${value}\n`);
  const result = (place: "do" | "always", value: string, member?: string) => one({ [`${D}billing/invoice.mesh.mx`]: setIn(place, value, member) });

  describe.each(["do", "always"] as const)("in a %s block", (place) => {
    test.each([
      ["the exact fields", "total", '{ currency: "EUR", amount: 0 }'],
      ["the exact fields in another order", "total", '{ amount: 3, currency: "EUR" }'],
      ["null on a nullable member", "refund", "null"],
      ["an enum field's value as an atom, with a nested concept", "status", '{ state: :open, fee: { currency: "EUR", amount: 1 } }'],
      ["a nested concept's null on its nullable field", "status", "{ state: :closed, fee: null }"],
      ["a function", "total", '() => ({ currency: "EUR", amount: 0 })'],
    ])("%s builds", (_, member, value) => {
      expect(said(result(place, value, member))).toEqual([]);
    });

    test.each([
      ["a missing field", "total", '{ currency: "EUR" }'],
      ["an extra field", "total", '{ currency: "EUR", amount: 0, note: "x" }'],
      ["a value of the wrong type", "total", '{ currency: "EUR", amount: "0" }'],
      ["a non-integer for an integer field", "total", '{ currency: "EUR", amount: 1.5 }'],
      ["null on a required member", "total", "null"],
      ["null for a required field", "total", "{ currency: null, amount: 0 }"],
      ["a scalar", "total", "1"],
      ["a list", "total", '["EUR", 0]'],
      ["an atom not among the enum's values", "status", "{ state: :gone, fee: null }"],
      ["a string for an enum field", "status", '{ state: "open", fee: null }'],
      ["a nested concept with a missing field", "status", '{ state: :open, fee: { currency: "EUR" } }'],
    ])("%s is MESH_SET_VALUE at the member", (_, member, value) => {
      const diagnostics = result(place, value, member).diagnostics;
      expect(diagnostics.map((d) => d.code)).toEqual(["MESH_SET_VALUE"]);
      const fields = member === "status" ? "Status (state, fee)" : "Money (currency, amount)";
      expect(diagnostics[0]!.message).toBe(`\`&${member}=\` needs an object literal with exactly the fields of ${fields}${member === "refund" ? ", null" : ""}, or a function`);
    });
  });

  test("a concept whose one field is named `value` takes `{ value: \"x\" }`, not the atom reading", () => {
    const source = `entity :Tag\n  attributes\n    uuid :id primary-key\n    One :label\n  actions auto=[:read]\n    update :rename\n      do\n        set\n          &label={ value: "x" }\n`;
    expect(said(one({ [`${D}tag.mesh.mx`]: source }))).toEqual([]);
    expect(codes(one({ [`${D}tag.mesh.mx`]: source.replace('{ value: "x" }', '"x"') }))).toEqual(["tag.mesh.mx:9 MESH_SET_VALUE"]);
  });

  test("the concept may be in a file built after the entity's", () => {
    // `a.mesh.mx` sorts before `concepts/`, so its set literal is checked once the concept is built.
    const source = `entity :A\n  attributes\n    uuid :id primary-key\n    Money :m\n  actions auto=[:read]\n    update :u\n      do\n        set\n          &m={ currency: "EUR", amount: 0 }\n`;
    expect(said(one({ [`${D}a.mesh.mx`]: source }))).toEqual([]);
    expect(codes(one({ [`${D}a.mesh.mx`]: source.replace("amount: 0", "amount: -0.5") }))).toEqual(["a.mesh.mx:9 MESH_SET_VALUE"]);
  });
});

describe("an expression that reads inside a concept member runs as plain TypeScript", () => {
  const plain = (result: ReturnType<typeof buildModel>) => result.diagnostics.map((d) => `${d.severity} ${d.code} ${d.message}`);
  const PLAIN = "warning MESH_EXPR_PLAIN this expression runs as plain TypeScript with JavaScript's rules for null, not Mesh's, because of a member of a concept value";

  test.each([
    ["a check", invoice("  actions auto=[:read]\n    update :change\n      validate\n        check :positive that=() => &total.amount > 0 code=\"p\" message=\"p\"\n")],
    ["a named check of a `checks` section", invoice("  checks\n    check :positive that=() => &total.amount > 0 code=\"p\" message=\"p\"\n  actions auto=[:read]\n    update :change\n      validate\n        check &positive\n")],
    ["a `when` line in `validate`", invoice("  actions auto=[:read]\n    update :change\n      validate\n        when=() => &total.amount > 0\n          check :ok that=() => &n > 0 code=\"o\" message=\"o\"\n")],
    ["a write policy", invoice("  actions auto=[:read, :update]\n  policies\n    policy :big types=[:update]\n      authorize-if=() => &total.amount > 0\n    policy :reads types=[:read]\n      authorize-if=() => true\n")],
  ])("in %s: demoted, with the MESH_EXPR_PLAIN warning naming the concept", (_, source) => {
    expect(plain(one({ [`${D}billing/invoice.mesh.mx`]: source }))).toEqual([PLAIN]);
  });

  test("comparing two concept values is demoted too", () => {
    const source = invoice("  actions auto=[:read]\n    update :change\n      validate\n        check :same that=() => &total === &refund code=\"s\" message=\"s\"\n");
    expect(plain(one({ [`${D}billing/invoice.mesh.mx`]: source }))).toEqual([
      "warning MESH_EXPR_PLAIN this expression runs as plain TypeScript with JavaScript's rules for null, not Mesh's, because of a comparison of concept values",
    ]);
  });

  test("a read through a nullable concept member needs `?.`, which is then legal (and plain)", () => {
    const check = (that: string) => invoice(`  actions auto=[:read]\n    update :change\n      validate\n        check :c that=${that} code="c" message="c"\n`);
    expect(said(one({ [`${D}billing/invoice.mesh.mx`]: check("() => &refund.amount > 0") })).map((line) => line.split(" ").slice(1, 2).join(" ") + line.slice(line.indexOf(" ", line.indexOf(" ") + 1)))).toContain(
      "MESH_EXPR_NULLABLE_ACCESS `.amount` is read through a value that may be null",
    );
    expect(plain(one({ [`${D}billing/invoice.mesh.mx`]: check("() => &refund?.amount > 0") }))).toEqual([PLAIN]);
  });

  test("a check that reads only scalar members stays translated, with no warning", () => {
    const source = invoice("  actions auto=[:read]\n    update :change\n      validate\n        check :c that=() => &n > 0 code=\"c\" message=\"c\"\n");
    expect(said(one({ [`${D}billing/invoice.mesh.mx`]: source }))).toEqual([]);
  });
});

describe("a command field of a concept is answered by an input of the same concept", () => {
  const PRICE = "concept :Price\n  Money :net\n";
  const command = (line: string) => `command :Charge\n  uuid :id\n  ${line}\n`;
  const answering = (member: string) => `import { Charge } from "./charge.mesh.mx"\n${invoice(`  actions auto=[:read]\n    update on=Charge\n      input\n        &${member}\n`)}`;
  const run = (commandLine: string, member: string, extra: Record<string, string> = {}) =>
    one({ [`${D}concepts/Price.mesh.mx`]: PRICE, [`${D}billing/charge.mesh.mx`]: command(commandLine), [`${D}billing/invoice.mesh.mx`]: answering(member), ...extra });

  test("the same concept builds; a nullable input admits a required field", () => {
    expect(codes(run("Money :total", "total"))).toEqual([]);
    expect(codes(run("Money :refund", "refund"))).toEqual([]);
  });

  test("another concept is MESH_COMMAND_INPUT, the type printed with the concept's FQN", () => {
    const result = run("Price :total", "total");
    expect(result.diagnostics.map((d) => [d.code, d.message])).toEqual([[
      "MESH_COMMAND_INPUT",
      "Command billing.Charge has the field `total` of type `concept Price`, which does not fit the input of billing.Invoice#charge of type `concept Money`",
    ]]);
  });

  test("a nullable command field for a required input is MESH_COMMAND_INPUT", () => {
    expect(codes(run("Money :total nullable", "total"))).toEqual(["billing/invoice.mesh.mx:10 MESH_COMMAND_INPUT"]);
  });

  test("a shadowing concept of the same name in another module is another concept", () => {
    // The command sits in `billing/`, whose own `concepts` folder shadows the root's Money; the invoice sits in `shop/`.
    const files = {
      [`${D}concepts/Price.mesh.mx`]: PRICE,
      [`${D}billing/concepts/Money.mesh.mx`]: MONEY,
      [`${D}billing/charge.mesh.mx`]: command("Money :total"),
      [`${D}shop/invoice.mesh.mx`]: `import { Charge } from "../billing/charge.mesh.mx"\n${invoice("  actions auto=[:read]\n    update on=Charge\n      input\n        &total\n")}`,
    };
    const result = one(files);
    expect(result.diagnostics.map((d) => [d.code, d.message])).toEqual([[
      "MESH_COMMAND_INPUT",
      "Command billing.Charge has the field `total` of type `concept billing.Money`, which does not fit the input of shop.Invoice#charge of type `concept Money`",
    ]]);
  });
});

describe("names and the other places a concept member stands", () => {
  test("a concept member named like another member is MESH_DUPLICATE_MEMBER; `__proto__` is MESH_ATTRIBUTE_NAME", () => {
    expect(codes(one({ [`${D}a.mesh.mx`]: "entity :A\n  attributes\n    uuid :id primary-key\n    integer :total\n    Money :total\n  actions auto=[:read]\n" }))).toEqual(["a.mesh.mx:5 MESH_DUPLICATE_MEMBER"]);
    expect(codes(one({ [`${D}a.mesh.mx`]: "entity :A\n  attributes\n    uuid :id primary-key\n    Money :__proto__\n  actions auto=[:read]\n" }))).toEqual(["a.mesh.mx:4 MESH_ATTRIBUTE_NAME"]);
  });

  test("an event or command field of a concept follows the field name rules", () => {
    expect(codes(one({ [`${D}paid.mesh.mx`]: "event :Paid\n  integer :total\n  Money :total\n" }))).toEqual(["paid.mesh.mx:3 MESH_DUPLICATE_MEMBER"]);
    expect(codes(one({ [`${D}paid.mesh.mx`]: "event :Paid\n  Money :constructor\n" }))).toEqual(["paid.mesh.mx:2 MESH_ATTRIBUTE_NAME"]);
    // Inside a concept, `constructor` is a field like any other (a plain object type has no constructor).
    expect(codes(one({ [`${D}concepts/Box.mesh.mx`]: "concept :Box\n  Money :constructor\n" }))).toEqual([]);
  });

  test("an update and a create take it as a member input; a has-many through a link that holds one builds", () => {
    const source = invoice("  actions auto=[:read]\n    create :open\n      input\n        &total\n        &status\n    update :retotal\n      input\n        &total\n");
    const result = one({ [`${D}billing/invoice.mesh.mx`]: source });
    expect(said(result)).toEqual([]);
    const files = {
      [`${D}a.mesh.mx`]: "import { Link } from \"./link.mesh.mx\"\nimport { B } from \"./b.mesh.mx\"\nentity :A\n  attributes\n    uuid :id primary-key\n  relationships\n    has-many :bs entity=B through=Link\n  actions auto=[:read]\n",
      [`${D}b.mesh.mx`]: "import { Link } from \"./link.mesh.mx\"\nentity :B\n  attributes\n    uuid :id primary-key\n  relationships\n    has-many :links entity=Link\n  actions auto=[:read]\n",
      [`${D}link.mesh.mx`]: "import { A } from \"./a.mesh.mx\"\nimport { B } from \"./b.mesh.mx\"\nentity :Link\n  attributes\n    uuid :id primary-key\n    Money :price\n  relationships\n    belongs-to :a entity=A\n    belongs-to :b entity=B\n  actions auto=[:read]\n",
    };
    expect(said(one(files))).toEqual([]);
  });

  test("a concept member is never a key: `primary-key` on a use is the contract's MESH_UNKNOWN_OPTION", () => {
    expect(codes(one({ [`${D}a.mesh.mx`]: "entity :A\n  attributes\n    Money :id primary-key\n  actions auto=[:read]\n" }))).toContain("a.mesh.mx:3 MESH_UNKNOWN_OPTION");
  });
});
