import { dirname, resolve } from "node:path";
import type { ActionType, Diagnostic, Entity, Expression, ModelDocument, SourcePosition, Step } from "@meshfw/model";
import { actionExpressions, type ActionExpression } from "./action-expressions.ts";
import { error } from "./diagnostics.ts";
import { loadPolicies, policiesCovering, policyExpressions, recordReason } from "./policies.ts";

/** True when the function only ever runs in a create: an action that is one, or an `always` block that covers nothing else. */
function createOnly(entity: Entity, owner: ActionExpression["owner"]): boolean {
  if ("action" in owner) return owner.action.kind === "create";
  const { always } = owner;
  const named = always.actions?.map((ref) => entity.actions.find((a) => a.name === ref.name)?.kind ?? (ref.name === "create" ? "create" : undefined));
  const covers = always.types ?? named;
  return covers !== undefined && covers.length > 0 && covers.every((kind) => kind === "create");
}

/**
 * What the action lifecycle (M5) cannot run is a build error, never a silent skip (ADR-0018): `before` in a check or a create,
 * a `validate` or `do` on a read, which has no record to check or change, a `set` or `load` in a destroy, and in a policy
 * (M8) `before`, a call to an entity's action and, on a read or a load, a call to `privileged` or reading the record, and a
 * policy with no check. `privilegedCallsOf` gives where a function calls `privileged`, kept by the front end.
 */
export function checkLifecycleLimits(
  document: ModelDocument,
  diagnostics: Diagnostic[],
  options: { privilegedCallsOf?: (expression: Expression) => readonly SourcePosition[] } = {},
): void {
  // The entities a relationship (and so a rollup) reaches: a caller's load of one runs its read policies (POL-17).
  const loaded = new Set(document.entities.flatMap((from) => from.relationships.map((relation) => resolve(dirname(from.file), relation.entity.from))));
  // A relationship to an entity whose policies leave out the read a load runs gives every caller's load of it nothing
  // (POL-17), with no error: say so (R2-N2 of the PR #79 review). Legal, since `privileged` and a computed field's body still
  // read it. An entity with no policy at all is left out: it denies every caller everything (deny by default), loads
  // included, which its own actions show at once.
  const byFile = new Map(document.entities.map((entity) => [resolve(entity.file), entity]));
  for (const from of document.entities)
    for (const relation of from.relationships) {
      const target = byFile.get(resolve(dirname(from.file), relation.entity.from));
      if (!target?.policies.length || loadPolicies(target).length) continue;
      const empty = relation.kind === "has-many" ? "[]" : "null";
      diagnostics.push({ ...error("MESH_LOAD_NO_POLICY",
        `${relation.kind} :${relation.name} of ${from.fqn} reaches ${target.fqn}, and no policy of ${target.fqn} covers the read a load runs, so every caller's load of it is ${empty}, a count over it 0 and any other rollup null (through \`privileged\` and in a computed field's body it is loaded)`,
        relation.position,
        `If callers may load it, give ${target.fqn} a policy that covers its read: \`types=[:read]\`, \`actions=[&read]\` or no scope`), severity: "warning" });
    }
  for (const entity of document.entities) {
    // A computed field is worked out when a record is loaded, outside any action, so it has no transaction to compose in:
    // it reads the record and what it loads, never through `privileged`, and runs no action (TXN-18). A helper it calls
    // that does either throws when the field is evaluated (`ActionFrame.marked` in the runtime).
    for (const field of entity.computed) {
      const body = field.body;
      if (!body) continue;
      const reaches = body.plain?.privileged ? "calls `privileged`" : body.plain?.acts ? "calls an entity's action" : undefined;
      if (reaches)
        diagnostics.push(error("MESH_COMPUTED_COMPOSES",
          `computed :${field.name} of ${entity.fqn} ${reaches}, which only a function that runs inside an action may: a computed field is worked out whenever a record is loaded, outside any action`,
          body.position, "Compute it from the record, its relationships and other computed fields; a read through `privileged` or a call to another action belongs in a step or a check"));
    }
    // A plain function (a `run`, or a body that is not one expression) is not type-checked by the expression pass, so a create's
    // `before` parameter is caught here: a create has no stored record.
    for (const { expression, kind, what, owner } of actionExpressions(entity)) {
      const reads = expression.params.includes("before") || (expression.rest && /\bbefore\b/.test(expression.source));
      if (!reads) continue;
      const end = expression.position.offset + expression.source.length;
      const reported = (code: string) => diagnostics.some((d) => d.code === code && d.position.file === expression.position.file && d.position.offset >= expression.position.offset && d.position.offset < end);
      // A check runs before the input is applied, on `self` as it is (ACT-01, ACT-27): `before` would be the same record.
      // The type pass reports a `before` it reads in a translated check; this catches a plain one, or one only destructured.
      if (kind === "that" || kind === "check-when" || kind === "details") {
        if (!reported("MESH_VALIDATE_BEFORE"))
          diagnostics.push(error("MESH_VALIDATE_BEFORE",
            `${what} reads \`before\`, which is gone from \`validate\`: there \`self\` is the record before the input is applied (the stored record, or a create's new instance), and the caller's values are \`input.x\``,
            expression.position, "write `&x` for the value before the input, `input.x` for the caller's, and `input.x ?? &x` for the value the action will store"));
        continue;
      }
      if (!expression.plain || !createOnly(entity, owner)) continue;
      // The type pass already reported a `before` it found inside this function.
      if (reported("MESH_BEFORE_IN_CREATE")) continue;
      diagnostics.push(error("MESH_BEFORE_IN_CREATE",
        `${what} reads \`before\`, the stored record, and a create has none, so it is always null`, expression.position,
        "Remove it. Compare with `self` or `input`, or move the rule to an update"));
    }
    // A policy decides; it does not act, and it sees no `before` (it runs before `validate`, POL-08). A read policy that
    // reads the record is a filter on the query, which the SQL evaluator folds in M10 (RDM-10).
    for (const policy of entity.policies)
      for (const { expression, what } of policyExpressions(policy)) {
        const uses = (name: string) => expression.params.includes(name) || expression.plain?.roots.includes(name) || (expression.rest === true && new RegExp(`\\b${name}\\b`).test(expression.source));
        const end = expression.position.offset + expression.source.length;
        const reported = (code: string) => diagnostics.some((d) => d.code === code && d.position.file === expression.position.file && d.position.offset >= expression.position.offset && d.position.offset < end);
        if (uses("before") && !reported("MESH_POLICY_BEFORE"))
          diagnostics.push(error("MESH_POLICY_BEFORE",
            `${what} reads \`before\`, which a policy does not have: it sees \`self\` as \`validate\` does, before the input is applied (the stored record, or a create's new instance), and the caller's values as \`input.x\``,
            expression.position, "write `&x` for the stored value and `input.x` for the caller's"));
        if (expression.plain?.acts)
          diagnostics.push(error("MESH_POLICY_ACTS",
            `${what} calls an entity's action: a policy decides whether the call may run, and must not run actions itself`,
            expression.position, "read what the decision needs through `privileged(Entity)`, which runs reads only"));
      }
    // A policy with no check would pass every call it covers (POL-16): the build says so, and asks for it written out.
    for (const policy of entity.policies)
      if (!policy.authorizeIf.length && !policy.forbidIf.length)
        diagnostics.push(error("MESH_POLICY_NO_CHECKS",
          `policy :${policy.name} of ${entity.fqn} has no \`authorize-if\` and no \`forbid-if\`, so it would pass every call it covers`,
          policy.position,
          "To let every caller through, say so: `authorize-if=() => true`. Otherwise write the check the policy stands for"));
    const reads = [...entity.actions, ...entity.auto.map((kind) => ({ kind, name: kind as string }))].filter((action) => action.kind === "read");
    const loads = loaded.has(resolve(entity.file)) ? loadPolicies(entity) : [];
    for (const policy of entity.policies) {
      const covered = reads.filter((action) => policiesCovering(entity, action).includes(policy)).map((action) => `read :${action.name}`);
      if (loads.includes(policy)) covered.push("the loads of it (a relationship or a rollup that reaches it)");
      // A read policy is a filter on the query: it reads the row in hand and the caller, never another entity. A call
      // hidden in a helper it calls is caught at run time instead, while the policy is evaluated (TXN-18).
      if (covered.length)
        for (const { expression, what } of policyExpressions(policy)) {
          if (!expression.plain?.privileged) continue;
          const calls = options.privilegedCallsOf?.(expression) ?? [];
          for (const position of calls.length ? calls : [expression.position])
            diagnostics.push(error("MESH_READ_POLICY_PRIVILEGED",
              `${what} calls \`privileged\`, and the policy covers ${covered.join(", ")} of ${entity.fqn}: a read policy is a filter on the query, and reads no other entity`,
              position,
              "Move the condition into a write policy (scope this one to the writes with `types=` or `actions=`) or a check, or into a computed field that the filter compares"));
        }
      const reading = covered.length ? policyExpressions(policy).find(({ expression }) => recordReason(expression, "read")) : undefined;
      if (!reading) continue;
      diagnostics.push(error("MESH_NOT_IMPLEMENTED",
        `${reading.what} ${recordReason(reading.expression, "read")}, and the policy covers ${covered.join(", ")} of ${entity.fqn}: a read policy that reads the record is a filter on the query, which the SQL evaluator folds in M10`,
        reading.expression.position,
        "Until M10, a read policy reads only `actor`, `context` and `input` (it then gives the whole result or none); scope a record-reading policy to the writes with `types=` or `actions=`"));
    }
    for (const action of entity.actions) {
      if (action.kind !== "read") continue;
      if (action.validate.length || action.do.length)
        diagnostics.push(error("MESH_NOT_IMPLEMENTED",
          `read :${action.name} of ${entity.fqn} declares ${action.validate.length ? "validate" : "do"}, which a read does not run: it has no record to check or change`,
          action.position, "A read narrows its rows with `filter`; its caller narrows them further with `filter`, `sort`, `limit` and `offset`"));
    }
    // A destroy returns nothing and writes nothing: a `set` or `load` in one would be dropped, so it is refused.
    const refuseDestroyStep = (steps: Step[], where: string): void => {
      for (const step of steps) {
        if (step.kind === "set" || step.kind === "load")
          diagnostics.push(error("MESH_DESTROY_STEP",
            `${where} has a \`${step.kind}\` step, and a destroy returns nothing and writes nothing, so it would do nothing`,
            step.position, step.kind === "set" ? "Remove it. A destroy can `check` the record, and `run` work before the delete or, with `after=:write`, after it" : "Remove it. A destroy returns nothing for a loaded record to appear on"));
        else if (step.kind === "when") refuseDestroyStep(step.steps, where);
      }
    };
    for (const action of entity.actions) if (action.kind === "destroy") refuseDestroyStep(action.do, `destroy :${action.name} of ${entity.fqn}`);
    for (const always of entity.always) {
      const covers = always.types?.includes("destroy") || always.actions?.some((ref) => entity.actions.find((a) => a.name === ref.name)?.kind === "destroy" || (ref.name === "destroy" && entity.auto.includes("destroy")));
      if (covers) refuseDestroyStep(always.do, `an always block of ${entity.fqn} that covers a destroy`);
    }
    for (const always of entity.always) {
      if (!always.validate.length && !always.do.length) continue;
      const reads = (always.types ?? []).includes("read" satisfies ActionType)
        || always.actions?.some((ref) => entity.actions.find((a) => a.name === ref.name)?.kind === "read" || (ref.name === "read" && entity.auto.includes("read")));
      if (reads)
        diagnostics.push(error("MESH_NOT_IMPLEMENTED",
          `always declares ${always.validate.length ? "validate" : "do"} for a read, which does not run it: a read has no record to check or change`,
          always.position, "Scope the block to :create, :update or :destroy"));
    }
  }
}
