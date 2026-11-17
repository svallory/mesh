import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { buildModel } from "../src/front-end/build.ts";
import { checksOf } from "../src/model/action-expressions.ts";
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
  const checks = checksOf(result.document!.entities[0]!.actions[0]!.validate);
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
  expect(text.match(/new WeakMap</g)?.length).toBe(7);
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
    expect(checksOf(build(after).document!.entities[0]!.actions[0]!.validate).map((check) => check.label)).toEqual(["dueAfterIssue"]);
  });

  test("`check member=&a` lowers as `check &a` does", () => {
    const spelled = F1.replace("check &dueAfterIssue\n    update", "check member=&dueAfterIssue\n    update");
    expect(spelled).not.toBe(F1);
    expect(said(spelled)).toEqual([]);
    expect(checksOf(build(spelled).document!.entities[0]!.actions[0]!.validate)[0]!.label).toBe("dueAfterIssue");
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
    // A reference to an incomplete declaration is no second error: the check exists, it is only incomplete.
    expect(said(invoice('    check :x that=() => true message="m"\n    check :y that=() => true code="y" message="m"\n', RESCHEDULE("        check &x\n        check &y\n")))).toEqual([
      "8:4 MESH_MISSING_OPTION `check`: missing required option `code`",
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
    const [a, b] = [checksOf(issue!.validate)[0]!, checksOf(reschedule!.validate)[0]!];
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
    expect(checksOf(build(source).document!.entities[0]!.actions[0]!.validate).map((check) => [check.label, check.reference !== undefined])).toEqual([["first", false], ["dueAfterIssue", true], ["last", false]]);
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
    const source = invoice(checks, ISSUE(`        ${line}\n`) + ATTEMPTS + (checks ? RESCHEDULE("        check &dueAfterIssue\n") : ""));
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

  test("two declarations of one name under `checks`: the fix says to rename or remove one", () => {
    expect(build(invoice(DUE + DUE, ISSUE("        check &dueAfterIssue\n"))).diagnostics.map((d) => [d.position.line, d.code, d.message, d.fix])).toEqual([
      [13, "MESH_DUPLICATE_MEMBER", "Duplicate member :dueAfterIssue", "give each rule its own name, or remove one"],
    ]);
  });

  test("an inline check and a reference of one name in one block: one duplicate, at the later line, in either order", () => {
    // The inline check's name is the declaration's (SYN-08): the member list reports the pair at the later line.
    const inline = '        check :dueAfterIssue that=() => true code="i" message="m"\n';
    for (const [lines, at] of [[`${inline}        check &dueAfterIssue\n`, "19:8"], [`        check &dueAfterIssue\n${inline}`, "20:8"]] as const)
      expect(said(invoice(DUE, ISSUE(lines)))).toEqual([`${at} MESH_DUPLICATE_MEMBER Duplicate member :dueAfterIssue`]);
    // With `checks` written after `actions`, the declaration is the later line, and the pair is reported there.
    const after = invoice("", ISSUE(`${inline}        check &dueAfterIssue\n`)) + `  checks\n${DUE}`;
    expect(build(after).diagnostics.map((d) => [d.position.line, d.code, d.fix])).toEqual([
      [16, "MESH_DUPLICATE_MEMBER", "declare the check once under `checks` and use it with `check &dueAfterIssue` in each `validate`, or give each rule its own name"],
    ]);
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

  test("a named check generates what the same check written inline does, positions aside", async () => {
    // One referrer each: written inline in two actions, one name would be a duplicate member.
    const body = DUE.replace(/^ {4}/gm, "        ");
    const inline = invoice("", ISSUE(body) + RESCHEDULE('        check :ok that=() => true code="ok" message="ok"\n'));
    const named = invoice(DUE, ISSUE("        check &dueAfterIssue\n") + RESCHEDULE('        check :ok that=() => true code="ok" message="ok"\n'));
    const strip = (text: string) => text.replace(/line: \d+, column: \d+/g, "").replace(/mesh\.mx:\d+:\d+/g, "").replace(/"line": \d+|"column": \d+|"offset": \d+/g, "");
    const fromNamed = await generate(named), written = await generate(inline);
    for (const file of fromNamed.filter((file) => /\.(actions|expressions|types|validators)\.ts$/.test(file.path)))
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

describe("a named check is typed once per referrer, in that referrer's scope (ruling D13)", () => {
  const SPEC = `    check :dueAfterIssue [
      that=() => &dueOn >= &issuedOn
      code="invalid_dates"
      message="the due date cannot be before the issue date"
    ]
`;
  test("F2: on a create, the warnings are at the declaration, once per create, each naming it; none for an update", () => {
    const source = `import { OpenInvoice } from "./open-invoice.mesh.mx"
${invoice(SPEC, `    create :issue
      validate
        check &dueAfterIssue
    create :draft
      input
        &dueOn
      validate
        check &dueAfterIssue
    create on=OpenInvoice
      input
        &dueOn
      validate
        check &dueAfterIssue
${RESCHEDULE("        check &dueAfterIssue\n")}`)}`;
    const result = buildModel({ root: "/p", files: [{ file: FILE, source }, { file: "billing/open-invoice.mesh.mx", source: "command :OpenInvoice\n  date :dueOn\n" }] });
    expect(result.diagnostics.map((d) => `${d.position.line}:${d.position.column} ${d.code} ${d.message.split(":")[0]!.trim()}`)).toEqual([
      "10:17 MESH_VALIDATE_UNFILLED `&dueOn` is null in create",
      "10:17 MESH_VALIDATE_NOT_APPLIED in create",
      "10:17 MESH_VALIDATE_NOT_APPLIED in create",
      "10:27 MESH_VALIDATE_UNFILLED `&issuedOn` is null in create",
      "10:27 MESH_VALIDATE_UNFILLED `&issuedOn` is null in create",
      "10:27 MESH_VALIDATE_UNFILLED `&issuedOn` is null in create",
    ]);
    const messages = result.diagnostics.map((d) => d.message);
    expect(messages).toContain("`&dueOn` is null in create :issue, which uses this check: `validate` sees the new instance before the input is applied, so a result that depends on it is unknown and the check fails");
    expect(messages).toContain("in create :draft, which uses this check, `&dueOn` here is the new instance's value before the input is applied (its default, or null), not the caller's: `validate` sees `self` before the input");
    expect(messages).toContain("in create :openInvoice, which uses this check, `&dueOn` here is the new instance's value before the input is applied (its default, or null), not the caller's: `validate` sees `self` before the input");
    for (const create of ["issue", "draft", "openInvoice"]) expect(messages.filter((m) => m.startsWith(`\`&issuedOn\` is null in create :${create},`))).toHaveLength(1);
  });

  test("D-12 through an `always` block: one warning per covered create, naming it and the block", () => {
    const source = invoice(`    check :noted that=() => &dueOn !== null code="due" message="m"\n`, `    always types=[:create]
      validate
        check &noted
    create :issue
      input
        &dueOn
    create :draft
      input
        &dueOn
`);
    expect(said(source)).toEqual([
      "8:28 MESH_VALIDATE_NOT_APPLIED in create :issue, which uses this check through the `always` block at line 10, `&dueOn` here is the new instance's value before the input is applied (its default, or null), not the caller's: `validate` sees `self` before the input",
      "8:28 MESH_VALIDATE_NOT_APPLIED in create :draft, which uses this check through the `always` block at line 10, `&dueOn` here is the new instance's value before the input is applied (its default, or null), not the caller's: `validate` sees `self` before the input",
    ]);
  });

  const READS = (body: string) => `    check :reads that=${body} code="r" message="m"\n`;
  test("F3 and D-11: reading an input a referrer does not take is an error at the read, once per such referrer", () => {
    const source = invoice(READS("({ input }) => input.note !== null"), `    create :issue
      input
        &note
      validate
        check &reads
    update :reschedule
      input
        &dueOn
      validate
        check &reads
    destroy :drop
      validate
        check &reads
`);
    expect(build(source).diagnostics.map((d) => [d.code, d.position.line, d.position.column, d.message, d.fix])).toEqual([
      ["MESH_CHECK_INPUT", 8, 37, "`input.note` is read by a check that update :reschedule uses, and update :reschedule takes no `note`", "add `note` to the input of update :reschedule, or write the check for that action in its own `validate`"],
      ["MESH_CHECK_INPUT", 8, 37, "`input.note` is read by a check that destroy :drop uses, and destroy :drop takes no `note`", "add `note` to the input of destroy :drop, or write the check for that action in its own `validate`"],
    ]);
  });

  test.each([
    ["`input?.x`", "({ input }) => input?.note !== null"],
    ["`input.x ?? &x`", "({ input }) => (input.note ?? &note) !== null"],
  ])("D-11: %s is a read of the input too", (_name, body) => {
    const source = invoice(READS(body), `${RESCHEDULE("        check &reads\n")}    update :annotate\n      input\n        &note\n      validate\n        check &reads\n`);
    expect(build(source).diagnostics.map((d) => [d.code, d.message.split(",")[0]])).toEqual([["MESH_CHECK_INPUT", "`input.note` is read by a check that update :reschedule uses"]]);
  });

  test("D-11 holds for translated code only (D25): plain code, an object literal's parts and a demoted tree are left to tsc", () => {
    const plain = (part: string) => invoice(`    check :reads that=() => true code="r" ${part.startsWith("message") ? "" : 'message="m" '}${part}\n`, RESCHEDULE("        check &reads\n") + "    update :annotate\n      validate\n        check &reads\n");
    expect(codes(plain("details=({ input }) => ({ d: input.note })"))).toEqual([]);
    expect(codes(plain("message=({ input }) => `x ${input.note}`"))).toEqual([]);
    // A non-boolean operand of `&&` demotes the tree to plain code.
    const demoted = invoice(READS("({ input }) => input.note !== null && &note"), RESCHEDULE("        check &reads\n"));
    expect(codes(demoted)).toEqual(["8:37 MESH_EXPR_PLAIN"]);
    // The same read, translated, is the error.
    expect(codes(plain("when=({ input }) => input.note !== null"))).toEqual(["8:74 MESH_CHECK_INPUT", "8:74 MESH_CHECK_INPUT"]);
  });

  test("D-11 legal neighbours: an input every referrer takes, required in one and optional in another; an inline check", () => {
    const takes = invoice(READS("({ input }) => input.dueOn !== null"), `${ISSUE("        check &reads\n")}${RESCHEDULE("        check &reads\n")}`);
    expect(said(takes)).toEqual([]);
    // An inline check is not checked against its action's input, as before.
    expect(said(invoice("", RESCHEDULE('        check :reads that=({ input }) => input.note !== null code="r" message="m"\n')))).toEqual([]);
  });

  test("D-11 and the key: an update and a destroy take it whatever it is named, a create does not", () => {
    for (const key of ["id", "code"]) {
      const keyed = (actions: string) => `entity :Invoice
  attributes
    uuid :${key} primary-key
    date :dueOn
  checks
    check :keyed that=({ input }) => input.${key} !== null code="k" message="m"
  actions auto=[:read]
${actions}`;
      const updates = "    update :touch\n      validate\n        check &keyed\n    destroy :drop\n      validate\n        check &keyed\n";
      expect(said(keyed(updates))).toEqual([]);
      expect(codes(keyed(`${updates}    create :open\n      input\n        &dueOn\n      validate\n        check &keyed\n`))).toEqual(["6:37 MESH_CHECK_INPUT"]);
    }
  });

  const AUTO = (always: string, bump: string) => `entity :Todo
  attributes
    uuid :id primary-key
    integer :version default=0
  checks
    check :v that=({ input }) => input.expectedVersion === &version code="v" message="m"
  actions auto=[:update]
${always}    update :bump
      input
        integer :expectedVersion
      validate
${bump}        check :ok that=() => true code="ok" message="ok"
`;
  const ALWAYS = "    always types=[:update]\n      validate\n        check &v\n";
  test("F5: an `always` block is checked in each action it covers, `auto=` ones included", () => {
    expect(said(AUTO(ALWAYS, ""))).toEqual([
      "6:33 MESH_CHECK_INPUT `input.expectedVersion` is read by a check that update :update uses through the `always` block at line 8, and update :update takes no `expectedVersion`",
    ]);
    expect(said(AUTO("", "        check &v\n"))).toEqual([]);
  });

  test("D-10: one named check reached twice by one action, through its own `validate` or a second block", () => {
    expect(said(AUTO(ALWAYS, "        check &v\n")).filter((line) => line.includes("MESH_DUPLICATE_MEMBER"))).toEqual([
      "15:14 MESH_DUPLICATE_MEMBER Duplicate check &v: update :bump already runs it through the `always` block at line 8, and a check runs once",
    ]);
    expect(said(AUTO(ALWAYS + ALWAYS, "")).filter((line) => line.includes("MESH_DUPLICATE_MEMBER"))).toEqual([
      "13:14 MESH_DUPLICATE_MEMBER Duplicate check &v: update :bump already runs it through the `always` block at line 8, and a check runs once",
    ]);
    // With only the generated update covered by both blocks, the message names it.
    const auto = AUTO(ALWAYS.replace("types=[:update]", "actions=[&update]") + ALWAYS.replace("types=[:update]", "actions=[&update]"), "");
    expect(said(auto).filter((line) => line.includes("MESH_DUPLICATE_MEMBER"))).toEqual([
      "13:14 MESH_DUPLICATE_MEMBER Duplicate check &v: update :update already runs it through the `always` block at line 8, and a check runs once",
    ]);
    // An `always` block and an action it does not cover may use the same check.
    expect(said(AUTO(ALWAYS.replace("types=[:update]", "actions=[&update]"), "        check &v\n")).filter((line) => line.includes("MESH_DUPLICATE_MEMBER"))).toEqual([]);
  });

  const NULLABLE = `    check :datesDiffer that=({ input }) => input.dueOn !== input.issuedOn code="dates" message="m"\n`;
  test("F6: a warning only some referrers have names them; one every referrer has does not", () => {
    expect(said(invoice(NULLABLE, ISSUE("        check &datesDiffer\n") + RESCHEDULE("        check &datesDiffer\n")))).toEqual([
      "8:43 MESH_EXPR_NULL_EQUALITY in update :reschedule, which uses this check, both sides can be null, and a comparison with null is unknown, not true (JavaScript says `null === null`)",
    ]);
    const second = RESCHEDULE("        check &datesDiffer\n").replace("reschedule", "postpone");
    expect(said(invoice(NULLABLE, ISSUE("        check &datesDiffer\n") + RESCHEDULE("        check &datesDiffer\n") + second))).toEqual([
      "8:43 MESH_EXPR_NULL_EQUALITY in update :reschedule and update :postpone, which use this check, both sides can be null, and a comparison with null is unknown, not true (JavaScript says `null === null`)",
    ]);
    expect(said(invoice(NULLABLE, RESCHEDULE("        check &datesDiffer\n") + second))).toEqual([
      "8:43 MESH_EXPR_NULL_EQUALITY both sides can be null, and a comparison with null is unknown, not true (JavaScript says `null === null`)",
    ]);
  });

  test("R12: a mistake every referrer has is reported once, with its own text", () => {
    const plain = invoice(READS("() => &note"), ISSUE("        check &reads\n") + RESCHEDULE("        check &reads\n") + "    update :annotate\n      validate\n        check &reads\n");
    expect(codes(plain)).toEqual(["8:28 MESH_EXPR_PLAIN"]);
    expect(said(plain)[0]).toContain("8:28 MESH_EXPR_PLAIN this expression runs as plain TypeScript");
    const before = invoice(READS("({ before }) => { return before === null }"), RESCHEDULE("        check &reads\n") + "    update :annotate\n      validate\n        check &reads\n");
    expect(codes(before)).toEqual(["8:22 MESH_VALIDATE_BEFORE"]);
  });

  test("R12 through an `always` block: a warning that demotes the check is reported once, as for the same check inline", () => {
    const always = (validate: string) => invoice(READS("() => &note").repeat(validate.includes("&reads") ? 1 : 0), `    always types=[:update]
      validate
${validate}    update :reschedule
    update :annotate
`);
    const inline = always('        check :reads that=() => &note code="r" message="m"\n');
    expect(codes(inline)).toEqual(["10:32 MESH_EXPR_PLAIN"]);
    // Covering two updates, one update, or none: the warning holds for every referrer, so it carries no prefix.
    const named = always("        check &reads\n");
    expect(codes(named)).toEqual(["8:28 MESH_EXPR_PLAIN"]);
    expect(said(named)[0]).toContain("8:28 MESH_EXPR_PLAIN this expression runs as plain TypeScript");
    expect(codes(named.replace("    update :annotate\n", ""))).toEqual(["8:28 MESH_EXPR_PLAIN"]);
    expect(codes(named.replace("types=[:update]", "types=[:destroy]"))).toEqual(["8:28 MESH_EXPR_PLAIN"]);
  });
});

describe("SYN-08: a check's name is a member of its entity, counted once", () => {
  const TWO = "declare the check once under `checks` and use it with `check &noteGiven` in each `validate`, or give each rule its own name";
  const inline = (name: string) => `        check :${name} that=() => true code="c" message="m"\n`;
  const entity = (actions: string, extra = "") => `import { Customer } from "./customer.mesh.mx"
import { Close } from "./close.mesh.mx"
entity :Invoice
  attributes
    uuid :id primary-key
    string :note nullable
  relationships
    belongs-to :customer entity=Customer
  computed
    boolean :noted() { return &note !== null }
${extra}  actions auto=[:read]
${actions}  policies
    policy :open
      authorize-if=() => true
`;
  const project = (source: string) => buildModel({ root: "/p", files: [
    { file: FILE, source },
    { file: "billing/customer.mesh.mx", source: "entity :Customer\n  attributes\n    uuid :id primary-key\n  actions auto=[:read]\n" },
    { file: "billing/close.mesh.mx", source: "command :Close\n  uuid :id\n" },
  ] });
  const duplicates = (source: string) => project(source).diagnostics.filter((d) => d.code !== "MESH_COMMAND_UNANSWERED").map((d) => [`${d.position.line}:${d.position.column}`, d.code, d.message, d.fix]);
  const update = (name: string, lines: string) => `    update :${name}\n      validate\n${lines}`;

  test("one inline name in two actions, or in an action and an `always` block, is a duplicate at the later line", () => {
    expect(duplicates(entity(update("a", inline("noteGiven")) + update("b", inline("noteGiven"))))).toEqual([
      ["17:8", "MESH_DUPLICATE_MEMBER", "Duplicate member :noteGiven", TWO],
    ]);
    expect(duplicates(entity(`    always types=[:update]\n      validate\n${inline("noteGiven")}` + update("a", inline("noteGiven"))))).toEqual([
      ["17:8", "MESH_DUPLICATE_MEMBER", "Duplicate member :noteGiven", TWO],
    ]);
  });

  test("a named check and an inline check of one name are a duplicate at the later line", () => {
    const named = `  checks\n    check :noteGiven that=() => true code="c" message="m"\n`;
    expect(duplicates(entity(update("a", "        check &noteGiven\n") + update("b", inline("noteGiven")), named))).toEqual([
      ["19:8", "MESH_DUPLICATE_MEMBER", "Duplicate member :noteGiven", TWO],
    ]);
  });

  test.each([
    ["an attribute", "note"],
    ["a relationship", "customer"],
    ["a computed field", "noted"],
    ["a declared action", "a"],
    ["an action `auto=` generates", "read"],
    ["a policy", "open"],
  ])("a check named like %s is a duplicate at the check, with the fix to rename it", (_name, name) => {
    expect(duplicates(entity(update("a", inline(name))))).toEqual([["14:8", "MESH_DUPLICATE_MEMBER", `Duplicate member :${name}`, "rename the check"]]);
  });

  test("a check named like an action that takes its name from a command gives the command's message, at the check", () => {
    expect(duplicates(entity(`    update on=Close\n      validate\n${inline("close")}`))).toEqual([
      ["14:8", "MESH_DUPLICATE_MEMBER", "Duplicate member :close: the update that answers Close takes its name from the command; write a name for it (`update :name on=Close`) or rename the other member", "rename the check"],
    ]);
  });

  test("a check named like a belongs-to's key column is reported at the check", () => {
    expect(duplicates(entity(update("a", inline("customerId"))))).toEqual([
      ["14:8", "MESH_DUPLICATE_MEMBER", "Generated key column customerId conflicts with a declared member", "rename the check"],
    ]);
  });

  test("a check named __proto__ is MESH_ATTRIBUTE_NAME", () => {
    expect(duplicates(entity(update("a", inline("__proto__")))).map(([, code]) => code)).toEqual(["MESH_ATTRIBUTE_NAME"]);
  });

  test("legal: one name in two entities, one code for two checks, one body under two names", () => {
    const customer = "entity :Customer\n  attributes\n    uuid :id primary-key\n  actions auto=[:read]\n    update :a\n      validate\n        check :note that=() => true code=\"c\" message=\"m\"\n";
    const result = buildModel({ root: "/p", files: [
      { file: FILE, source: entity(update("a", inline("note2")) + update("b", inline("other"))) },
      { file: "billing/customer.mesh.mx", source: customer },
      { file: "billing/close.mesh.mx", source: "command :Close\n  uuid :id\n" },
    ] });
    expect(result.diagnostics.filter((d) => d.code !== "MESH_COMMAND_UNANSWERED")).toEqual([]);
  });
});
