import type { Action, Check, Entity, Step } from "@meshfw/model";
import { alwaysFor, policiesFor, stepsFor } from "./views/actions.ts";
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
    } else if ((step.kind === "run" && step.after === "write") === after) out.push(step);
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
    else into.push(`${pad}run ${squash(step.fn.source)}`);
  }
}

const checkLine = (check: Check) => `${check.label} (${check.code})${check.when ? " when " + squash(check.when.source) : ""}${check.details ? ", with details" : ""}`;

/** Policies are declared but not run until M8; say so, never imply a check that does not happen. */
function policyLines(entity: Entity, action: Action): string[] {
  const names = policiesFor(entity, action);
  return names.length ? [`${names.join(", ")}: declared, not run in this version (M8)`] : [];
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
export function explainAction(entity: Entity, actionName: string): string[] | undefined {
  const action: Action | undefined = effectiveActions(entity).find((candidate) => candidate.name === actionName);
  if (!action) return undefined;
  const lines = [`${entity.name}.${action.name} (${action.kind})`];
  if (action.kind === "read") {
    section(lines, "strategy", ["one query: the caller's filter, sort, limit and offset over the table"]);
    section(lines, "policy", policyLines(entity, action));
    return lines;
  }
  const blocks = [...alwaysFor(entity, action).map((block) => ({ validate: block.validate, steps: block.do, always: true })), { validate: action.validate, steps: action.do, always: false }];
  const checks = blocks.flatMap((block) => block.validate.map((check) => (block.always ? `always: ${checkLine(check)}` : checkLine(check))));
  const all = stepsFor(action, blocks.flatMap((block) => block.steps));
  const steps: string[] = [];
  stepLines(stepsAt(all, false), 0, steps);
  const afterWrite: string[] = [];
  stepLines(stepsAt(all, true), 0, afterWrite, true);
  const reads = action.kind === "update" || checks.length > 0 || all.length > 0;
  const strategy = action.kind === "create" ? "one insert; nothing is read first"
    : action.kind === "update" ? "read-then-write: every update reads the row under the write lock, checks it, changes it, then writes it"
      : reads ? "read-then-write: the body can see the stored record, so the row is read under the lock before it is deleted"
        : "one delete by key; nothing in the body can see the record, so the row is not read";
  section(lines, "strategy", [strategy]);
  section(lines, "input", action.input.map((field) => (field.kind === "argument" ? `${field.name} (argument, not stored)` : `&${field.ref.name}`)));
  section(lines, "checks", checks);
  section(lines, "steps", steps);
  // Printed only when the action has one: the steps that run after the row is written, inside the transaction.
  if (afterWrite.length)
    section(lines, "after write", [action.kind === "destroy" ? "self is the deleted row as it was" : "self is the stored record", ...afterWrite]);
  section(lines, "policy", policyLines(entity, action));
  return lines;
}
