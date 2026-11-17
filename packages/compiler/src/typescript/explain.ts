import { isCheckGroup, type Action, type Check, type Entity, type ModelDocument, type Step, type ValidateItem } from "@meshfw/model";
import { sqlPositions } from "../model/sql-required.ts";
import { checksOf, isEmptyGroup } from "../model/action-expressions.ts";
import { policiesCovering, policyExpressions, readsRecord } from "../model/policies.ts";
import { alwaysFor, stepsFor } from "./views/actions.ts";
import { effectiveActions } from "./views/inputs.ts";

const squash = (text: string) => text.replace(/\s+/g, " ").trim();

/**
 * The steps that run at one point of the action: before its row is written (`after` false), or after it (`after` true,
 * only the `run [after=:write]` steps). A `when` appears in both when it holds steps of both; its condition is evaluated
 * once, before the write.
 */
function stepsAt(steps: readonly Step[], after: boolean): Step[] {
  const out: Step[] = [];
  for (const step of steps) {
    if (step.kind === "when") {
      const inner = stepsAt(step.steps, after);
      if (inner.length) out.push({ ...step, steps: inner });
    } else if (((step.kind === "run" && step.after === "write") || step.kind === "publish") === after) out.push(step);
  }
  return out;
}

function stepLines(steps: readonly Step[], depth: number, into: string[], after = false): void {
  const pad = "  ".repeat(depth);
  for (const step of steps) {
    if (step.kind === "set")
      for (const { member, value } of step.assignments)
        into.push(`${pad}set &${member.name} = ${typeof value === "object" && value !== null && "source" in value ? squash((value as { source: string }).source) : JSON.stringify(typeof value === "object" && value !== null && !Array.isArray(value) && "value" in value ? (value as { value: unknown }).value : value)}`);
    else if (step.kind === "when") {
      into.push(`${pad}when ${squash(step.condition.source)}${after ? " (as it held before the write)" : ""}`);
      stepLines(step.steps, depth + 1, into, after);
    } else if (step.kind === "load") into.push(`${pad}load ${step.members.map((member) => `&${member.name}`).join(", ")}`);
    else if (step.kind === "publish") into.push(`${pad}publish ${squash(step.fn.source)} (plain, ${step.fn.plain?.why ?? "publish-step"}: it raises the event after the write)`);
    else into.push(`${pad}run ${squash(step.fn.source)}`);
  }
}

const checkLine = (check: Check) => `${check.label} (${check.code})${check.when ? " when " + squash(check.when.source) : ""}${check.details ? ", with details" : ""}${typeof check.message === "string" ? "" : ", with a message function"}`;
/** The lines of a `validate` list: a check per line, a `when` line once with its lines indented under it, nothing for an empty one. */
function checkLines(items: readonly ValidateItem[], depth: number, into: string[], prefix: string): void {
  const pad = "  ".repeat(depth);
  for (const item of items) {
    if (!isCheckGroup(item)) { into.push(`${prefix}${pad}${checkLine(item)}`); continue; }
    if (isEmptyGroup(item)) continue;
    into.push(`${prefix}${pad}when ${squash(item.condition.source)}`);
    checkLines(item.lines, depth + 1, into, prefix);
  }
}

/**
 * Each policy that covers the action, with each of its functions and where it runs (lead ruling 1 of M8a): a
 * function that reads only `actor`, `context` and `input` runs once before the transaction opens; one that reads the
 * record runs inside it, before validate. A read's policies are a filter. With none, every call is forbidden.
 */
function policyLines(entity: Entity, action: Action): string[] {
  const covering = policiesCovering(entity, action);
  if (covering.length === 0) return ["none covers it: every call is forbidden (an action no policy covers is denied)"];
  const record = action.kind === "read" ? "reads the record: a read policy that does so is refused until M10"
    : action.kind === "create" ? "inside the transaction, on the new instance before the input, before validate"
      : "inside the transaction, on the locked row, before validate";
  const early = action.kind === "read" ? "before the query, once: a caller it does not admit gets no rows" : "before the transaction, once";
  const lines: string[] = [];
  for (const policy of covering) {
    lines.push(`:${policy.name}`);
    for (const { kind, expression } of policyExpressions(policy))
      lines.push(`  ${kind} ${squash(expression.source)}: ${readsRecord(expression, action.kind === "read" ? "read" : "write") ? record : early}`);
  }
  lines.push("every policy above must pass; in one, any forbid-if that holds or is unknown forbids, and of its authorize-ifs one must hold");
  if (covering.some((policy) => policy.when))
    lines.push(`a policy whose when is false does not apply; with none applying, ${action.kind === "read" ? "the caller gets no rows" : "the call is forbidden"}`);
  if (action.kind === "read" && entity.relationships.length)
    lines.push(`what the caller loads runs the read policies of the entity it reaches${entity.relationships.some((relation) => relation.through) ? ", and of the link entity of a `through=`" : ""}: a record it may not read is null, a list of them empty, and a rollup counts none`);
  return lines;
}

function section(into: string[], name: string, lines: readonly string[]): void {
  if (lines.length === 0) { into.push(`  ${name.padEnd(12)} none`); return; }
  into.push(`  ${name.padEnd(12)} ${lines[0]}`);
  for (const line of lines.slice(1)) into.push(`  ${" ".repeat(12)} ${line}`);
}

/**
 * The plan the generated handler of one action follows, as lines of text (`mesh explain <entity> <action>`).
 * Language neutral and plain: the phases are the ones the handler is written in, and every update is a read followed
 * by a write (ADR-0072: the atomic one-statement update waits until after 1.0). Returns `undefined` for an unknown action.
 */
export function explainAction(entity: Entity, actionName: string, document?: ModelDocument): string[] | undefined {
  const action: Action | undefined = effectiveActions(entity).find((candidate) => candidate.name === actionName);
  if (!action) return undefined;
  const lines = [`${entity.fqn}#${action.name} (${action.kind})`];
  if (action.kind === "read") {
    if (!action.filter && !action.sort) section(lines, "strategy", ["one query: the caller's filter, sort, limit and offset over the table"]);
    else {
      // The read's own filter and sort run as SQL in the same query (M10); with the model, the relationships the
      // conditions cross are named, since each is a subquery per row.
      const strategy = [`one query: ${action.filter ? "the read's filter and the caller's" : "the caller's filter"}, the caller's sort${action.sort ? " then the read's" : ""}, limit and offset over the table`];
      if (action.filter) strategy.push(`filter ${squash(action.filter.source)}: runs as SQL, with the caller's filter and the policies`);
      for (const key of action.sort ?? []) strategy.push(`sort ${key.direction} &${key.member.name}: runs as SQL, after the caller's sort keys; rows that tie on every key come in primary-key order`);
      const crossed = new Set<string>();
      for (const place of document ? sqlPositions(document, entity).filter((p) => p.action === action) : []) {
        const lowered = place.lower();
        if (lowered.ok) for (const crossing of lowered.lowered.crossings) crossed.add(crossing.path);
      }
      for (const path of crossed) strategy.push(`a subquery per row through ${path}`);
      section(lines, "strategy", strategy);
    }
    section(lines, "policies", policyLines(entity, action));
    section(lines, "seams", ["none: a read runs no seam"]);
    return lines;
  }
  const blocks = [...alwaysFor(entity, action).map((block) => ({ validate: block.validate, steps: block.do, always: true })), { validate: action.validate, steps: action.do, always: false }];
  const checks: string[] = [];
  for (const block of blocks) checkLines(block.validate, 0, checks, block.always ? "always: " : "");
  const all = stepsFor(action, blocks.flatMap((block) => block.steps));
  const steps: string[] = [];
  stepLines(stepsAt(all, false), 0, steps);
  const afterWrite: string[] = [];
  stepLines(stepsAt(all, true), 0, afterWrite, true);
  const recordPolicy = policiesCovering(entity, action).some((policy) => policyExpressions(policy).some(({ expression }) => readsRecord(expression, action.kind === "read" ? "read" : "write")));
  const reads = action.kind === "update" || checksOf(blocks.flatMap((block) => block.validate)).length > 0 || all.length > 0 || recordPolicy;
  const strategy = action.kind === "create" ? "one insert; nothing is read first"
    : action.kind === "update" ? "read-then-write: every update reads the row under the write lock, checks it, changes it, then writes it"
      : reads ? "read-then-write: the body can see the stored record, so the row is read under the lock before it is deleted"
        : "one delete by key; nothing in the body can see the record, so the row is not read (with an afterWrite or afterCommit seam registered it is read under the lock first, so the seam gets `before`)";
  // Printed only when the action has an `on=`: the command it answers, by its FQN, with the identifier the file writes.
  if (action.command) section(lines, "answers", [`command ${action.command.fqn} (on=${action.command.identifier}): \`dispatch\` of an instance runs this action with the command's fields as its input`]);
  section(lines, "strategy", [strategy]);
  section(lines, "input", action.input.map((field) => (field.kind === "argument" ? `${field.name} (argument, not stored)` : `&${field.ref.name}`)));
  section(lines, "policies", policyLines(entity, action));
  section(lines, "checks", checks);
  section(lines, "steps", steps);
  // Printed only when the action has one: the steps that run after the row is written, inside the transaction.
  if (afterWrite.length)
    section(lines, "after write", [action.kind === "destroy" ? "self is the deleted row as it was" : "self is the stored record", ...afterWrite]);
  section(lines, "seams", [
    "beforeTransaction: before the transaction opens, for a top-level call only (a call from an action's own code or inside `transaction` joins one and runs none)",
    "afterWrite: inside the transaction, right after the row is written, before the steps after the write",
    "afterCommit: once, after the outermost transaction commits, with every change it made",
  ]);
  return lines;
}
