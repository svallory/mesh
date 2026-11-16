import { describe, expect, test } from "bun:test";
import { isCheckGroup, type Check, type CheckGroup, type Entity } from "@meshfw/model";
import { buildModel } from "../src/front-end/build.ts";
import { actionExpressions, checksOf, isEmptyGroup, validateExpressions } from "../src/model/action-expressions.ts";
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
