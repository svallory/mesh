import { describe, expect, test } from "bun:test";
import { isCheckGroup, type Check, type CheckGroup, type Entity } from "@meshfw/model";
import { buildModel } from "../src/front-end/build.ts";
import { actionExpressions, checksOf, isEmptyGroup, validateExpressions } from "../src/model/action-expressions.ts";
import { generateFiles } from "../src/typescript/emit.ts";
import { explainAction } from "../src/typescript/explain.ts";
import { actionsView } from "../src/typescript/views/actions.ts";
import { expressionIds } from "../src/typescript/views/expressions.ts";
import { configOf } from "./generated.ts";

// A `when=condition` line inside `validate` (ADR-0053): the checks under it run only when the condition holds. The model
// keeps the nesting as a tree (`CheckGroup`); these tests pin what reads the finished model.

const FILE = "billing/invoice.mesh.mx";
const build = (source: string) => buildModel({ root: "/p", files: [{ file: FILE, source }] });

/** An Invoice with a create, an update and a destroy, each `validate` written by the caller. */
const invoice = (validates: { issue?: string; send?: string; remove?: string; always?: string }) => `entity :Invoice
  attributes
    uuid :id primary-key
    integer :version default=0
    integer :amount
    string :note nullable
    enum :status values=[:draft, :sent] default=:draft
  actions auto=[:read]
${validates.always ?? ""}    create :issue
      input
        &amount
${validates.issue ? `      validate\n${validates.issue}` : ""}    update :send
      input
        integer :expectedVersion
${validates.send ? `      validate\n${validates.send}` : ""}    destroy :remove
${validates.remove ? `      validate\n${validates.remove}` : ""}`;

const SEND = `        check :versionIsCurrent that=({ input }) => input.expectedVersion === &version code="stale_update" message="stale"
        check :isDraft that=() => &status === :draft code="not_draft" message="only a draft can be sent"
        check :positive that=() => &amount > 0 code="amount" message="no amount"
        check :guard that=() => &version > 0 code="guard" message="unused, its function is the condition"
`;

const built = (source: string) => {
  const result = build(source);
  expect(result.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
  return result.document!;
};
const actionOf = (entity: Entity, name: string) => entity.actions.find((action) => action.name === name)!;
const statementsOf = (document: NonNullable<ReturnType<typeof built>>, name: string) =>
  actionsView({ document, config: configOf("/p") }, document.entities[0]!).methods.find((method) => method.name === name)!.statements;

/**
 * The `send` action rewritten by hand into `[when (guard) [versionIsCurrent, isDraft], positive]`: what the builder makes
 * of a `when` line, before the builder knows one. The guard check's function is the condition.
 */
const handGrouped = () => {
  const document = built(invoice({ send: SEND }));
  const send = actionOf(document.entities[0]!, "send");
  const [current, draft, positive, guard] = send.validate as Check[];
  const group: CheckGroup = { kind: "when", condition: guard!.that, lines: [current!, draft!], position: guard!.position };
  send.validate = [group, positive!];
  return { document, send, group };
};

describe("the model's helpers over a validate list", () => {
  test("a check is not a group, a group is; checksOf walks depth first", () => {
    const { send, group } = handGrouped();
    expect(send.validate.map(isCheckGroup)).toEqual([true, false]);
    expect(checksOf(send.validate).map((check) => check.label)).toEqual(["versionIsCurrent", "isDraft", "positive"]);
    expect(isEmptyGroup(group)).toBe(false);
    const empty: CheckGroup = { ...group, lines: [{ ...group, lines: [] }] };
    expect(isEmptyGroup(empty)).toBe(true);
    // An empty group's condition can never run, so nothing is loaded for it.
    expect(validateExpressions([empty])).toEqual([]);
    expect(validateExpressions(send.validate)[0]).toBe(group.condition);
  });

  test("actionExpressions lists a condition before the checks under it, with its own kind, empty groups included", () => {
    const { document, group } = handGrouped();
    const send = actionOf(document.entities[0]!, "send");
    send.validate = [{ ...group, lines: [] }, ...send.validate];
    const found = actionExpressions(document.entities[0]!).filter((e) => e.kind === "validate-when");
    expect(found.map((e) => e.what)).toEqual(["when in validate", "when in validate"]);
    const all = actionExpressions(document.entities[0]!).map((e) => e.expression);
    expect(all.indexOf(group.condition)).toBeLessThan(all.indexOf((group.lines[0] as Check).that));
  });

  test("a check carries no `kind` key, so model.json is unchanged for a project with no `when` line", () => {
    const document = built(invoice({ send: SEND }));
    for (const item of actionOf(document.entities[0]!, "send").validate) expect("kind" in item).toBe(false);
  });
});

describe("generated code for a hand-made group", () => {
  test("the condition has a positional id, and a check keeps its id under a group", () => {
    const { document, group } = handGrouped();
    const ids = expressionIds(document.entities[0]!);
    expect(ids.get(group.condition)).toBe("send.validate.0.when");
    expect(ids.get((group.lines[0] as Check).that)).toBe("send.check.versionIsCurrent.that");
  });

  test("a nested group's id carries the index path", () => {
    const { document, group, send } = handGrouped();
    const inner: CheckGroup = { ...group, condition: (send.validate[1] as Check).that, lines: [group.lines[1]!] };
    send.validate = [{ ...group, lines: [group.lines[0]!, inner] }];
    expect(expressionIds(document.entities[0]!).get(inner.condition)).toBe("send.validate.0.1.when");
  });

  test("one `if` around the guarded checks, called once with the check scope", () => {
    const { document } = handGrouped();
    const statements = statementsOf(document, "send");
    const start = statements.indexOf('if (await $expressions["send.validate.0.when"]($checks)) {');
    expect(start).toBeGreaterThan(-1);
    expect(statements.filter((line) => line.includes("send.validate.0.when"))).toHaveLength(1);
    expect(statements[start + 1]).toStartWith('await $runCheck($issues, $checks, { label: "versionIsCurrent"');
    expect(statements[start + 2]).toStartWith('await $runCheck($issues, $checks, { label: "isDraft"');
    expect(statements[start + 3]).toBe("}");
    expect(statements[start + 4]).toStartWith('await $runCheck($issues, $checks, { label: "positive"');
    expect(statements.slice(start + 1, start + 3).some((line) => line.includes("when:"))).toBe(false);
  });

  test("an empty group emits nothing, and a validate of empty groups only is no validate block", () => {
    const { document, group, send } = handGrouped();
    send.validate = [{ ...group, lines: [] }];
    const statements = statementsOf(document, "send");
    expect(statements.join("\n")).not.toContain("validate.0.when");
    expect(statements.join("\n")).not.toContain("$issues");
  });

  test("mesh explain prints the group once, its checks indented under it", () => {
    const { document } = handGrouped();
    const lines = explainAction(document.entities[0]!, "send")!;
    const start = lines.findIndex((line) => line.startsWith("  checks"));
    expect(lines.slice(start, start + 4)).toEqual([
      "  checks       when () => &version > 0",
      "                 versionIsCurrent (stale_update)",
      "                 isDraft (not_draft)",
      "               positive (amount)",
    ]);
  });
});

/** Each diagnostic as `line:column CODE`, or with its message. */
const codes = (source: string) => build(source).diagnostics.map((d) => `${d.position.line}:${d.position.column} ${d.code}`);
const said = (source: string) => build(source).diagnostics.map((d) => `${d.position.line}:${d.position.column} ${d.code} ${d.message}`);
const ok = (name: string) => `check :${name} that=() => true code="${name}" message="${name}"`;
/** An update `send` whose `validate` and `do` are the given lines (each indented as under the section). */
const sendWith = (validate: string, doLines = "") => `entity :Invoice
  attributes
    uuid :id primary-key
    integer :version default=0
  actions auto=[:read]
    update :send
      validate
${validate}${doLines ? `      do\n${doLines}` : ""}`;

describe("a `when` line in `validate`: what builds", () => {
  test.each([
    ["a group with two checks", sendWith(`        when=() => &version > 0\n          ${ok("a")}\n          ${ok("b")}\n        ${ok("c")}\n`)],
    ["a group inside a group", sendWith(`        when=() => &version > 0\n          when=() => &version > 1\n            ${ok("a")}\n          ${ok("b")}\n`)],
    ["an empty group", sendWith(`        when=() => &version > 0\n        ${ok("a")}\n`)],
    ["a check with its own `when=` under a group", sendWith(`        when=() => &version > 0\n          check :a that=() => true when=() => &version > 1 code="a" message="a"\n`)],
    ["a group in an `always` block", `entity :Invoice
  attributes
    uuid :id primary-key
    integer :version default=0
  actions auto=[:read]
    always types=[:update]
      validate
        when=() => &version > 0
          ${ok("a")}
    update :send
`],
    ["a group in a destroy", `entity :Invoice
  attributes
    uuid :id primary-key
    integer :version default=0
  actions auto=[:read]
    destroy :remove
      validate
        when=() => &version > 0
          ${ok("a")}
`],
    ["a destroy whose only line is an empty group", `entity :Invoice
  attributes
    uuid :id primary-key
    integer :version default=0
  actions auto=[:read]
    destroy :remove
      validate
        when=() => &version > 0
`],
    // The legal neighbours: a step `when` takes every step kind (`set`, `when`, `load`, `run`, `publish`), nested.
    ["a step `when` holding every step kind", `import { Paid } from "./paid.mesh.mx"
entity :Invoice
  attributes
    uuid :id primary-key
    integer :version default=0
  computed
    boolean :fresh() { return self.version === 0 }
  actions auto=[:read]
    update :send
      validate
        ${ok("a")}
        check :b that=() => true when=() => &version > 1 code="b" message="b"
      do
        when=() => &version > 0
          set
            &version=1
          when=() => true
            load=[&fresh]
            run=() => null
          load=[&fresh]
          run=() => null
          publish=() => new Paid({})
`],
  ])("%s builds with no diagnostic", (_name, source) => {
    const result = buildModel({ root: "/p", files: [{ file: FILE, source }, { file: "billing/paid.mesh.mx", source: "event :paid\n" }] });
    expect(result.diagnostics.map((d) => `${d.position.line}:${d.position.column} ${d.code} ${d.message}`)).toEqual([]);
  });

  test("the model keeps the nesting, with the `when` lines' positions", () => {
    const document = built(sendWith(`        when=() => &version > 0\n          ${ok("a")}\n          when=() => &version > 1\n            ${ok("b")}\n        ${ok("c")}\n`));
    const [group, c] = actionOf(document.entities[0]!, "send").validate;
    expect(isCheckGroup(group!)).toBe(true);
    expect(group).toMatchObject({ kind: "when", condition: { source: "() => &version > 0" }, position: { line: 8 } });
    const [a, inner] = (group as CheckGroup).lines;
    expect(a).toMatchObject({ label: "a" });
    expect(inner).toMatchObject({ kind: "when", condition: { source: "() => &version > 1" }, position: { line: 10 }, lines: [{ label: "b" }] });
    expect(c).toMatchObject({ label: "c" });
  });
});

describe("a `when` line in `validate`: what is refused", () => {
  test.each(["set\n            &version=1", "load=[&version]", "run=() => null"])("a step under a group: %s", (line) => {
    const source = sendWith(`        when=() => &version > 0\n          ${line}\n`);
    const name = line.split(/[\s=[]/)[0]!;
    expect(said(source)).toEqual([`9:10 MESH_TAG_NOT_ALLOWED \`when\` in \`validate\`: \`${name}\` is not allowed here; allowed children: \`check\`, \`when\``]);
  });

  test("a `check` under a step `when`, one and two levels deep", () => {
    const source = sendWith(`        ${ok("a")}\n`, `        when=() => &version > 0\n          ${ok("bad")}\n          when=() => true\n            ${ok("deeper")}\n`);
    const message = "`when` in `do`: `check` is not allowed here; allowed children: `set`, `when`, `load`, `run`, `publish`";
    expect(said(source)).toEqual([`11:10 MESH_TAG_NOT_ALLOWED ${message}`, `13:12 MESH_TAG_NOT_ALLOWED ${message}`]);
  });

  test("a `publish` under a group, a nested group, and a check in a group", () => {
    const source = sendWith(`        when=() => &version > 0\n          publish=() => null\n          when=() => true\n            publish=() => null\n          ${ok("a")}\n            publish=() => null\n`);
    expect(said(source)).toEqual([
      "9:10 MESH_PUBLISH a `publish` step is not allowed in `validate`: it raises an event after the action's row is written, in the action's `do`",
      "11:12 MESH_PUBLISH a `publish` step is not allowed in `validate`: it raises an event after the action's row is written, in the action's `do`",
      "13:12 MESH_PUBLISH a `publish` step is not allowed in a `check`: it raises an event after the action's row is written, in the action's `do`",
    ]);
  });

  test.each([
    ["no condition", "when", "8:8 MESH_MISSING_OPTION"],
    ["an identifier", "when=foo", "8:12 MESH_EXPRESSION"],
    ["a call", "when=foo()", "8:12 MESH_EXPRESSION"],
    ["a literal", "when=true", "8:12 MESH_OPTION_VALUE"],
  ])("a group with %s", (_name, line, expected) => {
    expect(codes(sendWith(`        ${line}\n          ${ok("a")}\n`))).toEqual([expected]);
  });

  test("one file reports every misplaced line, in written order, with its other builder errors", () => {
    const source = sendWith(`        when=() => &version > 0
          set
            &version=1
          run=() => null
          ${ok("ok")}
          publish=() => null
          ${ok("inner")}
            publish=() => null
        ${ok("ok")}
`, `        when=() => &version > 0
          ${ok("bad")}
          when=() => true
            ${ok("deeper")}
`);
    expect(codes(source)).toEqual([
      "9:10 MESH_TAG_NOT_ALLOWED",
      "11:10 MESH_TAG_NOT_ALLOWED",
      "13:10 MESH_PUBLISH",
      "15:12 MESH_PUBLISH",
      "16:8 MESH_DUPLICATE_MEMBER",
      "19:10 MESH_TAG_NOT_ALLOWED",
      "21:12 MESH_TAG_NOT_ALLOWED",
    ]);
  });

  test("regression: `check` under `do` and `set` under `validate` stay MX's errors", () => {
    const source = sendWith(`        set\n          &version=1\n`, `        ${ok("a")}\n`);
    expect(codes(source)).toEqual(["8:8 MESH_TAG_NOT_ALLOWED", "11:8 MESH_TAG_NOT_ALLOWED"]);
  });

  test("one name under two groups, or under a group and at the top, is a duplicate member at the later line", () => {
    const source = sendWith(`        when=() => &version > 0\n          ${ok("a")}\n        when=() => &version > 1\n          ${ok("a")}\n        ${ok("a")}\n`);
    expect(codes(source).filter((line) => line.endsWith("MESH_DUPLICATE_MEMBER"))).toEqual(["11:10 MESH_DUPLICATE_MEMBER", "12:8 MESH_DUPLICATE_MEMBER"]);
  });
});

/** Every diagnostic of a two-file project: a User, and an Invoice that belongs to one. */
const USER = `entity :User
  attributes
    uuid :id primary-key
    string :name
  computed
    boolean :named() { return self.name.length > 0 }
  actions auto=[:read]
`;
const owned = (actions: string, extra = "") => `import { User } from "./user.mesh.mx"

entity :Invoice
  attributes
    uuid :id primary-key
    integer :version default=0
    integer :amount
    integer :total
    string :note nullable
  relationships
    belongs-to :owner entity=User
${extra}  actions auto=[:read]
${actions}`;
const project = (source: string) => buildModel({ root: "/p", files: [{ file: "billing/user.mesh.mx", source: USER }, { file: FILE, source }] });
const invoiceOf = (source: string) => project(source).document!.entities.find((entity) => entity.name === "Invoice")!;
const errorsOf = (source: string) => project(source).diagnostics.filter((d) => d.severity === "error");

describe("a `when` line's condition in the model pass", () => {
  const update = (condition: string) => owned(`    update :send
      validate
        when=${condition}
          ${ok("a")}
`);

  test.each([
    ["destructured in a translated function", "({ before }) => before.version > 0"],
    ["destructured in a plain block body", "({ before }) => { return before.version > 0 }"],
    ["reached through a rest parameter", "({ input, ...rest }) => { return rest.before.version > 0 }"],
    ["destructured and unused", "({ before }) => true"],
  ])("`before` %s is MESH_VALIDATE_BEFORE, once", (_name, condition) => {
    const found = project(update(condition)).diagnostics.filter((d) => d.code === "MESH_VALIDATE_BEFORE");
    expect(found).toHaveLength(1);
    expect(found[0]!.severity).toBe("error");
  });

  test("the plain-code `before` scan names the construct", () => {
    const [found] = project(update("({ before }) => { return before.version > 0 }")).diagnostics.filter((d) => d.code === "MESH_VALIDATE_BEFORE");
    expect(found!.message).toStartWith("when in validate reads `before`");
  });

  test("`before` read only in a type is refused when the file is emitted", async () => {
    const result = project(update("() => { const b: typeof before = null; return b === null }"));
    expect(result.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    const failure = await generateFiles({ document: result.document!, config: configOf("/p") }).then(() => undefined, (error: unknown) => error);
    expect(failure).toMatchObject({ name: "EmitError", diagnostic: { code: "MESH_VALIDATE_BEFORE", message: expect.stringContaining("when in validate reads `before` in a type") } });
  });

  test("a `before` in a step `when` is still fine", () => {
    expect(errorsOf(owned(`    update :send
      do
        when=({ before }) => before.version > 0
          set
            &version=1
`))).toEqual([]);
  });

  const create = (condition: string) => owned(`    create :issue
      input
        &amount
        &owner
      validate
        when=${condition}
          check :a that=() => true code="a" message="a"
          check :b that=() => true code="b" message="b"
          check :c that=() => true code="c" message="c"
      do
        set
          &total=1
`);
  const warnings = (source: string, code: string) => project(source).diagnostics.filter((d) => d.code === code);

  test("on a create, a condition reading a member input is MESH_VALIDATE_NOT_APPLIED once", () => {
    expect(warnings(create("() => &amount > 0"), "MESH_VALIDATE_NOT_APPLIED")).toHaveLength(1);
  });

  test("on a create, an unfilled required member is MESH_VALIDATE_UNFILLED once, saying the checks under it are skipped", () => {
    const found = warnings(create("() => &total > 0"), "MESH_VALIDATE_UNFILLED");
    expect(found).toHaveLength(1);
    expect(found[0]!.message).toEndWith("the checks under this `when` are skipped");
  });

  test("a negated unknown in a condition says the checks under it are skipped; a check's own `when=` keeps its ending", () => {
    const group = warnings(owned(`    update :send
      validate
        when=() => &note !== "x"
          ${ok("a")}
`), "MESH_EXPR_NEGATED_UNKNOWN");
    expect(group).toHaveLength(1);
    expect(group[0]!.message).toContain("the checks under this `when` are skipped");
    const own = warnings(create("() => true").replace('check :a that=() => true code="a"', "check :a that=() => true when=() => &total > 0 code=\"a\""), "MESH_VALIDATE_UNFILLED");
    expect(own[0]!.message).toEndWith("the check is skipped");
  });

  test("a condition's needs: a relationship, and a computed field through it", () => {
    const entity = invoiceOf(owned(`    update :send
      validate
        when=() => &owner.name !== ""
          ${ok("a")}
        when=() => &owner.named
          ${ok("b")}
`));
    const [first, second] = actionOf(entity, "send").validate as CheckGroup[];
    expect(first!.condition.needs).toEqual(["owner"]);
    expect(second!.condition.needs).toEqual(expect.arrayContaining(["owner"]));
  });

  test("a condition's needs: a rollup", () => {
    const line = `import { Invoice } from "./invoice.mesh.mx"
entity :Line
  attributes
    uuid :id primary-key
  relationships
    belongs-to :invoice entity=Invoice
  actions auto=[:read]
`;
    const result = buildModel({ root: "/p", files: [{ file: "billing/line.mesh.mx", source: line }, { file: FILE, source: `import { Line } from "./line.mesh.mx"
entity :Invoice
  attributes
    uuid :id primary-key
  relationships
    has-many :lines entity=Line
  computed
    count :lineCount of=&lines
  actions auto=[:read]
    update :send
      validate
        when=() => &lineCount > 0
          ${ok("a")}
` }] });
    expect(result.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    const [group] = actionOf(result.document!.entities.find((e) => e.name === "Invoice")!, "send").validate as CheckGroup[];
    expect(group!.condition.needs).toEqual(["lineCount"]);
  });

  test("in an `always` block over a create and an update, a condition and a check under it are typed", () => {
    const found = project(owned(`    always types=[:create, :update]
      validate
        when=() => &total > 0
          check :a that=() => &note !== "y" code="a" message="a"
    create :issue
      input
        &amount
        &owner
      do
        set
          &total=1
    update :send
`)).diagnostics.map((d) => `${d.position.line} ${d.code}`);
    // Line 15 is the `when` line, line 16 the check under it.
    expect(found).toEqual(["15 MESH_VALIDATE_UNFILLED", "16 MESH_EXPR_NEGATED_UNKNOWN"]);
  });
});

describe("generated code from entity text", () => {
  const generate = async (source: string) => {
    const result = project(source);
    expect(result.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    return await generateFiles({ document: result.document!, config: configOf("/p") });
  };
  const fileOf = (files: { path: string; contents: string }[], end: string) => files.find((file) => file.path.endsWith(end))!.contents;
  const statementsIn = (source: string, name: string) => {
    const result = project(source);
    expect(result.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    const entity = result.document!.entities.find((e) => e.name === "Invoice")!;
    return actionsView({ document: result.document!, config: configOf("/p") }, entity).methods.find((method) => method.name === name)!.statements;
  };
  const SEND_GROUPED = `    update :send
      input
        integer :expectedVersion
      validate
        when=() => &version > 0
          check :versionIsCurrent that=({ input }) => input.expectedVersion === &version code="stale_update" message="stale"
          when=() => &amount > 10
            check :isBig that=() => &amount > 100 code="big" message="big"
          check :own that=() => true when=() => &note !== null code="own" message="own"
        check :positive that=() => &amount > 0 code="amount" message="no amount"
`;

  test("ids, nesting and the check scope: one `if` per group, a check's own `when:` kept", () => {
    const statements = statementsIn(owned(SEND_GROUPED), "send");
    const at = (prefix: string) => statements.findIndex((line) => line.startsWith(prefix));
    const outer = at('if (await $expressions["send.validate.0.when"]($checks)) {');
    const inner = at('if (await $expressions["send.validate.0.1.when"]($checks)) {');
    expect(outer).toBeGreaterThan(-1);
    expect(inner).toBe(outer + 2);
    expect(statements.slice(outer, outer + 8).map((line) => line.replace(/^(await \$runCheck\(\$issues, \$checks, \{ label: "\w+").*?(, when: [^}]*)?\}\);$/, "$1$2"))).toEqual([
      'if (await $expressions["send.validate.0.when"]($checks)) {',
      'await $runCheck($issues, $checks, { label: "versionIsCurrent"',
      'if (await $expressions["send.validate.0.1.when"]($checks)) {',
      'await $runCheck($issues, $checks, { label: "isBig"',
      "}",
      'await $runCheck($issues, $checks, { label: "own", when: $expressions["send.check.own.when"] ',
      "}",
      'await $runCheck($issues, $checks, { label: "positive"',
    ]);
  });

  test("the condition is typed with the check scope on an update, the new instance on a create", async () => {
    const files = await generate(owned(`${SEND_GROUPED}    create :issue
      input
        &amount
        &owner
      validate
        when=() => &version > 0
          ${ok("c")}
      do
        set
          &total=1
`));
    const expressions = fileOf(files, "invoice.expressions.ts");
    expect(expressions).toMatch(/"send\.validate\.0\.when": \(\s*\$s: \$billing\$Invoice\$CheckScope</);
    expect(expressions).toMatch(/"issue\.validate\.0\.when": \(\s*\$s: \$billing\$Invoice\$NewScope</);
    expect(expressions).toContain("when in validate");
  });

  test("two `always` blocks each with a group: ids per block, the first block's `if` first", () => {
    const statements = statementsIn(owned(`    always types=[:update]
      validate
        when=() => &version > 0
          ${ok("a")}
    always types=[:update]
      validate
        when=() => &version > 1
          ${ok("b")}
    update :send
`), "send");
    const first = statements.findIndex((line) => line.includes('"always.0.validate.0.when"'));
    const second = statements.findIndex((line) => line.includes('"always.1.validate.0.when"'));
    expect(first).toBeGreaterThan(-1);
    expect(second).toBeGreaterThan(first);
  });

  test("a condition that reads a relationship is loaded in the one load before the first check", () => {
    const statements = statementsIn(owned(`    update :send
      validate
        when=() => &owner.name !== ""
          ${ok("a")}
`), "send");
    const load = statements.findIndex((line) => line.startsWith("await $loadInto(") && line.includes('["owner"]'));
    const condition = statements.findIndex((line) => line.includes("send.validate.0.when"));
    expect(load).toBeGreaterThan(-1);
    expect(load).toBeLessThan(condition);
    expect(statements.filter((line) => line.startsWith("await $loadInto("))).toHaveLength(1);
  });

  test("an empty group: no line, no load and no unload for what its condition reads, no load plan", async () => {
    const source = owned(`    update :send
      input
        &amount
      validate
        when=() => &owner.name !== ""
`);
    const statements = statementsIn(source, "send").join("\n");
    expect(statements).not.toContain("validate.0.when");
    expect(statements).not.toContain("$issues");
    expect(statements).not.toContain("$loadInto");
    expect(statements).not.toContain("$unloadFrom");
    const actions = fileOf(await generate(source), "invoice.actions.ts");
    // The update's body loads nothing and the condition is never called: it is printed only in the expressions file.
    expect(actions).not.toContain("validate.0.when");
    const expressions = fileOf(await generate(source), "invoice.expressions.ts");
    expect(expressions).toContain('"send.validate.0.when"');
  });

  test("a destroy with a group reads the row; one whose only line is an empty group is one delete", () => {
    const grouped = statementsIn(owned(`    destroy :remove
      validate
        when=() => &version > 0
          ${ok("a")}
`), "remove").join("\n");
    expect(grouped).toContain("selectByKeyForUpdate");
    const document = project(owned(`    destroy :remove
      validate
        when=() => &version > 0
          ${ok("a")}
`)).document!;
    expect(explainAction(document.entities.find((e) => e.name === "Invoice")!, "remove")!.join("\n")).toContain("read-then-write");
    const empty = owned(`    destroy :remove
      validate
        when=() => &version > 0
`);
    const statements = statementsIn(empty, "remove").join("\n");
    expect(statements).toContain("nothing in the body can see the record, so the row is deleted without being read");
    expect(statements).not.toContain("validate.0.when");
    expect(explainAction(invoiceOf(empty), "remove")!.join("\n")).toContain("one delete by key");
  });

  test("mesh explain: nesting two levels deep, `always: ` on every line of a block, nothing for an empty group", () => {
    const entity = invoiceOf(owned(`    always types=[:update]
      validate
        when=() => &version > 0
          ${ok("a")}
        when=() => &version > 5
    update :send
      validate
        when=() => &version > 1
          when=() => &version > 2
            ${ok("b")}
`));
    const lines = explainAction(entity, "send")!;
    const start = lines.findIndex((line) => line.startsWith("  checks"));
    expect(lines.slice(start, start + 5)).toEqual([
      "  checks       always: when () => &version > 0",
      "               always:   a (a)",
      "               when () => &version > 1",
      "                 when () => &version > 2",
      "                   b (b)",
    ]);
    expect(lines[start + 5]).not.toContain("&version > 5");
  });
});

describe("`check &name` under a `when` line", () => {
  const CHECKS = `  checks
    check :positive that=() => &amount > 0 code="amount" message="no amount"
`;
  test("a reference under a group builds and is guarded like an inline check", () => {
    const source = owned(`    update :send
      validate
        when=() => &version > 0
          check &positive
`, CHECKS);
    expect(errorsOf(source)).toEqual([]);
    const statements = (() => {
      const result = project(source);
      return actionsView({ document: result.document!, config: configOf("/p") }, invoiceOf(source)).methods.find((m) => m.name === "send")!.statements;
    })();
    const at = statements.findIndex((line) => line.includes("send.validate.0.when"));
    expect(statements[at + 1]).toContain('label: "positive"');
    expect(statements[at + 2]).toBe("}");
  });

  test("the same reference under two groups of one `validate` is a duplicate, wherever the two sit (D27 point 5)", () => {
    const twice = owned(`    update :send
      validate
        when=() => &version > 0
          check &positive
        when=() => &version < 0
          check &positive
`, CHECKS);
    expect(errorsOf(twice).map((d) => `${d.position.line} ${d.code}`)).toEqual(["20 MESH_DUPLICATE_MEMBER"]);
    const topAndGroup = owned(`    update :send
      validate
        check &positive
        when=() => &version < 0
          check &positive
`, CHECKS);
    expect(errorsOf(topAndGroup).map((d) => `${d.position.line} ${d.code}`)).toEqual(["19 MESH_DUPLICATE_MEMBER"]);
  });

  test("a reference under a group in an `always` block and again in the action it covers is a duplicate", () => {
    const source = owned(`    always types=[:update]
      validate
        when=() => &version > 0
          check &positive
    update :send
      validate
        check &positive
`, CHECKS);
    expect(errorsOf(source).map((d) => d.code)).toEqual(["MESH_DUPLICATE_MEMBER"]);
  });

  test("a reference at the top of an `always` block and again under a group in the action it covers is a duplicate at the action's line", () => {
    const source = owned(`    always types=[:update]
      validate
        check &positive
    update :send
      validate
        when=() => &version > 0
          check &positive
`, CHECKS);
    expect(errorsOf(source).map((d) => `${d.position.line} ${d.code}`)).toEqual(["21 MESH_DUPLICATE_MEMBER"]);
  });

  test("a reference under a group in an `always` block is typed for each action the block covers", () => {
    const source = owned(`    always types=[:update]
      validate
        when=() => &version > 0
          check &needsX
    update :other
`, `  checks
    check :needsX that=({ input }) => input.x > 0 code="x" message="x"
`);
    expect(errorsOf(source).map((d) => [d.code, d.message.split(",")[0]])).toEqual([["MESH_CHECK_INPUT", "`input.x` is read by a check that update :other uses through the `always` block at line 15"]]);
  });

  test("a reference under a step `when` is refused, and its check is not also reported unused", () => {
    const source = owned(`    update :send
      validate
        check :local that=() => true code="l" message="l"
      do
        when=() => &version > 0
          check &positive
`, CHECKS);
    expect(project(source).diagnostics.map((d) => `${d.position.line} ${d.code}`)).toEqual(["20 MESH_TAG_NOT_ALLOWED"]);
  });

  test("a reference with an option is still refused under a group", () => {
    const source = owned(`    update :send
      validate
        when=() => &version > 0
          check &positive when=() => true
`, CHECKS);
    expect(errorsOf(source).map((d) => d.code)).toEqual(["MESH_UNKNOWN_OPTION"]);
  });
});
