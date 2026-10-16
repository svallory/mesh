// `MESH_DIALECT.messageVocabulary` (MX 0.1.0-alpha.29; decisions MX-05 and MX-16): MX's messages about a Mesh file use Mesh's
// words. An option is a `key=value` (an attribute is an entity's data member), the file is a "Mesh file", and a tag is spelled
// as its line head is written (`&title`, `attributes`, `${x}`), never as `<member>`, `<attributes>` or `<${x}>`.
//
// Since MX alpha.31 the vocabulary also reaches a contract with an `analyze` hook (every one of `MESH_CONTRACTS`) and the messages
// about MX's built-in tags (`const`, `if`, `define`, ...). The first cases use plain contracts on `SYNTAX_DIALECT` (the dialect
// without Mesh's contracts); "Mesh's own contracts" and "MX's built-in tags" below use the real dialect.
import { lowerSource, type Dialect, type MessageTag } from "@mxlang/core";
import { describe, expect, test } from "bun:test";
import { MESH_DIALECT, MESH_MESSAGE_VOCABULARY, formatTag } from "../src/front-end/dialect.ts";
import { tagLabel } from "../src/front-end/tag-spelling.ts";
import { SYNTAX_DIALECT } from "./syntax-dialect.ts";

const FILE = "/v/todo.mesh.mx";

/** Plain contracts (no `analyze`), so MX words every message about them with the dialect's vocabulary. */
const BOX: Dialect = Object.freeze({
  ...SYNTAX_DIALECT,
  structural: "reject",
  unknownTags: "reject",
  contracts: {
    box: { attributes: { n: { type: "boolean" } }, children: { sub: {} } },
    sub: {},
  },
}) as Dialect;

const messages = (source: string, dialect: Dialect): string[] => lowerSource(source, FILE, { dialect }).diagnostics.map((d) => d.message);
const codes = (source: string, dialect: Dialect): (string | undefined)[] => lowerSource(source, FILE, { dialect }).diagnostics.map((d) => d.code);

describe("the vocabulary Mesh sets", () => {
  test("`attribute` is option/options with the article `an`, `file` is `Mesh file`, and `tree` is unset (MX-16: MX rewords those messages)", () => {
    expect(MESH_MESSAGE_VOCABULARY.attribute).toEqual({ one: "option", many: "options", article: "an" });
    expect(MESH_MESSAGE_VOCABULARY.file).toBe("Mesh file");
    expect(MESH_MESSAGE_VOCABULARY.tree).toBeUndefined();
    expect(MESH_DIALECT.messageVocabulary).toBe(MESH_MESSAGE_VOCABULARY);
  });
});

describe("MX's messages read in Mesh's words", () => {
  test("a `key=value` is an option: an unknown option and a mistyped one", () => {
    expect(messages("box typo=1\n", BOX)).toEqual(["`box`: unknown option `typo`"]);
    expect(messages("box n=1\n", BOX)).toEqual(["`box`: option `n` must be boolean, got number"]);
  });

  test("the article of an option is `an`", () => {
    expect(messages("box\n  <@a(1)/>\n", BOX)).toEqual([
      "`@a` does not take arguments. Remove `(…)` and pass the value as an option (`<@a value=1>`) or as the tag's body.",
    ]);
  });

  test("the file is a Mesh file, not a data file", () => {
    expect(messages("entity :T\n  <!doctype html>\n", MESH_DIALECT)).toEqual([
      "`!doctype` means nothing in a Mesh file; Mesh files describe tags and data, not a page",
    ]);
    expect(codes("entity :T\n  <!doctype html>\n", MESH_DIALECT)).toEqual(["MESH_NOT_IN_ENTITY_FILE"]);
  });

  test("the static-file message is worded by MX with the Mesh file, and reads no `tree`", () => {
    expect(messages("<if=true>\n</if>\n", MESH_DIALECT)).toEqual(["Mesh files are static, so they do not evaluate `if`"]);
  });

  test("a tag is spelled as written: unknown, not allowed, repeated", () => {
    expect(messages("box\n  other\n", BOX)).toEqual(["`other` is not a known tag in the `mesh` dialect"]);
    expect(messages("box\n  sub\n  sub\n", BOX)).toEqual(["`box`: `sub` may not be repeated"]);
    expect(messages("box\n  sub\n  other\n", BOX)).toEqual(["`other` is not a known tag in the `mesh` dialect"]);
  });

  test("a lowered member prints as the user wrote it, `&title`, not `<member>`", () => {
    expect(messages("box\n  &title\n", BOX)).toEqual(["`box`: `&title` is not allowed here; allowed children: `sub`"]);
  });

  test("a section prints as written, `attributes`, not `<attributes>`", () => {
    const entity: Dialect = Object.freeze({ ...BOX, contracts: { entity: { children: { attributes: {} } }, attributes: {} } }) as Dialect;
    expect(messages("entity\n  attributes\n  attributes\n", entity)).toEqual(["`entity`: `attributes` may not be repeated"]);
  });

  test("a dynamic head prints as a Mesh file writes it, `${x}`", () => {
    expect(messages("box\n  <${x}/>\n", BOX)).toEqual(["`box`: a dynamic tag `${x}` cannot be checked against the declared children"]);
  });

  test("no file in these cases reports MX_DIALECT_HOOK_ERROR", () => {
    for (const source of ["box typo=1\n", "box\n  &title\n", "box\n  <${x}/>\n", "box\n  other\n", "box\n  sub\n  sub\n"]) {
      expect(codes(source, BOX), source).not.toContain("MX_DIALECT_HOOK_ERROR");
    }
  });
});

describe("Mesh's own contracts, each with an `analyze` hook, read in Mesh's words (MX alpha.31)", () => {
  const k = "entity :T\n  attributes\n    uuid :id primary-key\n    integer :n\n";
  const diagnostics = (source: string) => lowerSource(source, FILE, { dialect: MESH_DIALECT }).diagnostics.map((d) => [d.code, d.message]);

  test.each([
    ["an unknown option", "entity :T module=1\n", "MESH_UNKNOWN_OPTION", "`entity`: unknown option `module`"],
    ["a mistyped option", "entity :T\n  attributes\n    string :t min=\"a\"\n", "MESH_OPTION_VALUE", "`string`: option `min` must be number, got string"],
    ["a missing required option", k + "  relationships\n    belongs-to :l\n", "MESH_MISSING_OPTION", "`belongs-to`: missing required option `entity`"],
    [
      "a child the section does not allow",
      "entity :T\n  attributes\n    belongs-to :x entity=T\n",
      "MESH_TAG_NOT_ALLOWED",
      "`attributes`: `belongs-to` is not allowed here; allowed children: `uuid`, `string`, `integer`, `float`, `decimal`, `boolean`, `enum`, `date`, `datetime`, `timestamp`, `json`",
    ],
    ["a tag outside its parents", "attributes\n", "MESH_PARENT_NOT_ALLOWED", "`attributes` must be inside `entity`; found at the top level"],
    ["a repeated section", "entity :T\n  attributes\n  attributes\n", "MESH_REPEATED_CHILD", "`entity`: `attributes` may not be repeated"],
    [
      "a CDATA section (\"or in an option value\")",
      "entity :T\n  <![CDATA[x]]>\n",
      "MESH_UNSUPPORTED_CONSTRUCT",
      "`<![CDATA[…]]>` is not supported: write the text inline, as `${\"…\"}` when it must stay raw, or in an option value",
    ],
    [
      "a string where an option name goes",
      "entity :T\n  computed\n    string :t \"hello\"\n",
      "MESH_INVALID_OPTION",
      "Invalid option name `\"hello\"` — an option name may use letters, digits and `._:-`",
    ],
  ])("%s", (_label, source, code, message) => {
    expect(diagnostics(source)).toEqual([[code, message]]);
  });

  test("a Mesh hook's ctx.fail from `analyze` names its owner bare, as the line is written", () => {
    expect(diagnostics(k + "  policies\n    policy :p actions=[1]\n")).toEqual([
      ["MESH_MEMBER_REFERENCE", "`policy`: `actions` requires a list of member references"],
    ]);
    expect(diagnostics(k + "  actions\n    create :c\n      input\n        string|x| :y\n")).toEqual([
      ["MESH_SYNTAX", "`string`: tag parameters and variable bindings are not entity declarations"],
    ]);
  });

  test("a spaced `#id` or `.class` gets no shorthand hint: Mesh's dialect has no shorthands (tagShorthands: false)", () => {
    expect(diagnostics("entity :T\n  attributes\n    string :name #a\n")).toEqual([
      ["MESH_INVALID_OPTION", "Invalid option name `#a` — this file's dialect has no `#id` shorthand; write `id=` as an option"],
    ]);
    expect(diagnostics("entity :T\n  attributes\n    string :name .a\n")).toEqual([
      ["MESH_INVALID_OPTION", "Invalid option name `.a` — this file's dialect has no `.class` shorthand; write `class=` as an option"],
    ]);
  });
});

describe("MX's built-in tags are spelled as written, with no MX-syntax example (MX alpha.31)", () => {
  const diagnostics = (source: string) => lowerSource(source, FILE, { dialect: MESH_DIALECT }).diagnostics.map((d) => [d.code, d.message]);

  test.each([
    ["a bare `const`", "const x = 1\n", "MESH_INVALID_CONST", "`const` without a variable name"],
    ["a `const` under `entity`", "entity :T\n  const x = 1\n", "MESH_INVALID_CONST", "`const` without a variable name"],
    ["`if` with arguments", "entity :T\n  if(true)\n    attributes\n", "MESH_UNSUPPORTED_CONSTRUCT", "Tag does not support arguments. Write the condition as a value option instead."],
    ["`define`", "entity :T\n  define :x\n", "MESH_NOT_IN_ENTITY_FILE", "`define` is a render-time macro: Mesh files are static, so they cannot expand it; inline the content at each use"],
    ["`try` under `entity`", "entity :T\n  try\n", "MESH_TAG_NOT_ALLOWED", "`entity`: `try` is not allowed here; allowed children: `attributes`, `relationships`, `computed`, `actions`, `policies`"],
    ["`return` under `entity`", "entity :T\n  return=1\n", "MESH_TAG_NOT_ALLOWED", "`entity`: `return` is not allowed here; allowed children: `attributes`, `relationships`, `computed`, `actions`, `policies`"],
    ["a `$ statement`", "entity :T\n  $ const x = 1\n", "MESH_UNSUPPORTED_CONSTRUCT", "scriptlets (`$ statement`) are not supported in Mesh; declare a value with `const`"],
  ])("%s", (_label, source, code, message) => {
    expect(diagnostics(source)).toEqual([[code, message]]);
  });

  test("`else` names the tag bare", () => {
    const [d] = diagnostics("entity :T\n  else\n");
    expect(d![0]).toBe("MESH_NOT_IN_ENTITY_FILE");
    expect(d![1]).toStartWith("`else` cannot name a data tag: it is reserved");
  });

  test("no message about a built-in carries a `<tag>` spelling, an MX-syntax example or MX_DIALECT_HOOK_ERROR", () => {
    const sources = [
      "const x = 1\n",
      "entity :T\n  const x = 1\n",
      "entity :T\n  if(true)\n    attributes\n",
      "entity :T\n  <if(true)>\n  </if>\n",
      "entity :T\n  if=true\n",
      "entity :T\n  for|x| of=[1]\n",
      "entity :T\n  else\n",
      "entity :T\n  define :x\n",
      "entity :T\n  return=1\n",
      "entity :T\n  try\n",
      "entity :T\n  $ const x = 1\n",
    ];
    for (const source of sources) {
      for (const [code, message] of diagnostics(source)) {
        expect(code, source).not.toBe("MX_DIALECT_HOOK_ERROR");
        expect(message, source).not.toMatch(/`<[a-z]/);
        expect(message, source).not.toMatch(/<const\/|<for\||<else if>|<return value=|<if=/);
        expect(message, source).not.toContain(" in MX");
      }
    }
  });
});

describe("formatTag", () => {
  const tag = (name: string, form: MessageTag["form"], trigger?: string): MessageTag =>
    ({
      name,
      form,
      ...(trigger === undefined ? {} : { trigger: { id: "member", span: { sourceStart: 0, sourceEnd: trigger.length }, text: trigger } }),
    }) as MessageTag;

  test.each([
    ["a tag as written", tag("belongs-to", "tag"), "belongs-to"],
    ["a section", tag("attributes", "tag"), "attributes"],
    ["a member lowered from `&title`", tag("member", "tag", "&title"), "&title"],
    ["a member lowered from a dotted path", tag("member", "tag", "&billing.total"), "&billing.total"],
    ["a name sugar `:name` trigger", tag("string", "tag", "string :title"), "string :title"],
    ["an attribute tag, with its @", tag("row", "attributeTag"), "@row"],
    ["an attribute tag written by a trigger", tag("row", "attributeTag", "@row"), "@row"],
    ["a dynamic head", tag("x", "dynamic"), "${x}"],
    ["a dynamic head with a call", tag("pick(a, b)", "dynamic"), "${pick(a, b)}"],
    ["a dotted name", tag("billing.InvoiceVoided", "tag"), "billing.InvoiceVoided"],
    ["MX's built-in `if` (MX alpha.31), as written", tag("if", "tag"), "if"],
    ["MX's built-in `const`, as written", tag("const", "tag"), "const"],
    ["MX's built-in `else-if`, as written", tag("else-if", "tag"), "else-if"],
  ])("%s", (_label, input, expected) => {
    expect(formatTag(input)).toBe(expected);
  });

  test.each([
    ["an empty name", tag("", "tag")],
    ["a blank name", tag("  ", "tag")],
    ["a name with a backtick", tag("a`b", "tag")],
    ["a name with a newline", tag("a\nb", "tag")],
    ["a name with a carriage return", tag("a\rb", "tag")],
    ["a dynamic source with a newline", tag("a\nb", "dynamic")],
    ["a dynamic source with a backtick", tag("`x`", "dynamic")],
    ["a trigger text with a newline", tag("member", "tag", "&a\n&b")],
  ])("never throws and falls back to MX's own spelling for %s", (_label, input) => {
    expect(() => formatTag(input)).not.toThrow();
    expect(formatTag(input)).toBeUndefined();
  });

  test("whatever it returns is a non-empty single line without backticks", () => {
    for (const form of ["tag", "attributeTag", "dynamic"] as const) {
      for (const name of ["a", "member", "x y", "${z}", "`", "", "\n", "billing.Invoice", "é"]) {
        const spelled = formatTag(tag(name, form));
        if (spelled === undefined) continue;
        expect(spelled.trim()).not.toBe("");
        expect(spelled).not.toMatch(/[`\r\n]/);
      }
    }
  });
});

describe("Mesh's own tag labels", () => {
  test("are spelled as formatTag spells a tag, and fall back to <name> when it cannot", () => {
    expect(tagLabel("policy")).toBe("`policy`");
    expect(tagLabel("row", "attributeTag")).toBe("`@row`");
    expect(tagLabel("")).toBe("`<>`");
  });

  test("an atom check names the tag as written, once (afterLower's unit.fail adds no owner)", () => {
    const atoms: Dialect = Object.freeze({
      ...BOX,
      contracts: { box: { attributes: { mode: { type: "atom", values: ["loose", "strict"] } } } },
    }) as Dialect;
    expect(messages("box mode=:lose\n", atoms)).toEqual(["`box`: option `mode`: `:lose` is not one of :loose, :strict; did you mean `:loose`?"]);
  });
});
