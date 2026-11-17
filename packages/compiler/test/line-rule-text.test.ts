// `message="..."` and `code="..."` on a line that carries a line rule (`min`, `max`, `match`): the contract that takes
// them, the model fields `ruleMessage`/`ruleCode`, `MESH_ATTRIBUTE_RULE` on a line with no rule, and the generated
// validator that reports the line's own text instead of Mesh's standard one (the small-language design, C7 to C10).
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { resolve } from "node:path";
import type { Diagnostic } from "@meshfw/model";
import { InvalidInputError, parseInput } from "@meshfw/runtime";
import { buildModel } from "../src/front-end/build.ts";
import { generateFiles, writeGeneratedFiles } from "../src/typescript/emit.ts";
import { fieldRuleTable, fieldSchema } from "../src/typescript/views/validators.ts";
import type { FieldShape } from "../src/typescript/views/inputs.ts";
import { closeTypeServer } from "./type-server.ts";

afterAll(closeTypeServer);

/** An entity whose attributes section holds `line` (indented four spaces) after its key. */
const entity = (line: string, extra = "") => `entity :Todo
  attributes
    uuid :id primary-key
    ${line}
  actions auto=[:read]
${extra}`;
const build = (files: Record<string, string>) => buildModel({ root: "/p", files: Object.entries(files).map(([file, source]) => ({ file, source })) });
const brief = (diagnostics: readonly Diagnostic[]) =>
  diagnostics.filter((d) => d.severity === "error").map((d) => [d.code, d.message, d.position.line, d.position.column]);
const errorsOf = (line: string) => brief(build({ "todo/todo.mesh.mx": entity(line) }).diagnostics);
const attributeOf = (line: string) => build({ "todo/todo.mesh.mx": entity(line) }).document!.entities[0]!.attributes[1]!;

describe("the contract: message= and code= are text, on the types that take a line rule", () => {
  test.each([
    ["a function", 'string :title min=1 message=() => "x"', "MESH_OPTION_VALUE", "`string`: option `message` must be a literal", 25],
    ["a number", "string :title min=1 code=42", "MESH_OPTION_VALUE", "`string`: option `code` must be string, got number", 25],
    ["an atom", "string :title min=1 message=:short", "MESH_OPTION_VALUE", "`string`: option `message` must be string, got atom", 25],
    ["blank text", 'string :title min=1 message=""', "MESH_TEXT", "`string`: message cannot be empty", 24],
    ["blank code", 'integer :n min=0 code=""', "MESH_TEXT", "`integer`: code cannot be empty", 21],
    ["on a boolean", 'boolean :done message="x"', "MESH_UNKNOWN_OPTION", "`boolean`: unknown option `message`", 18],
    ["on an enum", 'enum :state values=[:a, :b] code="x"', "MESH_UNKNOWN_OPTION", "`enum`: unknown option `code`", 32],
    ["on a uuid", 'uuid :other message="x"', "MESH_UNKNOWN_OPTION", "`uuid`: unknown option `message`", 16],
  ])("%s is refused by MX", (_name, line, code, message) => {
    const found = errorsOf(line);
    expect(found.map(([c, m]) => [c, m])).toEqual([[code, message]]);
    expect(found[0]![2]).toBe(4);
  });
});

describe("the model: ruleMessage and ruleCode, only when written", () => {
  test("both, on a string with two rules", () => {
    const line = 'string :title min=1 max=80 message="a title is 1 to 80 characters" code="title_length"';
    expect(errorsOf(line)).toEqual([]);
    expect(attributeOf(line)).toMatchObject({ min: 1, max: 80, ruleMessage: "a title is 1 to 80 characters", ruleCode: "title_length" });
  });

  test("code alone on an integer, message alone on a pattern, the same on a float and a decimal", () => {
    expect(attributeOf('integer :n min=0 code="negative"')).toMatchObject({ ruleCode: "negative" });
    expect(attributeOf('integer :n min=0 code="negative"')).not.toHaveProperty("ruleMessage");
    const slug = attributeOf('string :slug match=/^[a-z-]+$/ message="lower-case letters and hyphens"');
    expect(slug).toMatchObject({ ruleMessage: "lower-case letters and hyphens" });
    expect(slug).not.toHaveProperty("ruleCode");
    expect(attributeOf('float :ratio max=1 code="ratio"')).toMatchObject({ ruleCode: "ratio" });
    expect(attributeOf('decimal :price min=0 message="free or more"')).toMatchObject({ ruleMessage: "free or more" });
  });

  test("a line with a rule and neither option has neither key", () => {
    const attribute = attributeOf("string :title min=1");
    expect(Object.keys(attribute)).not.toContain("ruleMessage");
    expect(Object.keys(attribute)).not.toContain("ruleCode");
  });

  test("on an argument line", () => {
    const result = build({ "todo/todo.mesh.mx": entity("string :title", `    create :make
      input
        decimal :percent min=0 max=100 message="a percentage" code="percent"
`) });
    expect(brief(result.diagnostics)).toEqual([]);
    const make = result.document!.entities[0]!.actions.find((action) => action.name === "make")!;
    expect(make.input[0]).toMatchObject({ kind: "argument", name: "percent", ruleMessage: "a percentage", ruleCode: "percent" });
  });

  test("on an event field and a command field", () => {
    const result = build({
      "billing/invoice-paid.mesh.mx": 'event :InvoicePaid\n  integer :amount min=0 code="negative"\n  string :note nullable\n',
      "billing/pay-invoice.mesh.mx": 'command :PayInvoice\n  uuid :id\n  string :reason min=1 message="give a reason"\n',
      "billing/invoice.mesh.mx": `import { PayInvoice } from "./pay-invoice.mesh.mx"
entity :Invoice
  attributes
    uuid :id primary-key
  actions auto=[:read]
    update on=PayInvoice
      input
        string :reason
`,
    });
    expect(brief(result.diagnostics)).toEqual([]);
    const [amount, note] = result.document!.events![0]!.fields;
    expect(amount).toMatchObject({ name: "amount", min: 0, ruleCode: "negative" });
    expect(amount).not.toHaveProperty("ruleMessage");
    expect(Object.keys(note!)).not.toContain("ruleCode");
    expect(result.document!.commands![0]!.fields[1]).toMatchObject({ name: "reason", min: 1, ruleMessage: "give a reason" });
  });
});

describe("MESH_ATTRIBUTE_RULE: message= or code= on a line with no rule, at the option's name", () => {
  const rule = (key: "message" | "code", line: number, column: number) => [
    "MESH_ATTRIBUTE_RULE", `${key} sets what min, max and match report, and this line has none of them`, line, column,
  ];
  test("message= alone, code= alone, both, and an integer with no bound", () => {
    expect(errorsOf('string :title message="x"')).toEqual([rule("message", 4, 18)]);
    expect(errorsOf('string :title nullable code="x"')).toEqual([rule("code", 4, 27)]);
    expect(errorsOf('string :title code="c" message="m"')).toEqual([rule("code", 4, 18), rule("message", 4, 27)]);
    expect(errorsOf('integer :n message="x"')).toEqual([rule("message", 4, 15)]);
  });

  test("the fix names the option", () => {
    const found = build({ "todo/todo.mesh.mx": entity('string :title code="x"') }).diagnostics.find((d) => d.code === "MESH_ATTRIBUTE_RULE");
    expect(found?.fix).toBe("add the rule, or remove code");
  });

  test("on an argument line, an event field and a command field: one diagnostic each", () => {
    const argument = build({ "todo/todo.mesh.mx": entity("string :title", '    create :make\n      input\n        string :note message="m"\n') });
    expect(brief(argument.diagnostics)).toEqual([rule("message", 8, 21)]);
    const event = build({ "billing/invoice-paid.mesh.mx": 'event :InvoicePaid\n  string :x message="m"\n' });
    expect(brief(event.diagnostics)).toEqual([rule("message", 2, 12)]);
    const command = build({ "billing/pay.mesh.mx": 'command :Pay\n  string :x code="c"\n' });
    expect(brief(command.diagnostics)).toEqual([rule("code", 2, 12)]);
  });

  test("an inline event of an owner's events section is read as a file's event is", () => {
    const result = build({ "billing/invoice.mesh.mx": `entity :Invoice
  attributes
    uuid :id primary-key
  actions auto=[:read]
  events
    event :InvoiceVoided
      string :why code="c"
` });
    expect(brief(result.diagnostics)).toEqual([rule("code", 7, 18)]);
  });

  test("a computed line refuses them through MESH_COMPUTED_OPTIONS", () => {
    const result = build({ "todo/todo.mesh.mx": `entity :Todo
  attributes
    uuid :id primary-key
    string :title
  computed
    string :label message="m" value=() => &title
  actions auto=[:read]
` });
    expect(brief(result.diagnostics).map(([code]) => code)).toEqual(["MESH_COMPUTED_OPTIONS"]);
  });

  test("a check line's own code= and message= are unchanged", () => {
    const result = build({ "todo/todo.mesh.mx": entity("string :title", `    update :go
      validate
        check :ok that=() => true code="todo.ok" message="not ok"
`) });
    expect(brief(result.diagnostics)).toEqual([]);
  });
});

// The view: the line's text replaces Mesh's standard text for every rule of the line, and a left-out option keeps the
// standard value of whichever rule failed.
const at = { file: "todo/todo.mesh.mx", line: 4, column: 4, offset: 40 };
const src = '{ file: "todo/todo.mesh.mx", line: 4, column: 5 }';
const field = (shape: Partial<FieldShape> & Pick<FieldShape, "type">): FieldShape => ({ name: "x", nullable: false, position: at, ...shape }) as FieldShape;

describe("the generated check: the line's text for every rule of the line", () => {
  test("both options replace both values of every rule", () => {
    const shape = field({ type: "string", min: 1, max: 3, match: { pattern: "x", flags: "" }, ruleMessage: "m", ruleCode: "c" });
    expect(fieldSchema(shape, false)).toBe('z.string().min(1, "m").max(3, "m").regex(new $RegExp("x", ""), "m")');
    expect(fieldRuleTable(shape)).toBe(`{ too_small: { code: "c", source: ${src} }, too_big: { code: "c", source: ${src} }, regex: { code: "c", source: ${src} } }`);
  });

  test("message alone keeps each rule's standard code", () => {
    const shape = field({ type: "string", min: 1, max: 3, ruleMessage: "1 to 3" });
    expect(fieldSchema(shape, false)).toBe('z.string().min(1, "1 to 3").max(3, "1 to 3")');
    expect(fieldRuleTable(shape)).toBe(`{ too_small: { code: "too_short", source: ${src} }, too_big: { code: "too_long", source: ${src} } }`);
  });

  test("code alone keeps each rule's standard message", () => {
    const shape = field({ type: "integer", min: 0, max: 9, ruleCode: "digit" });
    expect(fieldSchema(shape, false)).toBe('z.int().min(0, "must be at least 0").max(9, "must be at most 9")');
    expect(fieldRuleTable(shape)).toBe(`{ too_small: { code: "digit", source: ${src} }, too_big: { code: "digit", source: ${src} } }`);
  });

  test("text with quotes, a backslash, ${ and a newline is printed as a string literal", () => {
    const text = 'say "hi" \\ ${x}\nnext';
    const shape = field({ type: "string", min: 1, ruleMessage: text, ruleCode: text });
    expect(fieldSchema(shape, false)).toBe(`z.string().min(1, ${JSON.stringify(text)})`);
    expect(fieldRuleTable(shape)).toBe(`{ too_small: { code: ${JSON.stringify(text)}, source: ${src} } }`);
  });
});

describe("at run time, through the generated validator and the runtime's parseInput", () => {
  const roots: string[] = [];
  afterEach(async () => {
    for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
  });
  // An escape-heavy message, written as an MX string literal: a quote, a backslash, `${` and a newline escape.
  const written = String.raw`"say \"hi\" \\ ${"${"}x}\nnext"`;
  const expected = 'say "hi" \\ ${x}\nnext';
  const source = `entity :Todo
  attributes
    uuid :id primary-key
    string :title min=1 max=3 message=${written}
    string :slug match=/^[a-z-]+$/ message="use lower-case letters and hyphens" code="bad_slug"
    integer :n min=0 code="negative"
  actions
    create :create
      input
        &title
        &slug
        &n
`;
  const validator = async () => {
    const root = await mkdtemp(resolve(import.meta.dir, "../.scratch-mesh-rule-text-"));
    roots.push(root);
    const built = buildModel({ root, files: [{ file: "todo/todo.mesh.mx", source }] });
    expect(brief(built.diagnostics)).toEqual([]);
    expect(built.document!.entities[0]!.attributes[1]!.ruleMessage).toBe(expected);
    const config = {
      root, output: resolve(root, "generated"), configFile: resolve(root, "mesh.config.ts"), entityFiles: [], domainRoot: root,
      data: { kind: "data-adapter" as const, name: "sqlite", build: "@meshfw/data-sqlite/build", capabilities: { adapter: "sqlite", capabilities: [] }, options: { file: ":memory:" } },
    };
    const files = await generateFiles({ document: built.document!, config });
    await writeGeneratedFiles(files, config);
    const path = files.find((file) => file.path.endsWith(".validators.ts"))!.path;
    return (await import(resolve(root, path))).createTodoInputSchema as Parameters<typeof parseInput>[0];
  };
  const issues = async (schema: Parameters<typeof parseInput>[0], input: unknown) => {
    try { await parseInput(schema, input); } catch (cause) {
      expect(cause).toBeInstanceOf(InvalidInputError);
      return (cause as InvalidInputError).issues.map(({ path, message, code, source }) => ({ path, message, code, line: source?.line ?? null }));
    }
    throw new Error("expected the input to fail");
  };

  test("each rule reports the line's message and code, or the standard one left out", async () => {
    const schema = await validator();
    expect(await issues(schema, { title: "", slug: "a", n: 0 })).toEqual([{ path: ["title"], message: expected, code: "too_short", line: 4 }]);
    expect(await issues(schema, { title: "abcd", slug: "a", n: 0 })).toEqual([{ path: ["title"], message: expected, code: "too_long", line: 4 }]);
    expect(await issues(schema, { title: "a", slug: "A B", n: 0 })).toEqual([{ path: ["slug"], message: "use lower-case letters and hyphens", code: "bad_slug", line: 5 }]);
    expect(await issues(schema, { title: "a", slug: "a", n: -1 })).toEqual([{ path: ["n"], message: "must be at least 0", code: "negative", line: 6 }]);
    // a type error keeps the validator's message and no code
    expect((await issues(schema, { title: 3, slug: "a", n: 0 }))[0]).toMatchObject({ path: ["title"], code: null, line: null });
    expect(await parseInput(schema, { title: "abc", slug: "a-b", n: 0 })).toEqual({ title: "abc", slug: "a-b", n: 0 });
  }, 30_000);
});
