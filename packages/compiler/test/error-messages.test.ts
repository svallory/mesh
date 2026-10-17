// The build-error catalogue's findings (beads mx-mesh-error-catalogue-fixes): a message names a construct in the author's
// own syntax and never an internal name, `for` and `if` in an entity file say what to write instead,
// and every code Mesh raises has a test that reaches it (or is documented as a guard no source file reaches).
import { describe, expect, test } from "bun:test";
import { lowerSource, type Dialect } from "@mxlang/core";
import type { Entity } from "@meshfw/model";
import { buildModel, staticFileFix } from "../src/front-end/build.ts";
import { MESH_DIALECT } from "../src/front-end/dialect.ts";
import { EmitError, generateFiles } from "../src/typescript/emit.ts";
import { configOf } from "./generated.ts";
import { build, keyed, project } from "./v4.ts";

describe("MESH_EXPR_PLAIN names the construct the author wrote (mx-mesh-expr-plain-optionalcall-message)", () => {
  const entity = (that: string) => `import { Task } from "./task.mesh.mx"
entity :Task
  attributes
    uuid :id primary-key
    integer :n
    string :title nullable
  relationships
    has-many :children entity=Task
  actions auto=[:read]
    update :go
      validate
        check :c [
          that=${that}
          code="c"
          message="m"
        ]
`;
  const plainMessage = (that: string) => {
    const warning = build(entity(that)).diagnostics.find((d) => d.code === "MESH_EXPR_PLAIN");
    return warning?.message;
  };
  const because = (construct: string) =>
    `this expression runs as plain TypeScript with JavaScript's rules for null, not Mesh's, because of ${construct}`;

  // Each construct Babel gives a node type the translator does not handle, as the author writes it, with what the message says.
  test.each([
    ["an optional call", "&title?.toUpperCase?.()", "an optional call (`?.()`)"],
    ["a method call after ?.", "&title?.toUpperCase()", "a method call in a `?.` chain"],
    ["a template literal", "`x${&n}`", "a template literal"],
    ["an array literal", "[1, 2]", "an array literal"],
    ["an object literal", "({ a: 1 })", "an object literal"],
    ["a function expression", "function () {}", "a function expression"],
    ["a class expression", "class {}", "a class expression"],
    ["the comma operator", "(1, 2)", "the comma operator"],
    ["this", "this", "`this`"],
    ["a regular expression", "/a/", "a regular expression literal"],
    ["a bigint", "1n", "a bigint literal"],
    ["a new expression", "new Date()", "a `new` expression"],
    ["a dynamic import", "import(\"x\")", "a dynamic `import()`"],
    ["super", "super.x", "`super`"],
    ["a tagged template", "&title.concat`a`", "a tagged template literal"],
    ["an arrow function as a value", "(() => 1)", "an arrow function used as a value"],
    ["an array literal with a spread", "[...&children]", "an array literal"],
  ])("%s", (_, written, construct) => {
    expect(plainMessage(`() => &n > 1 && ${written}`)).toBe(because(construct));
  });

  test("a call inside a `?.` chain is not called an optional call", () => {
    expect(plainMessage("() => &n > 1 && &title?.a.b()")).toBe(because("a method call in a `?.` chain"));
  });

  test("the message still points at the expression", () => {
    const source = entity("() => &n > 1 && &title?.toUpperCase?.()");
    const warning = build(source).diagnostics.find((d) => d.code === "MESH_EXPR_PLAIN")!;
    expect(warning.severity).toBe("warning");
    expect(warning.position.line).toBe(source.slice(0, warning.position.offset).split("\n").length);
    expect(source.slice(warning.position.offset)).toStartWith("&title?.toUpperCase?.()");
  });
});

describe("`for` and `if` in an entity file say what to write (mx-mesh-for-pipe-message)", () => {
  const FOR = "a Mesh file has no loops; write each declaration out, or write a rule over a list as an expression such as `&lines.every((line) => ...)`";
  const IF = "a Mesh file has no conditionals; put the condition on the line it conditions, as `when=` on a policy or a check, or inside its expression";
  const diagnostic = (body: string) => {
    const result = build(keyed + body);
    expect(result.document).toBeNull();
    return result.diagnostics[0]!;
  };

  test.each([
    ["in attributes", "    for|x| of=[1, 2]\n      string :t\n", 4, 4],
    ["in a body", "  actions\n    for|x| of=[1]\n      create :c\n", 5, 4],
    ["in a validate", "  actions\n    create :c\n      validate\n        for|x| of=[1]\n          check :a that=() => true code=\"a\" message=\"m\"\n", 7, 8],
  ])("for|x| %s keeps its code and position and tells the author what to write", (_, body, line, column) => {
    const d = diagnostic(body);
    expect(d).toMatchObject({ code: "MESH_STRUCTURAL_CONSTRUCT", message: "Mesh files are static, so they do not evaluate `for`", fix: FOR });
    expect([d.position.line, d.position.column]).toEqual([line, column]);
  });

  test("an if says to move the condition to the line", () => {
    const d = diagnostic("  actions\n    if=true\n      create :c\n");
    expect(d).toMatchObject({ code: "MESH_STRUCTURAL_CONSTRUCT", message: "Mesh files are static, so they do not evaluate `if`", fix: IF });
  });

  // MX alpha.31 (mx-mesh-for-if-under-entity): under `structural: "reject"` a `for` or `if` under a closed parent is the one error,
  // at the construct; what it holds is not checked against the parent's children until the construct is gone. Before, the
  // contract looked through it and reported its first child (`MESH_TAG_NOT_ALLOWED`, `MESH_REPEATED_CHILD`).
  test.each([
    ["for, holding a tag entity does not allow", "  for|x| of=[1]\n    string :t\n", "for", 4, 2],
    ["for, holding a second attributes section", "  for|x| of=[1]\n    attributes\n", "for", 4, 2],
    ["for, with no body", "  for|x| of=[1]\n", "for", 4, 2],
    ["if, holding a tag entity does not allow", "  if=true\n    string :t\n", "if", 4, 2],
    ["if, holding a second attributes section", "  if=true\n    attributes\n", "if", 4, 2],
    ["if, with no body", "  if=true\n", "if", 4, 2],
  ])("directly under entity: %s is MESH_STRUCTURAL_CONSTRUCT at the construct, with the fix and no error for its child", (_, body, construct, line, column) => {
    const result = build(keyed + body);
    expect(result.document).toBeNull();
    expect(result.diagnostics).toHaveLength(1);
    const d = result.diagnostics[0]!;
    expect(d).toMatchObject({
      severity: "error",
      code: "MESH_STRUCTURAL_CONSTRUCT",
      message: `Mesh files are static, so they do not evaluate \`${construct}\``,
      fix: construct === "for" ? FOR : IF,
    });
    expect([d.position.line, d.position.column]).toEqual([line, column]);
  });

  // MX alpha.32: every authored form is the one error at the construct. An `else` or `else-if` that follows an `if` is folded
  // into that `if`'s error, so the error is on the `if`.
  test.each([
    ["if(x)", "  if(x)\n", "if", 4, 2],
    ["if|x|=a", "  if|x|=a\n", "if", 4, 2],
    ["a bare if", "  if\n", "if", 4, 2],
    ["for(x)", "  for(x)\n", "for", 4, 2],
    ["for|x|(y)", "  for|x|(y)\n", "for", 4, 2],
    ["if=true then else(x)", "  if=true\n  else(x)\n", "if", 4, 2],
    ["if=true then else-if(x)", "  if=true\n  else-if(x)\n", "if", 4, 2],
  ])("directly under entity, authored as %s: one MESH_STRUCTURAL_CONSTRUCT with the fix (MX alpha.32)", (_, body, construct, line, column) => {
    const result = build(keyed + body);
    expect(result.document).toBeNull();
    expect(result.diagnostics).toHaveLength(1);
    const d = result.diagnostics[0]!;
    expect(d).toMatchObject({
      severity: "error",
      code: "MESH_STRUCTURAL_CONSTRUCT",
      message: `Mesh files are static, so they do not evaluate \`${construct}\``,
      fix: construct === "for" ? FOR : IF,
    });
    expect([d.position.line, d.position.column]).toEqual([line, column]);
  });

  // No Mesh contract has a `transform` (contracts.test.ts pins it), so the tag here is a test contract added to Mesh's dialect.
  // MX lowers such a tag's body while the transform runs, and reports a construct in it then, with the same code and message.
  describe("under a tag with a transform (a test contract on MESH_DIALECT)", () => {
    const dialect = Object.freeze({
      ...MESH_DIALECT,
      contracts: { ...MESH_DIALECT.contracts, box: { attributes: {}, children: { sub: {} }, transform: () => [] }, sub: { attributes: {} } },
    }) as Dialect;
    const lowered = (source: string) =>
      lowerSource(source, "/v/box.mesh.mx", { dialect }).diagnostics.map((d) => ({ code: d.code, message: d.message, line: d.line, column: d.column, fix: staticFileFix(d) }));
    test.each([
      ["for, holding an allowed child", "box\n  for|x| of=[1]\n    sub\n", "for", 2, 2],
      ["if, holding a tag box does not allow", "box\n  if=true\n    string :t\n", "if", 2, 2],
      ["if, with no body", "box\n  if=true\n", "if", 2, 2],
      ["for, one level further down", "box\n  sub\n    for|x| of=[1]\n      sub\n", "for", 3, 4],
    ])("%s is MESH_STRUCTURAL_CONSTRUCT at the construct, with the fix and no error for its child", (_, source, construct, line, column) => {
      expect(lowered(source)).toEqual([
        { code: "MESH_STRUCTURAL_CONSTRUCT", message: `Mesh files are static, so they do not evaluate \`${construct}\``, line, column, fix: construct === "for" ? FOR : IF },
      ]);
    });
    test("without a construct the tag lowers clean", () => expect(lowered("box\n  sub\n")).toEqual([]));
  });

  test("another structural construct gets no hint that does not fit it", () => {
    const result = buildModel({ root: "/p", files: [{ file: "a.mesh.mx", source: "export const x = 1\nentity :T\n" }] });
    expect(result.diagnostics[0]).toMatchObject({ code: "MESH_STRUCTURAL_CONSTRUCT", fix: null });
  });

  test("the hint is for MESH_STRUCTURAL_CONSTRUCT only", () => {
    const message = "Mesh files are static, so they do not evaluate `for`";
    expect(staticFileFix({ code: "MESH_STRUCTURAL_CONSTRUCT", message })).toBe(FOR);
    // MX's agreed rewording keeps the hint.
    expect(staticFileFix({ code: "MESH_STRUCTURAL_CONSTRUCT", message: "Mesh files are static, so they do not evaluate `for`" })).toBe(FOR);
    expect(staticFileFix({ code: "MESH_TAG_NOT_ALLOWED", message })).toBeNull();
    expect(staticFileFix({ code: undefined, message })).toBeNull();
  });
});

describe("MESH_ARGUMENT_OPTIONS (mx-mesh-untested-error-codes)", () => {
  const input = (line: string) => keyed + `  actions\n    create :c\n      input\n        ${line}\n`;
  test.each(["uuid :x primary-key", "string :x unique", "timestamp :x on=:create", "string :x value=() => 1", "string :x unique primary-key"])(
    "an argument `%s` is refused at its line",
    (line) => {
      const source = input(line);
      const result = build(source);
      expect(result.document).toBeNull();
      expect(result.diagnostics).toEqual([expect.objectContaining({
        severity: "error",
        code: "MESH_ARGUMENT_OPTIONS",
        message: "An argument cannot declare primary-key, unique, on, or a body",
        position: { file: "todo/todo.mesh.mx", line: 7, column: 8, offset: source.indexOf(line) },
      })]);
    },
  );
  test("the same options on an attribute, and a plain argument, are not this error", () => {
    expect(build(keyed + "    string :slug unique\n").diagnostics).toEqual([]);
    expect(build(input("string :x min=1")).diagnostics).toEqual([]);
  });
});

describe("MESH_PROJECT_PATH (mx-mesh-untested-error-codes)", () => {
  const at = { file: "mesh.config.ts", line: 1, column: 0, offset: 0 };
  const files = [{ file: "todo.mesh.mx", source: keyed }];
  test.each(["C:\\project", "c:/project", "//server/share/project"])("the project root %s is not a host path", (root) => {
    const result = buildModel({ root, files });
    expect(result.document).toBeNull();
    expect(result.diagnostics).toEqual([{ severity: "error", code: "MESH_PROJECT_PATH", message: "Project root must be a host-compatible path", position: at, fix: null }]);
  });
  test.each(["..", "../other", "/etc", "C:\\elsewhere"])("the domain root %s is outside the project", (domainRoot) => {
    const result = buildModel({ root: "/project", domainRoot, files });
    expect(result.document).toBeNull();
    expect(result.diagnostics).toEqual([{ severity: "error", code: "MESH_PROJECT_PATH", message: "Domain root must stay inside the project", position: at, fix: null }]);
  });
  test("a domain root inside the project is fine", () => {
    expect(buildModel({ root: "/project", domainRoot: "src/domain", files: [{ file: "src/domain/todo.mesh.mx", source: keyed }] }).diagnostics).toEqual([]);
  });
});

describe("MESH_NON_JSON (mx-mesh-untested-error-codes)", () => {
  // The code is reachable: a number literal that overflows (`1e999`) is `Infinity`, which JSON cannot hold. Where a rule
  // checks the number as well (a default, a string bound), the sorted diagnostics put this one first at the entity line.
  const entityPosition = { file: "todo/todo.mesh.mx", line: 1, column: 0, offset: 0 };
  test.each([
    ["float :x min=1e999", "$.entities[0].attributes[1].min"],
    ["integer :x max=1e999", "$.entities[0].attributes[1].max"],
    ["float :x min=-1e999 max=1e999", "$.entities[0].attributes[1].min"],
    ["json :x default={a: 1e999}", "$.entities[0].attributes[1].default.a"],
    ["json :x default=[1, 1e999]", "$.entities[0].attributes[1].default[1]"],
  ])("`%s` is not JSON", (line, path) => {
    const result = build(keyed + `    ${line}\n`);
    expect(result.document).toBeNull();
    expect(result.diagnostics).toEqual([{ severity: "error", code: "MESH_NON_JSON", message: `Model is not JSON-compatible: ${path}`, position: entityPosition, fix: null }]);
  });
  test("MESH_DEFAULT does not come first for a default that overflows", () => {
    const codes = build(keyed + "    float :x default=1e999\n").diagnostics.map((d) => d.code);
    expect(codes).toEqual(["MESH_NON_JSON", "MESH_DEFAULT"]);
  });
  test("a finite number is JSON", () => {
    expect(build(keyed + "    float :x min=-1e300 max=1e300\n").diagnostics).toEqual([]);
  });
});

describe("MESH_EMIT_KEY (mx-mesh-untested-error-codes)", () => {
  // No source file reaches it: `buildModel` refuses an entity without exactly one primary key as MESH_PRIMARY_KEY and
  // returns no document, in this and every other file of the project, and the emitters take only that document. The check
  // stays because `generateFiles` is exported (`@meshfw/compiler`) and takes any `ModelDocument`, built by hand or read back
  // from a `model.json`; this is its refusal for one without a key.
  test("buildModel never returns a document whose entity has no primary key", () => {
    for (const source of [keyed.replace("uuid :id primary-key", "uuid :id"), keyed + "    uuid :other primary-key\n", "entity :Todo\n"]) {
      const result = build(source);
      expect(result.document).toBeNull();
      expect(result.diagnostics.map((d) => d.code)).toContain("MESH_PRIMARY_KEY");
    }
  });

  const documentWithoutKey = (which: "Todo" | "List") => {
    const built = buildModel(project());
    expect(built.diagnostics).toEqual([]);
    const document = built.document!;
    const entity = document.entities.find((e) => e.name === which) as Entity;
    for (const attribute of entity.attributes) attribute.primaryKey = false;
    return { document, entity };
  };
  const refusal = async (document: Parameters<typeof generateFiles>[0]["document"]) => {
    const error = await generateFiles({ document, config: configOf("/project") }).then(() => null, (cause: unknown) => cause);
    expect(error).toBeInstanceOf(EmitError);
    return (error as EmitError).diagnostic;
  };

  test("generateFiles refuses an entity without a key, at the entity", async () => {
    const { document, entity } = documentWithoutKey("Todo");
    expect(await refusal(document)).toEqual({ severity: "error", code: "MESH_EMIT_KEY", message: `Entity ${entity.fqn} has no primary key`, position: entity.position, fix: null });
  });
  test("generateFiles refuses the key a relationship points at, when the target has none", async () => {
    const { document, entity } = documentWithoutKey("List");
    const diagnostic = await refusal(document);
    expect(diagnostic).toMatchObject({ code: "MESH_EMIT_KEY", message: `Entity ${entity.fqn} has no primary key` });
    expect(diagnostic.position).toEqual(entity.position);
  });
});
