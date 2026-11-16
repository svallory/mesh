import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { buildModel } from "../src/front-end/build.ts";
import { generateFiles } from "../src/typescript/emit.ts";
import { explainAction } from "../src/typescript/explain.ts";
import { configOf } from "./generated.ts";
import { parse } from "./helpers.ts";
import { askCallsOf, asynchronyOf, copyExpression, demotionOf, privilegedCallsOf, scopeReachOf } from "../src/front-end/expression.ts";

// Named checks: the `checks` section, `check &name` in a `validate` block, and a check name that counts once per entity.

test("copyExpression gives the copy its own identity and every side-table entry of the original", () => {
  const source = `import { Mesh } from "meshfw"
entity :Task
  attributes
    uuid :id primary-key
    string :title
  actions auto=[:read]
    update :go
      validate
        check :odd that=async (s) => { const t = await Mesh.privileged(Task).read({}); return (await Mesh.can(Task.go, { id: s.self.id }, s.context)) && t.length > 0 } code="odd" message="odd"
        check :short that=() => &title.length < 3 code="short" message="short"
`;
  const result = buildModel({ root: "/p", files: [{ file: "task.mesh.mx", source }] });
  expect(result.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
  const checks = result.document!.entities[0]!.actions[0]!.validate;
  const plain = checks[0]!.that;
  const copy = copyExpression(plain);
  expect(copy).not.toBe(plain);
  expect(copy).toEqual(plain);
  for (const table of [privilegedCallsOf, askCallsOf] as const) {
    expect(table(plain).length).toBeGreaterThan(0);
    expect(table(copy)).toEqual(table(plain));
  }
  expect(asynchronyOf(plain)).toBe("async");
  expect(asynchronyOf(copy)).toBe("async");
  expect(scopeReachOf(plain)).toBeDefined();
  expect(scopeReachOf(copy)).toEqual(scopeReachOf(plain)!);
  // A translated tree keeps what printing it as plain code needs, should the model pass demote it: the copy has its own.
  const translated = checks[1]!.that;
  const twin = copyExpression(translated);
  expect(demotionOf(twin)).toEqual(demotionOf(translated));
  expect(demotionOf(twin)).not.toBe(demotionOf(translated));
});

test("copyExpression copies every table keyed by an expression: a new one must be added to it", () => {
  const text = readFileSync(new URL("../src/front-end/expression.ts", import.meta.url), "utf8");
  expect(text.match(/new WeakMap</g)?.length).toBe(5);
});

const FILE = "billing/invoice.mesh.mx";
const build = (source: string) => buildModel({ root: "/p", files: [{ file: FILE, source }] });
/** Each diagnostic as `line:column CODE message`. */
const said = (source: string) => build(source).diagnostics.map((d) => `${d.position.line}:${d.position.column} ${d.code} ${d.message}`);
const codes = (source: string) => build(source).diagnostics.map((d) => `${d.position.line}:${d.position.column} ${d.code}`);
const parsed = (source: string) => parse(source, FILE).diagnostics.map((d) => `${d.line}:${d.column} ${d.code}`);

/** An Invoice whose `checks` section is `checks`, with `actions` lines under its actions section. */
const invoice = (checks: string, actions: string, extra = "") => `entity :Invoice
  attributes
    uuid :id primary-key
    date :issuedOn
    date :dueOn
    string :note nullable
${extra}${checks ? `  checks\n${checks}` : ""}  actions auto=[:read]
${actions}`;
const DUE = `    check :dueAfterIssue [
      that=({ input }) => (input.dueOn ?? &dueOn) >= (input.issuedOn ?? &issuedOn)
      code="invalid_dates"
      message="the due date cannot be before the issue date"
    ]
`;
const ISSUE = (validate: string) => `    create :issue
      input
        &issuedOn
        &dueOn
      validate
${validate}`;
const RESCHEDULE = (validate: string) => `    update :reschedule
      input
        &issuedOn
        &dueOn
      validate
${validate}`;
/** F1: one named check, used by a create and an update that both take its inputs. */
const F1 = invoice(DUE, ISSUE("        check &dueAfterIssue\n") + RESCHEDULE("        check &dueAfterIssue\n"));

describe("the `checks` section and `check &name`: what the contracts take", () => {
  test.each([
    ["one named check", F1],
    ["several named checks", invoice(DUE + '    check :noted that=() => &note !== null code="noted" message="a note is needed"\n', ISSUE("        check &dueAfterIssue\n        check &noted\n"))],
    ["an empty section", invoice("", ISSUE('        check :ok that=() => true code="ok" message="ok"\n'), "  checks\n")],
    ["a reference in an `always` block", invoice(DUE, `    always types=[:update]\n      validate\n        check &dueAfterIssue\n${RESCHEDULE('        check :ok that=() => true code="ok" message="ok"\n')}`)],
  ])("%s builds with no diagnostic", (_name, source) => {
    expect(said(source)).toEqual([]);
  });

  test("`checks` written after `actions` works the same", () => {
    const after = `entity :Invoice
  attributes
    uuid :id primary-key
    date :issuedOn
    date :dueOn
  actions auto=[:read]
${RESCHEDULE("        check &dueAfterIssue\n")}  checks
${DUE}`;
    expect(said(after)).toEqual([]);
    expect(build(after).document!.entities[0]!.actions[0]!.validate.map((check) => check.label)).toEqual(["dueAfterIssue"]);
  });

  test("`check member=&a` lowers as `check &a` does", () => {
    const spelled = F1.replace("check &dueAfterIssue\n    update", "check member=&dueAfterIssue\n    update");
    expect(spelled).not.toBe(F1);
    expect(said(spelled)).toEqual([]);
    expect(build(spelled).document!.entities[0]!.actions[0]!.validate[0]!.label).toBe("dueAfterIssue");
  });

  test.each([
    ["`checks` twice", invoice(DUE, ISSUE("        check &dueAfterIssue\n"), "  checks\n"), "8:2 MESH_REPEATED_CHILD"],
    ["an option on `checks`", invoice(DUE, ISSUE("        check &dueAfterIssue\n")).replace("  checks\n", "  checks strict\n"), "7:9 MESH_UNKNOWN_OPTION"],
    ["a `policy` under `checks`", invoice(DUE + "    policy :open\n      authorize-if=() => true\n", ISSUE("        check &dueAfterIssue\n")), "13:4 MESH_TAG_NOT_ALLOWED"],
    ["`checks` under `actions`", invoice("", `    checks\n${ISSUE('        check :ok that=() => true code="ok" message="ok"\n')}`), "8:4 MESH_TAG_NOT_ALLOWED"],
    ["two members on one line", invoice(DUE, ISSUE("        check &dueAfterIssue &issuedOn\n")), "19:29 MESH_SYNTAX"],
    ["a member written as a string", invoice(DUE, ISSUE('        check member="dueAfterIssue"\n')), "19:21 MESH_OPTION_VALUE"],
  ])("%s is refused by the contracts", (_name, source, expected) => {
    expect(parsed(source)).toEqual([expected]);
  });
});

describe("the form of a `check` line, reported by the builder line by line", () => {
  test("D-1: a line that declares and refers", () => {
    expect(said(invoice(DUE, ISSUE('        check :a &dueAfterIssue that=() => true code="a" message="m"\n')))).toEqual([
      "8:4 MESH_CHECK_UNUSED check :dueAfterIssue is declared and no `validate` uses it, so it never runs",
      "19:17 MESH_MEMBER_REFERENCE `check`: a line declares a check (`check :name` with its options) or uses one (`check &name` alone), not both",
    ]);
  });

  test("D-2: an option on a reference, one diagnostic per line, at the option", () => {
    expect(said(invoice(DUE, ISSUE('        check &dueAfterIssue when=() => true\n        check &dueAfterIssue code="x" message="y"\n')))).toEqual([
      "19:29 MESH_UNKNOWN_OPTION `check`: a reference to a check takes no option: remove `when`, or change the check where `checks` declares it",
      "20:29 MESH_UNKNOWN_OPTION `check`: a reference to a check takes no option: remove `code`, or change the check where `checks` declares it",
    ]);
  });

  test("D-3: a line under a reference", () => {
    expect(said(invoice(DUE, ISSUE("        check &dueAfterIssue\n          publish=() => null\n")))).toEqual([
      "20:10 MESH_TAG_NOT_ALLOWED `check`: a reference to a check takes no line under it: remove `publish`",
    ]);
  });

  test("D-4: a declaration missing an option keeps MX's text and position, one per line", () => {
    const missing = (lines: string) => said(invoice("", RESCHEDULE(lines)));
    // The texts and positions `main` gave when the contract required the four options.
    expect(missing('        check :a code="x" message="m"\n')).toEqual(["13:8 MESH_MISSING_OPTION `check`: missing required option `that`"]);
    expect(missing('        check that=() => true code="x" message="m"\n')).toEqual(["13:8 MESH_MISSING_OPTION `check`: missing required option `name`"]);
    expect(missing('        check :a that=() => true message="m"\n')).toEqual(["13:8 MESH_MISSING_OPTION `check`: missing required option `code`"]);
    expect(missing('        check :a that=() => true code="x"\n')).toEqual(["13:8 MESH_MISSING_OPTION `check`: missing required option `message`"]);
    expect(missing("        check\n")).toEqual(["13:8 MESH_MISSING_OPTION `check`: missing required option `name`"]);
    expect(missing('        check :a code="x" message="m"\n        check :b that=() => true message="m"\n')).toEqual([
      "13:8 MESH_MISSING_OPTION `check`: missing required option `that`",
      "14:8 MESH_MISSING_OPTION `check`: missing required option `code`",
    ]);
    // Under `checks` too.
    expect(said(invoice('    check :x code="x" message="m"\n    check :y that=() => true message="m"\n', ""))).toEqual([
      "8:4 MESH_MISSING_OPTION `check`: missing required option `that`",
      "9:4 MESH_MISSING_OPTION `check`: missing required option `code`",
    ]);
  });

  test("D-5: a reference under `checks`, one per line", () => {
    expect(said(invoice(DUE + "    check &dueAfterIssue\n    check &other\n", ISSUE("        check &dueAfterIssue\n")))).toEqual([
      "13:10 MESH_MEMBER_REFERENCE `checks` declares checks: a line under it is `check :name` with its options, and `check &name` is how a `validate` block uses one",
      "14:10 MESH_MEMBER_REFERENCE `checks` declares checks: a line under it is `check :name` with its options, and `check &name` is how a `validate` block uses one",
    ]);
  });

  test("what the contract said before still holds: blank text, `publish` in `validate` and in a declared check", () => {
    expect(codes(invoice("", RESCHEDULE('        check :a that=() => true code="x" message=""\n')))).toEqual(["13:42 MESH_TEXT"]);
    expect(codes(invoice("", RESCHEDULE("        publish=() => null\n")))).toEqual(["13:8 MESH_PUBLISH"]);
    expect(codes(invoice("", RESCHEDULE('        check :a that=() => true code="x" message="m"\n          publish=() => null\n')))).toEqual(["14:10 MESH_PUBLISH"]);
    expect(codes(invoice('    check :a that=() => true code="x" message="m"\n      publish=() => null\n', RESCHEDULE("        check &a\n")))).toEqual(["9:6 MESH_PUBLISH"]);
  });
});

describe("a reference expands into the referring block", () => {
  test("F1: each referrer holds the declaration with its own reference and its own function objects", () => {
    const result = build(F1);
    expect(result.diagnostics).toEqual([]);
    const [issue, reschedule] = result.document!.entities[0]!.actions;
    const [a, b] = [issue!.validate[0]!, reschedule!.validate[0]!];
    for (const check of [a, b]) {
      expect(check).toMatchObject({ label: "dueAfterIssue", code: "invalid_dates", message: "the due date cannot be before the issue date", position: { line: 8, column: 4 } });
    }
    expect(a.reference).toMatchObject({ line: 19, column: 14 });
    expect(b.reference).toMatchObject({ line: 25, column: 14 });
    expect(a.that).not.toBe(b.that);
    expect(a.that.source).toBe(b.that.source);
  });

  test("a reference keeps its place among the block's inline checks", () => {
    const source = invoice(DUE, ISSUE('        check :first that=() => true code="a" message="m"\n        check &dueAfterIssue\n        check :last that=() => true code="b" message="m"\n'));
    expect(said(source)).toEqual([]);
    expect(build(source).document!.entities[0]!.actions[0]!.validate.map((check) => [check.label, check.reference !== undefined])).toEqual([["first", false], ["dueAfterIssue", true], ["last", false]]);
  });

  test("a project with no named check writes no `reference` key in model.json", () => {
    const document = build(invoice("", RESCHEDULE('        check :ok that=() => true code="ok" message="ok"\n'))).document!;
    expect(JSON.stringify(document)).not.toContain('"reference"');
    expect(JSON.stringify(build(F1).document)).toContain('"reference"');
  });
});

describe("references the build refuses", () => {
  const ATTEMPTS = `    update :annotate
      input
        &note
      validate
        check :inlineOnly that=() => true code="i" message="m"
`;
  test.each([
    ["misspelt", "check &dueAfterIsue", DUE, "&dueAfterIsue is not a check of billing.Invoice: `check &name` uses a check the entity's `checks` section declares (&dueAfterIssue). Did you mean &dueAfterIssue?"],
    ["an attribute", "check &note", DUE, "&note is not a check of billing.Invoice: `check &name` uses a check the entity's `checks` section declares (&dueAfterIssue)."],
    ["another action's inline check", "check &inlineOnly", DUE, "&inlineOnly is not a check of billing.Invoice: `check &name` uses a check the entity's `checks` section declares (&dueAfterIssue)."],
    ["an entity with no `checks` section", "check &dueAfterIssue", "", "&dueAfterIssue is not a check of billing.Invoice: `check &name` uses a check the entity's `checks` section declares, and it declares none."],
  ])("D-6: a reference to %s", (_name, line, checks, message) => {
    const extra = checks ? "" : "";
    const source = invoice(checks, extra + ISSUE(`        ${line}\n`) + ATTEMPTS + (checks ? RESCHEDULE("        check &dueAfterIssue\n") : ""));
    expect(build(source).diagnostics.filter((d) => d.code === "MESH_UNKNOWN_MEMBER").map((d) => d.message)).toEqual([message]);
  });

  test("D-6 is legal for a check declared later in the file", () => {
    const later = invoice("", ISSUE("        check &dueAfterIssue\n") + RESCHEDULE("        check &dueAfterIssue\n")) + `  checks\n${DUE}`;
    expect(said(later)).toEqual([]);
  });

  test("D-7: the same reference twice in one block, at the second", () => {
    expect(said(invoice(DUE, ISSUE("        check &dueAfterIssue\n        check &dueAfterIssue\n")))).toEqual([
      "20:14 MESH_DUPLICATE_MEMBER Duplicate check &dueAfterIssue: this `validate` already lists it, and a check runs once",
    ]);
    // The same reference in two actions, and in an action and an `always` block that does not cover it, are legal.
    expect(said(invoice(DUE, `    always types=[:create]\n      validate\n        check &dueAfterIssue\n${RESCHEDULE("        check &dueAfterIssue\n")}`))).toEqual([]);
  });

  test("a named check is a member: named like an attribute, or twice, it is a duplicate", () => {
    expect(codes(invoice(DUE + '    check :note that=() => true code="n" message="m"\n', ISSUE("        check &dueAfterIssue\n        check &note\n")))).toEqual(["13:4 MESH_DUPLICATE_MEMBER"]);
    expect(codes(invoice(DUE + '    check :dueAfterIssue that=() => true code="n" message="m"\n', ISSUE("        check &dueAfterIssue\n")))).toEqual(["13:4 MESH_DUPLICATE_MEMBER"]);
  });

  test("an inline check and a reference of one name in one block: one duplicate, at the later line, in either order", () => {
    const inline = '        check :dueAfterIssue that=() => true code="i" message="m"\n';
    for (const [lines, at] of [[`${inline}        check &dueAfterIssue\n`, "20:14"], [`        check &dueAfterIssue\n${inline}`, "20:8"]] as const)
      expect(said(invoice(DUE, ISSUE(lines)))).toEqual([`${at} MESH_DUPLICATE_MEMBER Duplicate member :dueAfterIssue`]);
  });

  test("D-9: a named check no `validate` uses is a warning; a refused reference counts as a use", () => {
    expect(build(invoice(DUE, ISSUE('        check :ok that=() => true code="ok" message="ok"\n'))).diagnostics).toEqual([{
      severity: "warning", code: "MESH_CHECK_UNUSED", message: "check :dueAfterIssue is declared and no `validate` uses it, so it never runs",
      position: expect.objectContaining({ line: 8, column: 4 }), fix: "list it in the `validate` of each action it is a rule of: `check &dueAfterIssue`",
    }]);
    expect(codes(invoice(DUE, ISSUE("        check &dueAfterIssue when=() => true\n")))).toEqual(["19:29 MESH_UNKNOWN_OPTION"]);
  });
});

describe("generated code", () => {
  const generate = async (source: string) => {
    const result = build(source);
    expect(result.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    return await generateFiles({ document: result.document!, config: configOf("/p") });
  };
  const fileOf = (files: { path: string; contents: string }[], end: string) => files.find((file) => file.path.endsWith(end))!.contents;

  test("F1: one function per referring block, typed with its scope; the actions pass the declaration's source", async () => {
    const files = await generate(F1);
    const expressions = fileOf(files, "invoice.expressions.ts");
    expect(expressions).toMatch(/"issue\.check\.dueAfterIssue\.that": \(\s*\$s: \$billing\$Invoice\$NewScope</);
    expect(expressions).toMatch(/"reschedule\.check\.dueAfterIssue\.that": \(\s*\$s: \$billing\$Invoice\$CheckScope</);
    const actions = fileOf(files, "invoice.actions.ts");
    expect(actions.match(/source: \{ file: "billing\/invoice\.mesh\.mx", line: 8, column: 5 \}/g)).toHaveLength(2);
  });

  test("F1 generates what the same check written inline in each action does, positions aside", async () => {
    const body = DUE.replace(/^ {4}/gm, "        ");
    const inline = invoice("", ISSUE(body) + RESCHEDULE(body));
    const strip = (text: string) => text.replace(/line: \d+, column: \d+/g, "").replace(/mesh\.mx:\d+:\d+/g, "").replace(/"line": \d+|"column": \d+|"offset": \d+/g, "");
    const named = await generate(F1), written = await generate(inline);
    for (const file of named.filter((file) => /\.(actions|expressions|types|validators)\.ts$/.test(file.path)))
      expect(strip(file.contents)).toBe(strip(written.find((other) => other.path === file.path)!.contents));
  });

  test("`always` blocks: the ids of every part, and `mesh explain` lists a named check as an inline one", async () => {
    const source = invoice(`    check :noted [
      that=({ input }) => input.note !== null
      when=() => true
      code="noted"
      message=() => "a note is needed"
      details=() => ({ why: "notes" })
    ]
`, `    always types=[:update]\n      validate\n        check &noted\n    update :annotate\n      input\n        &note\n      validate\n        check :ok that=() => true code="ok" message="ok"\n`);
    const expressions = fileOf(await generate(source), "invoice.expressions.ts");
    for (const part of ["that", "when", "details", "message"]) expect(expressions).toContain(`"always.0.check.noted.${part}"`);
    const lines = explainAction(build(source).document!.entities[0]!, "annotate")!.join("\n");
    expect(lines).toContain("noted");
    expect(lines).toContain("always");
  });
});
