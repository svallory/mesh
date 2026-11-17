import type { Action, Entity, ModelDocument, Policy } from "@meshfw/model";
import { checksOf } from "../model/action-expressions.ts";
import { policiesCovering, policyExpressions, readsRecord, type PolicyExpression } from "../model/policies.ts";
import { lowerCondition, type NotSql } from "../model/sql-condition.ts";
import { alwaysFor, stepsFor } from "./views/actions.ts";

/** How a destroy writes: one delete by key, a read under the lock first, or one delete that checks the policies itself. */
export type DestroyStrategy = "delete" | "read" | "guarded";

/** One record-reading policy check a guarded destroy's statement evaluates, with the policy that holds it. */
export interface GuardedCheck extends PolicyExpression {
  readonly policy: Policy;
}

export interface DestroyPlan {
  readonly strategy: DestroyStrategy;
  /** The `mesh explain` strategy line. */
  readonly reason: string;
  /** For `guarded`: every check of a covering policy that reads the record, in declaration order. */
  readonly guarded: readonly GuardedCheck[];
}

const READ = "read-then-write: the body can see the stored record, so the row is read under the lock before it is deleted";
const DELETE = "one delete by key; nothing in the body can see the record, so the row is not read (with an afterWrite or afterCommit seam registered it is read under the lock first, so the seam gets `before`)";

/** Why a check has no SQL form, as the strategy line says it. */
function why(problem: NotSql): string {
  switch (problem.kind) {
    case "plain": return `Mesh does not translate it (${problem.detail})`;
    case "plain-computed": return `it reads computed ${problem.field}, which Mesh runs in memory`;
    case "foreign-list": return `its \`${problem.op}\` goes over a list that is not a relationship of the record`;
    case "self-reaching": return `computed :${problem.field} reaches itself again through a relationship`;
    case "json": return `it reads ${problem.member}, which is stored as one JSON value`;
    case "write-call": return `it calls ${problem.callee}, which in a write policy counts as reading the record`;
    case "reported": return `it reads computed ${problem.field}, which holds an error`;
  }
}

/**
 * How a destroy writes (ADR-0054, ADR-0046 option B); shared by the actions view and `mesh explain`, so the two never
 * disagree. In order: a `check` or a step reads the row first; no record-reading policy function (`when=` included) is
 * one delete; a record-reading `when=`, an adapter without `policy-guards`, or a record-reading check that does not lower
 * to SQL in write mode (or crosses a relationship without `joins`) reads first; otherwise the delete statement checks
 * the record-reading policy checks itself. The first three tests are today's split, so a project whose adapter does not
 * declare `policy-guards` never reaches a new branch and its output does not change.
 */
export function destroyStrategy(document: ModelDocument | undefined, entity: Entity, action: Action, capabilities: readonly string[]): DestroyPlan {
  const blocks = [...alwaysFor(entity, action).map((block) => ({ validate: block.validate, steps: block.do })), { validate: action.validate, steps: action.do }];
  const read = (reason = READ): DestroyPlan => ({ strategy: "read", reason, guarded: [] });
  if (checksOf(blocks.flatMap((block) => block.validate)).length > 0 || stepsFor(action, blocks.flatMap((block) => block.steps)).length > 0) return read();
  const covering = policiesCovering(entity, action);
  const reading = covering.flatMap((policy) => policyExpressions(policy).filter(({ expression }) => readsRecord(expression, "write")).map((found) => ({ ...found, policy })));
  if (reading.length === 0) return { strategy: "delete", reason: DELETE, guarded: [] };
  if (reading.some(({ kind }) => kind === "when")) return read();
  if (!capabilities.includes("policy-guards") || !document) return read();
  for (const check of reading) {
    const lowered = lowerCondition(document, entity, check.expression, { mode: "write" });
    const cause = !lowered.ok ? why(lowered.problems[0]!)
      : lowered.lowered.crossings.length > 0 && !capabilities.includes("joins")
        ? `it reads ${lowered.lowered.crossings[0]!.path} through a relationship, and the data adapter does not declare joins` : undefined;
    if (cause !== undefined) return read(`${READ} (${check.what} reads the record, and the delete statement cannot check it: ${cause})`);
  }
  return {
    strategy: "guarded",
    reason: `one delete by key with the policies in the statement: the checks that read the record (${[...new Set(reading.map(({ policy }) => `:${policy.name}`))].join(", ")}) run inside the delete, which fails as forbidden when they deny (ADR-0046, option B); with an afterWrite or afterCommit seam registered, or under Mesh.checkPolicies or Mesh.can, the row is read under the lock first and the policies run in memory`,
    guarded: reading,
  };
}

/** The data adapter's declared capabilities, as the build reads them. */
export function dataCapabilities(config: { readonly data: { readonly capabilities?: { readonly capabilities: readonly string[] } | undefined } }): readonly string[] {
  return config.data.capabilities?.capabilities ?? [];
}
