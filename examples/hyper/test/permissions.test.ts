// M8b in Hyper: Hyper's permissions as Mesh policies (PORTING.md, "Permissions"). Roadmap M8 acceptance tests (1) to
// (8) on Hyper; the 19 cases of the specification's group 02 (`SPEC/conformance/02-permissions.test.ts`), each under its
// line number; and the permission cases of the other groups. A case asserts `ForbiddenError.policies`, the policies that
// refused the call, each named after the spec's check id (`isMember` is `membership`, `ownerOrMember` and `ownerOnly`
// are `role`, `claimAssignee` is `claim.assignee`, and so on); the error code, the phase and the check ids on the wire
// are HA's to give. Where the spec expects a rule (`rule_violation`), the case asserts the issue's `code`.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Glob } from "bun";
import { buildModel } from "@meshfw/compiler";
import { authorizer, ForbiddenError, NotFoundError, type ActionContext, type DataLayer, type PolicyCheckSpec, type PolicySpec } from "@meshfw/runtime";
import { expressions as claimExpressions } from "../.mesh/domain/work/claim.expressions";
import { expressions as taskExpressions } from "../.mesh/domain/work/task.expressions";
import { attemptStart, sessionRecord } from "../src/domain/execution/execution.commands";
import { collaboratorRetire, membershipRevoke } from "../src/domain/identity/identity.commands";
import { reviewAccept, submissionSubmit, taskCancel, taskComplete } from "../src/domain/work/work.commands";
import { as, asSystem, codes, deniedBy, empty, eventOf, issuesOf, one, populate, within, type Empty, type World } from "./world";

type Role = "owner" | "member" | "guest";

/** A Task id no row has. */
const GHOST = "00000000-0000-4000-8000-00000000dead";

/** A collaborator Alice, the owner, registers and grants `role`; with no `role`, it has no membership. */
async function join(w: World, name: string, role?: Role, kind: "human" | "agent" = "human") {
  const collaborator = await w.hyper.registerCollaborator({ kind, name }, as(w.alice));
  const membership = role ? await w.hyper.grantMembership({ collaborator: collaborator.id, role }, as(w.alice)) : null;
  return { ...collaborator, membership };
}

/** The issue codes a call fails with; the call must fail validation, not a policy. */
async function refused(call: Promise<unknown>, code: string): Promise<void> {
  expect(codes(await issuesOf(call))).toContain(code);
}

const taskOf = (w: World, id: string = w.task.id) => one(w.hyper.readTask({ filter: { id: { eq: id } } }, as(w.alice)));
const claimsOf = (w: World, task: string = w.task.id) => w.hyper.readClaim({ filter: { taskId: { eq: task } } }, as(w.alice));
const assignmentsOf = (w: World, task: string = w.task.id) => w.hyper.readAssignment({ filter: { taskId: { eq: task } } }, as(w.alice));

/** Bot claims `task` and submits: the pending submission. */
async function submitted(w: World, task: string, who: { readonly id: string } = w.bot) {
  const held = await w.hyper.acquireClaim({ task }, as(who));
  const result = await submissionSubmit({ task, fence: held.fence, summary: "done" }, as(who), w.binding);
  if (result.outcome !== "submitted") throw new Error(result.outcome);
  return result.submission;
}

/**
 * The spec's `leadWithChild` (`SPEC/conformance/_setup.ts:36-43`): a member, Lead, creates a parent and a child Task and
 * assigns the child to Bot. The child's reviewer is Lead, the parent's creator (the parent has no assignee).
 */
async function leadWithChild(w: World) {
  const lead = await join(w, "Lead", "member");
  const parent = await w.hyper.createTask({ title: "Parent" }, as(lead));
  const child = await w.hyper.createTask({ title: "Child", parent: parent.id }, as(lead));
  await w.hyper.assignTask({ id: child.id, assignee: w.bot.id }, as(lead));
  return { lead, parent, child };
}

describe("roadmap M8 acceptance tests on Hyper", () => {
  test("(1) a guest cannot create a Task, a member can, and the error names the policy", () => within(async (w) => {
    const guest = await join(w, "Gail", "guest");
    expect(await deniedBy(w.hyper.createTask({ title: "No" }, as(guest)))).toEqual(["ownerOrMember"]);
    expect((await w.hyper.createTask({ title: "Yes" }, as(w.bob))).creatorId).toBe(w.bob.id);
    // A collaborator with no membership fails the membership policy too (the spec's `membership`, 02:42).
    const outsider = await join(w, "Otto");
    expect(await deniedBy(w.hyper.createTask({ title: "No" }, as(outsider)))).toEqual(["isMember", "ownerOrMember"]);
  }));

  test("(2) every Hyper action is covered by a policy, and an action no policy covers is forbidden with the open policy to copy", async () => {
    for (const entity of model.entities)
      for (const action of [...entity.actions.map((a) => a.name), "read"])
        expect(covering(entity.name, action).length, `${entity.name}.${action}`).toBeGreaterThan(0);
    // Claim's policies without `internal`, the only one that covers `expire`: nothing covers it, so it is denied.
    const policies = specsOf("Claim", "expire", claimExpressions).filter((policy) => policy.name !== "internal");
    expect(policies).toEqual([]);
    const denial = await authorizer("work.Claim", "expire", policies).before(layer, {}).then(() => null, (cause: unknown) => cause as ForbiddenError);
    expect(denial).toBeInstanceOf(ForbiddenError);
    expect(denial).toMatchObject({ entity: "work.Claim", action: "expire", policies: [], reason: "not-covered" });
    expect(denial!.message).toContain("policy :open actions=[&expire] authorize-if=() => true");
  });

  test("(3) Claim :acquire on a Task assigned to someone else is forbidden to anyone but the assignee, owners included", () => within(async (w) => {
    await w.hyper.assignTask({ id: w.task.id, assignee: w.bot.id }, as(w.alice));
    expect(await deniedBy(w.hyper.acquireClaim({ task: w.task.id }, as(w.bob)))).toEqual(["claimAssignee"]);
    expect(await deniedBy(w.hyper.acquireClaim({ task: w.task.id }, as(w.alice)))).toEqual(["claimAssignee"]);
    expect((await w.hyper.acquireClaim({ task: w.task.id }, as(w.bot))).holderId).toBe(w.bot.id);
    // A Task that does not exist is not found, in the permission phase (PROTOCOL.md:110; PR #70 N4).
    await expect(w.hyper.acquireClaim({ task: GHOST }, as(w.bot))).rejects.toBeInstanceOf(NotFoundError);
  }));

  test("(4) a non-member's readTask returns no rows and no error; a guest's and a member's return the rows", () => within(async (w) => {
    // The spec answers a non-member's query with permission_denied (02:42-50): HA checks the membership before the
    // read and returns that error; the read itself, as Mesh runs it, is a filter (ADR-0022).
    const outsider = await join(w, "Otto");
    const guest = await join(w, "Gail", "guest");
    const held = await w.hyper.acquireClaim({ task: w.task.id }, as(w.bot));
    expect(await w.hyper.readTask({}, as(outsider))).toEqual([]);
    expect(await w.hyper.readClaim({}, as(outsider))).toEqual([]);
    expect((await w.hyper.readClaim({}, as(guest))).map((claim) => claim.id)).toEqual([held.id]);
    expect((await w.hyper.readTask({}, as(guest))).map((task) => task.id)).toEqual([w.task.id]);
    expect((await w.hyper.readTask({}, as(w.bob))).map((task) => task.id)).toEqual([w.task.id]);
  }));

  test("(5) the owner, the delegator and the reviewer revoke a claim; a member who is neither cannot", () => within(async (w) => {
    // Alice creates the parent and assigns it to Carol, whose child Task Bob creates and delegates to Bot: Carol is the
    // child's reviewer (the parent's assignee), Bob its delegator, Alice the owner, Erin a member who is neither.
    const carol = await join(w, "Carol", "member");
    const erin = await join(w, "Erin", "member");
    const parent = await w.hyper.createTask({ title: "Parent" }, as(w.alice));
    await w.hyper.assignTask({ id: parent.id, assignee: carol.id }, as(w.alice));
    const child = await w.hyper.createTask({ title: "Child", parent: parent.id }, as(w.bob));
    await w.hyper.assignTask({ id: child.id, assignee: w.bot.id }, as(w.bob));
    const revoke = async (who: { readonly id: string }) => {
      const held = await w.hyper.acquireClaim({ task: child.id }, as(w.bot));
      const denied = await deniedBy(w.hyper.revokeClaim({ id: held.id, reason: "stop" }, as(who)));
      if (denied.length) await w.hyper.releaseClaim({ id: held.id, fence: held.fence }, as(w.bot));
      return denied;
    };
    expect(await revoke(erin)).toEqual(["claimRevoker"]);
    expect(await revoke(w.alice)).toEqual([]);
    expect(await revoke(w.bob)).toEqual([]);
    expect(await revoke(carol)).toEqual([]);
    // A guest reviewer is refused by its role first.
    await w.hyper.changeRoleMembership({ id: carol.membership!.id, role: "guest" }, as(w.alice));
    expect(await revoke(carol)).toEqual(["ownerOrMember", "claimRevoker"]);
    const claims = [...await claimsOf(w, child.id)].sort((a, b) => a.fence - b.fence);
    expect(claims.map((claim) => claim.state)).toEqual(["released", "revoked", "revoked", "revoked", "released"]);
  }));

  test("(5) a membership revoked inside the same transaction is seen by the next write's policy", () => within(async (w) => {
    // `as(w.bob)` is built before the revoke and still says `member`: the write policies read the role through `tx`.
    const bob = as(w.bob);
    const denied = await deniedBy(w.hyper.transaction(async ({ actions }) => {
      await actions.revokeMembership({ id: w.memberships.bob.id, reason: "left" });
      await actions.createTask({ title: "After" }, bob);
    }, as(w.alice)));
    expect(denied).toEqual(["isMember", "ownerOrMember"]);
    // The denial rolled the transaction back: Bob is still a member.
    expect((await w.hyper.createTask({ title: "Still" }, bob)).creatorId).toBe(w.bob.id);
  }));

  test("(6) review.accept's nested task.complete passes as system and records the human; the same direct calls are forbidden", () => within(async (w) => {
    const submission = await submitted(w, w.task.id);
    const accepted = await reviewAccept({ submission: submission.id }, as(w.alice), w.binding);
    // The Completion records the human reviewer, as Hyper's event keeps the actor (`actor_id`).
    expect(accepted.completion).toMatchObject({ rule: "review-accepted", completedById: w.alice.id });
    // Completion :record is internal: a worker's direct call is forbidden.
    expect(await deniedBy(w.hyper.recordCompletion({ rule: "performer-is-reviewer", task: w.task.id }, as(w.bot)))).toEqual(["internal"]);
    // So is a caller that forges review.accept's completion on task.complete (policy reviewCompletion).
    const forged = { ...as(w.bot), completion: { rule: "review-accepted" as const, submissionId: submission.id } };
    expect(await deniedBy(w.hyper.completeTask({ id: w.task.id }, forged))).toEqual(["reviewCompletion"]);
  }));

  test("(7) moving a policy, or a check inside one, changes no decision", () => within(async (w) => {
    const carol = await join(w, "Carol", "guest");
    const dave = await join(w, "Dave");
    await w.hyper.assignTask({ id: w.task.id, assignee: w.bot.id }, as(w.alice));
    const held = await w.hyper.acquireClaim({ task: w.task.id }, as(w.bot));
    const task = await taskOf(w);
    const actors: Record<string, ReturnType<typeof as>> = {
      outsider: as(dave), guest: as(carol), member: as(w.bob), owner: as(w.alice), holder: as(w.bot), system: asSystem(w.bob),
      forged: { ...as(w.alice), completion: { rule: "review-accepted", submissionId: held.id } },
    };
    const cases = [
      { entity: "Claim", action: "acquire", expressions: claimExpressions, self: {}, input: { task: w.task.id } },
      { entity: "Claim", action: "renew", expressions: claimExpressions, self: held, input: { id: held.id, fence: held.fence } },
      { entity: "Claim", action: "revoke", expressions: claimExpressions, self: held, input: { id: held.id, reason: "x" } },
      { entity: "Task", action: "complete", expressions: taskExpressions, self: task, input: { id: task.id } },
      { entity: "Task", action: "cancel", expressions: taskExpressions, self: task, input: { id: task.id, reason: "x" } },
    ];
    const decisions = await w.hyper.transaction(async ({ tx }) => {
      const table: Record<string, string[]> = {};
      for (const { entity, action, expressions, self, input } of cases) {
        const policies = specsOf(entity, action, expressions);
        for (const [actor, context] of Object.entries(actors)) {
          const scope = { self, input, actor: context.actor, context, tx, clock: w.clock };
          const answers = new Set<string>();
          for (const order of orders(policies)) answers.add(await decide(entity, action, order, scope));
          (table[`${entity}.${action}`] ??= []).push(`${actor}: ${[...answers].join(" | ")}`);
        }
      }
      return table;
    }, asSystem(w.alice));
    // One answer per actor in every order, and the answers are Hyper's. The forged completion is refused before the
    // transaction by its actor-only check, so the record-reading claimHolder never runs for it (M8a: `before`). The
    // outsider passes claimAssignee, which leaves a collaborator with no membership to isMember and ownerOrMember, so a
    // missing Task answers it as an existing one does (02:42 below).
    expect(decisions).toEqual({
      "Claim.acquire": ["outsider: isMember,ownerOrMember", "guest: ownerOrMember,claimAssignee", "member: claimAssignee", "owner: claimAssignee", "holder: allowed", "system: allowed", "forged: claimAssignee"],
      "Claim.renew": ["outsider: isMember,ownerOrMember,claimHolder", "guest: ownerOrMember,claimHolder", "member: claimHolder", "owner: claimHolder", "holder: allowed", "system: allowed", "forged: claimHolder"],
      "Claim.revoke": ["outsider: isMember,ownerOrMember,claimRevoker", "guest: ownerOrMember,claimRevoker", "member: claimRevoker", "owner: allowed", "holder: claimRevoker", "system: allowed", "forged: allowed"],
      "Task.complete": ["outsider: isMember,ownerOrMember,claimHolder", "guest: ownerOrMember,claimHolder", "member: claimHolder", "owner: claimHolder", "holder: allowed", "system: allowed", "forged: reviewCompletion"],
      "Task.cancel": ["outsider: isMember,ownerOrMember,taskManager", "guest: ownerOrMember,taskManager", "member: taskManager", "owner: allowed", "holder: allowed", "system: allowed", "forged: allowed"],
    });
  }));

  test("(8) a policy whose actions= names a missing action fails the build", () => {
    const root = resolve(import.meta.dir, "..");
    const files = [...new Glob("src/domain/**/*.mesh.mx").scanSync(root)].sort().map((file) => ({ file, source: readFileSync(resolve(root, file), "utf8") }));
    expect(files).toHaveLength(18);
    expect(buildModel({ root, files, domainRoot: "src/domain" }).diagnostics).toEqual([]);
    const typo = files.map((entry) => entry.file.endsWith("/claim.mesh.mx")
      ? { ...entry, source: entry.source.replace("policy :claimHolder actions=[&renew, &release]", "policy :claimHolder actions=[&renw, &release]") }
      : entry);
    expect(typo).not.toEqual(files);
    const built = buildModel({ root, files: typo, domainRoot: "src/domain" });
    expect(built.diagnostics).toMatchObject([{ code: "MESH_UNKNOWN_ACTION", severity: "error", position: { file: "src/domain/work/claim.mesh.mx" } }]);
    expect(built.diagnostics[0]!.message).toContain("&renw is not an action of work.Claim");
  });
});

describe("group 02.1: guests", () => {
  test("02:13 a guest cannot send work commands (role)", () => within(async (w) => {
    const guest = await join(w, "Gail", "guest");
    expect(await deniedBy(w.hyper.createTask({ title: "not allowed" }, as(guest)))).toEqual(["ownerOrMember"]);
    expect(await deniedBy(w.hyper.acquireClaim({ task: w.task.id }, as(guest)))).toEqual(["ownerOrMember"]);
    expect(await deniedBy(w.hyper.recordEvidenceReference({ kind: "link", locator: "https://example.com" }, as(guest)))).toEqual(["ownerOrMember"]);
  }));

  test("02:21 a guest can read (queries need any active membership)", () => within(async (w) => {
    // The spec's `events.read` is HA's: the port's Event rows are written by HA's event log.
    const guest = await join(w, "Gail", "guest");
    expect((await one(w.hyper.readTask({ filter: { id: { eq: w.task.id } } }, as(guest)))).title).toBe("Ship");
    expect((await w.hyper.readTask({}, as(guest))).length).toBeGreaterThan(0);
  }));

  test("02:29 a guest cannot be assigned work (rule assignment.assignee-role)", () => within(async (w) => {
    const guest = await join(w, "Gene", "guest", "agent");
    await refused(w.hyper.assignTask({ id: w.task.id, assignee: guest.id }, as(w.alice)), "assignment.assignee-role");
    expect(await assignmentsOf(w)).toEqual([]);
  }));

  // 02:36 (`task.next` is null for a guest) is not ported: the port has no `next` query (PORTING.md, G27).

  test("02:42 a collaborator with no membership cannot act (membership) or read", () => within(async (w) => {
    const outsider = await join(w, "outsider", undefined, "agent");
    expect(await deniedBy(w.hyper.createTask({ title: "x" }, as(outsider)))).toEqual(["isMember", "ownerOrMember"]);
    // The spec's permission_denied on the query is HA's (it checks the membership first); the read gives no rows.
    expect(await w.hyper.readTask({}, as(outsider))).toEqual([]);
  }));

  test("02:42 a non-member's claim answers the same for a missing Task as for an existing one (PROTOCOL.md:110)", () => within(async (w) => {
    // A target the actor cannot see is not_found exactly as a missing one, so a caller cannot tell the two apart; a
    // collaborator with no membership sees no Task, so both answer `membership` (isMember), as Hyper's Role policy does.
    const outsider = await join(w, "Otto");
    const assigned = await w.hyper.createTask({ title: "Assigned" }, as(w.alice));
    await w.hyper.assignTask({ id: assigned.id, assignee: w.bot.id }, as(w.alice));
    const answers = [];
    for (const task of [GHOST, w.task.id, assigned.id]) answers.push(await denialOf(w.hyper.acquireClaim({ task }, as(outsider))));
    expect(answers[0]).toMatchObject({ entity: "work.Claim", action: "acquire", policies: ["isMember", "ownerOrMember"], reason: "failed" });
    expect(answers[1]).toEqual(answers[0]);
    expect(answers[2]).toEqual(answers[0]);
    // A guest may read every Task, so a missing one is not found for it, in the permission phase.
    const guest = await join(w, "Gail", "guest");
    await expect(w.hyper.acquireClaim({ task: GHOST }, as(guest))).rejects.toBeInstanceOf(NotFoundError);
  }));
});

describe("group 02.2: only owners manage memberships and collaborators", () => {
  test("02:57 a member cannot register, grant, change roles, revoke or retire (role)", () => within(async (w) => {
    const member = as(w.bob);
    expect(await deniedBy(w.hyper.registerCollaborator({ kind: "agent", name: "sneaky" }, member))).toEqual(["ownerOnly"]);
    const fresh = await w.hyper.registerCollaborator({ kind: "agent", name: "fresh" }, as(w.alice));
    expect(await deniedBy(w.hyper.grantMembership({ collaborator: fresh.id, role: "member" }, member))).toEqual(["ownerOnly"]);
    expect(await deniedBy(w.hyper.changeRoleMembership({ id: w.memberships.bot.id, role: "owner" }, member))).toEqual(["ownerOnly"]);
    expect(await deniedBy(w.hyper.changeRoleMembership({ id: w.memberships.bob.id, role: "owner" }, member))).toEqual(["ownerOnly"]);
    expect(await deniedBy(membershipRevoke({ id: w.memberships.bot.id }, member, w.binding))).toEqual(["ownerOnly"]);
    expect(await deniedBy(collaboratorRetire({ id: w.bot.id }, member, w.binding))).toEqual(["ownerOnly"]);
  }));

  test("02:69 an owner grants, changes a role and revokes, recording who granted and revoked", () => within(async (w) => {
    const ana = await w.hyper.registerCollaborator({ kind: "human", name: "Ana" }, as(w.alice));
    const granted = await w.hyper.grantMembership({ collaborator: ana.id, role: "guest" }, as(w.alice));
    expect(granted).toMatchObject({ role: "guest", state: "active", grantedById: w.alice.id, collaboratorId: ana.id });
    expect((await w.hyper.changeRoleMembership({ id: granted.id, role: "member" }, as(w.alice))).role).toBe("member");
    const { membership } = await membershipRevoke({ id: granted.id, reason: "left" }, as(w.alice), w.binding);
    expect(membership).toMatchObject({ state: "revoked", revokedById: w.alice.id });
  }));

  test("02:83 one active membership per collaborator (rule membership.none-active)", () => within(async (w) => {
    await refused(w.hyper.grantMembership({ collaborator: w.bob.id, role: "guest" }, as(w.alice)), "membership.none-active");
  }));

  test("02:88 a revoked collaborator returns through a new grant (a new membership)", () => within(async (w) => {
    const { membership: revoked } = await membershipRevoke({ id: w.memberships.bob.id }, as(w.alice), w.binding);
    const granted = await w.hyper.grantMembership({ collaborator: w.bob.id, role: "member" }, as(w.alice));
    expect(granted.id).not.toBe(revoked.id);
    expect((await w.hyper.createTask({ title: "back" }, as(w.bob))).title).toBe("back");
  }));

  test("02:96 the last owner cannot be demoted, revoked or retired (rule membership.last-owner)", () => within(async (w) => {
    await refused(w.hyper.changeRoleMembership({ id: w.memberships.alice.id, role: "member" }, as(w.alice)), "membership.last-owner");
    await refused(membershipRevoke({ id: w.memberships.alice.id }, as(w.alice), w.binding), "membership.last-owner");
    await refused(collaboratorRetire({ id: w.alice.id }, as(w.alice), w.binding), "membership.last-owner");
  }));

  test("02:103 a second owner can manage memberships; then the first owner may be demoted", () => within(async (w) => {
    const coOwner = await join(w, "co-owner", "owner");
    await w.hyper.changeRoleMembership({ id: w.memberships.bob.id, role: "guest" }, as(coOwner));
    expect((await w.hyper.changeRoleMembership({ id: w.memberships.alice.id, role: "member" }, as(coOwner))).role).toBe("member");
    // Alice, a member now, may not manage memberships; the co-owner gives her role back.
    expect(await deniedBy(w.hyper.changeRoleMembership({ id: w.memberships.bob.id, role: "member" }, as(w.alice)))).toEqual(["ownerOnly"]);
    await w.hyper.changeRoleMembership({ id: w.memberships.alice.id, role: "owner" }, as(coOwner));
  }));

  test("02:112 collaborator names are unique among active collaborators (rule collaborator.name-unique)", () => within(async (w) => {
    await w.hyper.registerCollaborator({ kind: "agent", name: "reviewer-agent" }, as(w.alice));
    await refused(w.hyper.registerCollaborator({ kind: "human", name: "reviewer-agent" }, as(w.alice)), "collaborator.name-unique");
  }));

  test("02:117 collaborator.update: the collaborator itself or an owner; kind never changes", () => within(async (w) => {
    expect((await w.hyper.updateCollaborator({ id: w.bot.id, name: "Bot-v2" }, as(w.bot))).name).toBe("Bot-v2");
    expect(await deniedBy(w.hyper.updateCollaborator({ id: w.bot.id, name: "hijack" }, as(w.bob)))).toEqual(["collaboratorSelfOrOwner"]);
    expect((await w.hyper.updateCollaborator({ id: w.bot.id, name: "Bot-v3" }, as(w.alice))).name).toBe("Bot-v3");
    await refused(w.hyper.updateCollaborator({ id: w.bot.id, kind: "human" }, as(w.bot)), "collaborator.kind-immutable");
  }));

  test("02:127 a guest may update its own profile, and only its own (collaborator.self-or-owner)", () => within(async (w) => {
    const guest = await join(w, "self-guest", "guest");
    expect((await w.hyper.updateCollaborator({ id: guest.id, name: "self-guest-x" }, as(guest))).name).toBe("self-guest-x");
    expect(await deniedBy(w.hyper.updateCollaborator({ id: w.bob.id, name: "renamed" }, as(guest)))).toEqual(["collaboratorSelfOrOwner"]);
    // Not with no membership: the spec checks every command against the actor's active membership (PROTOCOL.md:88,
    // :246), and the self-update is "in any role" (:254), so isMember refuses. Hyper's Role check lets the collaborator
    // itself through before its membership test (`role.ex:22-23`); the port follows the spec (POL-20).
    const outsider = await join(w, "outsider");
    expect(await deniedBy(w.hyper.updateCollaborator({ id: outsider.id, name: "outsider-x" }, as(outsider)))).toEqual(["isMember"]);
    // Nor once its membership is revoked.
    await membershipRevoke({ id: w.memberships.bob.id, reason: "left" }, as(w.alice), w.binding);
    expect(await deniedBy(w.hyper.updateCollaborator({ id: w.bob.id, name: "Bob-x" }, as(w.bob)))).toEqual(["isMember"]);
  }));

  test("02:135 changing a role to the one it already has is rejected (rule membership.unchanged)", () => within(async (w) => {
    await refused(w.hyper.changeRoleMembership({ id: w.memberships.bob.id, role: "member" }, as(w.alice)), "membership.unchanged");
  }));

  test("02:140 phase precedence: a guest with a stale expectedVersion is refused by the policy, and validate never runs", () => within(async (w) => {
    const guest = await join(w, "early", "guest");
    // `deniedBy` rethrows an InvalidInputError, so this also says that no `expected-version` issue was reported.
    expect(await deniedBy(w.hyper.updateTask({ id: w.task.id, title: "x", expectedVersion: 99 }, as(guest)))).toEqual(["ownerOrMember"]);
    // A member with the same stale version reaches validate.
    await refused(w.hyper.updateTask({ id: w.task.id, title: "x", expectedVersion: 99 }, as(w.bob)), "expected-version");
  }));

  test("02:149 one phase, several failures: a guest claiming a Task assigned to someone else fails role and claim.assignee", () => within(async (w) => {
    const guest = await join(w, "grabbing", "guest");
    await w.hyper.assignTask({ id: w.task.id, assignee: w.bot.id }, as(w.alice));
    expect(await deniedBy(w.hyper.acquireClaim({ task: w.task.id }, as(guest)))).toEqual(["ownerOrMember", "claimAssignee"]);
  }));
});

describe("group 02.3: revoking and retiring end active authority", () => {
  test("02:162 revoking a membership revokes the collaborator's active claims; assignments stay; it can no longer act", () => within(async (w) => {
    await w.hyper.assignTask({ id: w.task.id, assignee: w.bot.id }, as(w.alice));
    await w.hyper.acquireClaim({ task: w.task.id }, as(w.bot));
    await membershipRevoke({ id: w.memberships.bot.id, reason: "offboarded" }, as(w.alice), w.binding);
    expect((await claimsOf(w)).map((claim) => claim.state)).toEqual(["revoked"]);
    expect(await assignmentsOf(w)).toMatchObject([{ assigneeId: w.bot.id, endedAt: null, endReason: null }]);
    expect(await deniedBy(w.hyper.createTask({ title: "after revoke" }, as(w.bot)))).toEqual(["isMember", "ownerOrMember"]);
  }));

  test("02:175 retiring a collaborator revokes its membership and claims, keeps its history, and it can no longer act", () => within(async (w) => {
    await w.hyper.assignTask({ id: w.task.id, assignee: w.bot.id }, as(w.alice));
    await w.hyper.acquireClaim({ task: w.task.id }, as(w.bot));
    const { collaborator } = await collaboratorRetire({ id: w.bot.id, reason: "model retired" }, as(w.alice), w.binding);
    expect(collaborator.state).toBe("retired");
    expect(await assignmentsOf(w)).toMatchObject([{ assigneeId: w.bot.id, endedAt: null }]);
    expect(await claimsOf(w)).toMatchObject([{ holderId: w.bot.id, state: "revoked" }]);
    expect(await deniedBy(w.hyper.createTask({ title: "ghost" }, as(w.bot)))).toEqual(["isMember", "ownerOrMember"]);
    await refused(w.hyper.grantMembership({ collaborator: w.bot.id, role: "member" }, as(w.alice)), "collaborator.active");
  }));
});

describe("the permission cases of the other groups", () => {
  test("01:49 a member cannot rename the workspace (role)", () => within(async (w) => {
    const workspace = await w.hyper.createWorkspace({ name: "Home" }, as(w.alice));
    expect(await deniedBy(w.hyper.renameWorkspace({ id: workspace.id, name: "Mine" }, as(w.bob)))).toEqual(["ownerOnly"]);
    expect((await w.hyper.renameWorkspace({ id: workspace.id, name: "Ours" }, as(w.alice))).name).toBe("Ours");
  }));

  test("03:85 task.cancel and task.reopen: the assignee, the delegator or an owner, not another member (task.manager)", () => within(async (w) => {
    const other = await join(w, "other", "member");
    const task = await w.hyper.createTask({ title: "Delegated" }, as(w.bob));
    await w.hyper.assignTask({ id: task.id, assignee: w.bot.id }, as(w.bob));
    expect(await deniedBy(taskCancel({ id: task.id, reason: "mine now" }, as(other), w.binding))).toEqual(["taskManager"]);
    await taskCancel({ id: task.id, reason: "cannot do" }, as(w.bot), w.binding);
    expect(await deniedBy(w.hyper.reopenTask({ id: task.id, reason: "x" }, as(other)))).toEqual(["taskManager"]);
    expect((await w.hyper.reopenTask({ id: task.id, reason: "retry" }, as(w.bob))).state).toBe("open");
    await taskCancel({ id: task.id, reason: "owner stops it" }, as(w.alice), w.binding);
  }));

  test("03:97 the creator may cancel and reopen its Task while it is unassigned, not once someone else delegated it", () => within(async (w) => {
    const other = await join(w, "other2", "member");
    const task = await w.hyper.createTask({ title: "Mine, unassigned" }, as(w.bob));
    expect(await deniedBy(taskCancel({ id: task.id, reason: "not yours" }, as(other), w.binding))).toEqual(["taskManager"]);
    await taskCancel({ id: task.id, reason: "changed my mind" }, as(w.bob), w.binding);
    await w.hyper.reopenTask({ id: task.id, reason: "changed it back" }, as(w.bob));
    await w.hyper.assignTask({ id: task.id, assignee: other.id }, as(w.alice));
    expect(await deniedBy(taskCancel({ id: task.id, reason: "now delegated" }, as(w.bob), w.binding))).toEqual(["taskManager"]);
  }));

  test("04:55 a guest cannot add a dependency (role)", () => within(async (w) => {
    const guest = await join(w, "g", "guest");
    const prerequisite = await w.hyper.createTask({ title: "x" }, as(w.alice));
    expect(await deniedBy(w.hyper.addDependency({ dependent: w.task.id, prerequisite: prerequisite.id }, as(guest)))).toEqual(["ownerOrMember"]);
  }));

  test("05:36 only the assignee claims an assigned Task (claim.assignee), and a second claim fails the rule", () => within(async (w) => {
    await w.hyper.assignTask({ id: w.task.id, assignee: w.bot.id }, as(w.alice));
    expect(await deniedBy(w.hyper.acquireClaim({ task: w.task.id }, as(w.bob)))).toEqual(["claimAssignee"]);
    await w.hyper.acquireClaim({ task: w.task.id }, as(w.bot));
    await refused(w.hyper.acquireClaim({ task: w.task.id }, as(w.bot)), "claim.task-ready");
  }));

  test("05:53 claim.renew: a wrong fence fails the rule, a non-holder the permission (claim.holder)", () => within(async (w) => {
    const held = await w.hyper.acquireClaim({ task: w.task.id }, as(w.bot));
    expect((await w.hyper.renewClaim({ id: held.id, fence: held.fence }, as(w.bot))).fence).toBe(held.fence);
    await refused(w.hyper.renewClaim({ id: held.id, fence: held.fence + 1 }, as(w.bot)), "claim.current-fence");
    expect(await deniedBy(w.hyper.renewClaim({ id: held.id, fence: held.fence }, as(w.bob)))).toEqual(["claimHolder"]);
  }));

  test("05:76 claim.revoke: the delegator or an owner, not another member (claim.revoker)", () => within(async (w) => {
    const other = await join(w, "other", "member");
    const task = await w.hyper.createTask({ title: "Revocable" }, as(w.bob));
    await w.hyper.assignTask({ id: task.id, assignee: w.bot.id }, as(w.bob));
    const first = await w.hyper.acquireClaim({ task: task.id }, as(w.bot));
    expect(await deniedBy(w.hyper.revokeClaim({ id: first.id, reason: "mine" }, as(other)))).toEqual(["claimRevoker"]);
    expect((await w.hyper.revokeClaim({ id: first.id, reason: "wrong approach" }, as(w.bob))).state).toBe("revoked");
    await refused(w.hyper.revokeClaim({ id: first.id, reason: "again" }, as(w.bob)), "claim.active");
    const second = await w.hyper.acquireClaim({ task: task.id }, as(w.bot));
    expect(second.fence).toBe(2);
    expect((await w.hyper.revokeClaim({ id: second.id, reason: "owner intervenes" }, as(w.alice))).state).toBe("revoked");
  }));

  test("05:108 task.unassign: the assignee, the delegator or an owner, not another member (task.manager)", () => within(async (w) => {
    const other = await join(w, "other", "member");
    await w.hyper.assignTask({ id: w.task.id, assignee: w.bot.id }, as(w.alice));
    await w.hyper.acquireClaim({ task: w.task.id }, as(w.bot));
    expect(await deniedBy(w.hyper.unassignTask({ id: w.task.id }, as(other)))).toEqual(["taskUnassigner"]);
    await w.hyper.unassignTask({ id: w.task.id, reason: "overloaded" }, as(w.bot));
    expect((await claimsOf(w)).map((claim) => claim.state)).toEqual(["revoked"]);
    await refused(w.hyper.unassignTask({ id: w.task.id }, as(w.alice)), "assignment.current");
  }));

  test("06:59 only the reviewer reviews: not the worker, not another member, not even an owner (review.reviewer)", () => within(async (w) => {
    const { lead, child } = await leadWithChild(w);
    const other = await join(w, "other", "member");
    const submission = await submitted(w, child.id);
    expect(await deniedBy(reviewAccept({ submission: submission.id }, as(w.bot), w.binding))).toEqual(["reviewReviewer"]);
    expect(await deniedBy(w.hyper.returnReview({ submission: submission.id, reasons: "no" }, as(other)))).toEqual(["reviewReviewer"]);
    expect(await deniedBy(reviewAccept({ submission: submission.id }, as(w.alice), w.binding))).toEqual(["reviewReviewer"]);
    await reviewAccept({ submission: submission.id }, as(lead), w.binding);
    await refused(reviewAccept({ submission: submission.id }, as(lead), w.binding), "submission.pending");
  }));

  test("06:69 the submitter may withdraw a pending submission; others may not (submission.submitter)", () => within(async (w) => {
    const { lead, child } = await leadWithChild(w);
    const submission = await submitted(w, child.id);
    expect(await deniedBy(w.hyper.withdrawSubmission({ id: submission.id }, as(lead)))).toEqual(["submissionSubmitter"]);
    expect((await w.hyper.withdrawSubmission({ id: submission.id, reason: "wrong file" }, as(w.bot))).state).toBe("withdrawn");
    await refused(w.hyper.withdrawSubmission({ id: submission.id }, as(w.bot)), "submission.pending");
  }));

  test("06:177 an owner is not the reviewer when the parent has an assignee (review.reviewer)", () => within(async (w) => {
    const lead = await join(w, "Lead", "member");
    const parent = await w.hyper.createTask({ title: "Parent" }, as(w.alice));
    await w.hyper.assignTask({ id: parent.id, assignee: lead.id }, as(w.alice));
    const child = await w.hyper.createTask({ title: "Child", parent: parent.id }, as(w.alice));
    await w.hyper.assignTask({ id: child.id, assignee: w.bot.id }, as(w.alice));
    const submission = await submitted(w, child.id);
    expect(await deniedBy(reviewAccept({ submission: submission.id }, as(w.alice), w.binding))).toEqual(["reviewReviewer"]);
    expect((await reviewAccept({ submission: submission.id }, as(lead), w.binding)).review.ruleApplied).toBe("parent-assignee");
  }));

  test("06:219 task.complete without a fence while another holds the claim is claim.holder (spec only, C3)", () => within(async (w) => {
    const { lead, child } = await leadWithChild(w);
    await w.hyper.acquireClaim({ task: child.id }, as(w.bot));
    expect(await deniedBy(taskComplete({ id: child.id }, as(lead), w.binding))).toEqual(["claimHolder"]);
    // With a fence, the fence rule decides.
    await refused(taskComplete({ id: child.id, fence: 4 }, as(lead), w.binding), "claim.current-fence");
  }));

  test("06:241 demoting the reviewer leaves the submission pending, and a guest reviewer cannot act (role)", () => within(async (w) => {
    const { lead, child } = await leadWithChild(w);
    const submission = await submitted(w, child.id);
    await w.hyper.changeRoleMembership({ id: lead.membership!.id, role: "guest" }, as(w.alice));
    expect(await one(w.hyper.readSubmission({ filter: { id: { eq: submission.id } } }, as(w.alice)))).toMatchObject({ state: "pending" });
    expect(await deniedBy(reviewAccept({ submission: submission.id }, as(lead), w.binding))).toEqual(["ownerOrMember"]);
    await w.hyper.changeRoleMembership({ id: lead.membership!.id, role: "member" }, as(w.alice));
    expect((await reviewAccept({ submission: submission.id }, as(lead), w.binding)).task.state).toBe("done");
  }));

  test("a guest holder cannot renew or release its claim, nor withdraw its submission (C2: the gate on every Claim and Submission write)", () => within(async (w) => {
    const demote = () => w.hyper.changeRoleMembership({ id: w.memberships.bot.id, role: "guest" }, as(w.alice));
    const restore = () => w.hyper.changeRoleMembership({ id: w.memberships.bot.id, role: "member" }, as(w.alice));
    const held = await w.hyper.acquireClaim({ task: w.task.id }, as(w.bot));
    await demote();
    expect(await deniedBy(w.hyper.renewClaim({ id: held.id, fence: held.fence }, as(w.bot)))).toEqual(["ownerOrMember"]);
    expect(await deniedBy(w.hyper.releaseClaim({ id: held.id, fence: held.fence }, as(w.bot)))).toEqual(["ownerOrMember"]);
    await restore();
    const result = await submissionSubmit({ task: w.task.id, fence: held.fence, summary: "done" }, as(w.bot), w.binding);
    if (result.outcome !== "submitted") throw new Error(result.outcome);
    await demote();
    expect(await deniedBy(w.hyper.withdrawSubmission({ id: result.submission.id }, as(w.bot)))).toEqual(["ownerOrMember"]);
    await restore();
    expect((await w.hyper.withdrawSubmission({ id: result.submission.id }, as(w.bot))).state).toBe("withdrawn");
  }));

  test("a holder demoted to guest cannot record a late result (ownerOrMember on LateResult :record)", () => within(async (w) => {
    const held = await w.hyper.acquireClaim({ task: w.task.id }, as(w.bot));
    await w.hyper.changeRoleMembership({ id: w.memberships.bot.id, role: "guest" }, as(w.alice));
    w.advance(10);
    // The lapsed fence turns both commands into a late result, which only its role keeps the guest from recording.
    expect(await deniedBy(taskComplete({ id: w.task.id, fence: held.fence }, as(w.bot), w.binding))).toEqual(["ownerOrMember"]);
    expect(await deniedBy(submissionSubmit({ task: w.task.id, fence: held.fence, summary: "late" }, as(w.bot), w.binding))).toEqual(["ownerOrMember"]);
    expect(await w.hyper.readLateResult({}, as(w.alice))).toEqual([]);
    await w.hyper.changeRoleMembership({ id: w.memberships.bot.id, role: "member" }, as(w.alice));
    expect((await taskComplete({ id: w.task.id, fence: held.fence }, as(w.bot), w.binding)).outcome).toBe("late-result-recorded");
  }));
});

describe("the execution entities' permissions (no conformance group; Hyper's `runs/checks/reporter.ex`)", () => {
  async function attempt(w: World) {
    await w.hyper.acquireClaim({ task: w.task.id }, as(w.bot));
    const run = await w.hyper.startRun({ task: w.task.id }, as(w.bot));
    const { attempt } = await attemptStart({ run: run.id }, as(w.bot), w.binding);
    return { run, attempt };
  }

  test("run.canceler: an owner, the responsible collaborator or the starter, not another member", () => within(async (w) => {
    const { run } = await attempt(w);
    expect(await deniedBy(w.hyper.cancelRun({ id: run.id, reason: "stop" }, as(w.bob)))).toEqual(["runCanceler"]);
    expect((await w.hyper.cancelRun({ id: run.id, reason: "stop" }, as(w.bot))).state).toBe("canceled");
  }));

  test("a claim holder demoted to guest cannot start an attempt (ownerOrMember on Attempt :start)", () => within(async (w) => {
    await w.hyper.acquireClaim({ task: w.task.id }, as(w.bot));
    const run = await w.hyper.startRun({ task: w.task.id }, as(w.bot));
    await w.hyper.changeRoleMembership({ id: w.memberships.bot.id, role: "guest" }, as(w.alice));
    // A change of role leaves the claim live, so attemptClaimer passes, and only the role refuses.
    expect((await claimsOf(w)).map((claim) => claim.state)).toEqual(["active"]);
    expect(await deniedBy(attemptStart({ run: run.id }, as(w.bot), w.binding))).toEqual(["ownerOrMember"]);
    await w.hyper.changeRoleMembership({ id: w.memberships.bot.id, role: "member" }, as(w.alice));
    expect((await attemptStart({ run: run.id }, as(w.bot), w.binding)).attempt.performerId).toBe(w.bot.id);
  }));

  test("attempt.performer and invocation.recorder: the performer reports, the recorder or an owner corrects", () => within(async (w) => {
    const { attempt: started } = await attempt(w);
    expect(await deniedBy(w.hyper.recordInvocation({ attempt: started.id, usageSource: "runtime" }, as(w.bob)))).toEqual(["attemptPerformer"]);
    const invocation = await w.hyper.recordInvocation({ attempt: started.id, usageSource: "runtime" }, as(w.bot));
    expect(await deniedBy(w.hyper.correctInvocation({ corrects: invocation.id, reason: "x", usageSource: "estimate" }, as(w.bob)))).toEqual(["invocationRecorder"]);
    await w.hyper.correctInvocation({ corrects: invocation.id, reason: "x", usageSource: "estimate" }, as(w.alice));
    expect(await deniedBy(w.hyper.finishAttempt({ id: started.id, result: "succeeded" }, as(w.bob)))).toEqual(["attemptPerformer"]);
    expect((await w.hyper.finishAttempt({ id: started.id, result: "succeeded" }, as(w.bot))).state).toBe("succeeded");
  }));

  test("session references and machines: members record, owners redact and manage, only the recorder sets availability", () => within(async (w) => {
    const guest = await join(w, "Gail", "guest");
    const record = { runtime: "claude", runtimeSessionId: "s-1", availability: "complete", machine: "laptop", agentProfile: w.bot.id } as const;
    expect(await deniedBy(sessionRecord(record, as(guest), w.binding))).toEqual(["ownerOrMember"]);
    const { sessionReference } = await sessionRecord(record, as(w.bot), w.binding);
    expect(await deniedBy(w.hyper.setAvailabilitySessionReference({ id: sessionReference.id, availability: "partial" }, as(w.alice)))).toEqual(["sessionRecorder"]);
    expect(await deniedBy(w.hyper.redactSessionReference({ id: sessionReference.id, reason: "secret" }, as(w.bot)))).toEqual(["ownerOnly"]);
    await w.hyper.redactSessionReference({ id: sessionReference.id, reason: "secret" }, as(w.alice));
    const machine = await one(w.hyper.readMachine({}, as(w.alice)));
    expect(await deniedBy(w.hyper.retireMachine({ id: machine.id, reason: "sold" }, as(w.bot)))).toEqual(["ownerOnly"]);
    expect(await deniedBy(w.hyper.reportMachine({ name: "desktop" }, as(w.bot)))).toEqual(["internal"]);
  }));
});

describe("every read, every internal action and every gated write, over a workspace with a row of every entity", () => {
  test("every read: a collaborator with no membership gets no rows; a guest, and a call made as `system`, get them (membersRead)", () => populated(async (p) => {
    const entities = model.entities.map((entity) => entity.name);
    expect(entities).toHaveLength(18);
    for (const entity of entities) {
      const read = p.call(`read${entity}`);
      expect(await read({}, as(p.otto)), entity).toEqual([]);
      expect(((await read({}, as(p.gail))) as unknown[]).length, entity).toBeGreaterThan(0);
      expect(((await read({}, asSystem(p.otto))) as unknown[]).length, entity).toBeGreaterThan(0);
    }
  }));

  test("every internal action, called by an owner or a member without `system`, is forbidden by internal", () => populated(async (p) => {
    expect(Object.keys(INTERNAL).sort()).toEqual(coveredBy("internal"));
    expect(Object.keys(INTERNAL)).toHaveLength(11);
    for (const [key, input] of Object.entries(INTERNAL))
      for (const who of [p.alice, p.bot])
        expect(await deniedBy(p.call(functionOf(key))(await input(p), as(who))), `${key} by ${who.name}`).toEqual(["internal"]);
  }));

  test("every gated write by a collaborator with no membership is refused by isMember, and by every other policy that fails it", () => populated(async (p) => {
    expect(Object.keys(GATED).sort()).toEqual(coveredBy("isMember"));
    for (const [key, { input, denied }] of Object.entries(GATED))
      expect(await deniedBy(p.call(functionOf(key))(await input(p), as(p.otto))), key).toEqual(denied);
  }));
});

type Call = (input: object, context: ActionContext) => Promise<unknown>;
type Populated = Empty & Awaited<ReturnType<typeof populate>> & {
  /** A collaborator with no membership. */
  readonly otto: { readonly id: string };
  /** A guest. */
  readonly gail: { readonly id: string };
  /** The action or read function named `name`. */
  readonly call: (name: string) => Call;
};

/** `populate`'s workspace, a row of every entity, with Otto (no membership) and Gail (a guest); the database closes after `body`. */
async function populated<T>(body: (p: Populated) => Promise<T>): Promise<T> {
  const base = await empty();
  try {
    const rows = await populate(base);
    const otto = await base.hyper.registerCollaborator({ kind: "human", name: "Otto" }, as(rows.alice));
    const gail = await base.hyper.registerCollaborator({ kind: "human", name: "Gail" }, as(rows.alice));
    await base.hyper.grantMembership({ collaborator: gail.id, role: "guest" }, as(rows.alice));
    const functions = base.hyper as unknown as Record<string, Call | undefined>;
    const call = (name: string): Call => functions[name] ?? ((): never => { throw new Error(`no function ${name}`); });
    return await body({ ...base, ...rows, otto, gail, call });
  } finally {
    await base.db.close();
  }
}

/** The generated function of `Entity.action`: `completeTask` for `Task.complete`. */
const functionOf = (key: string) => {
  const [entity, action] = key.split(".") as [string, string];
  return `${action}${entity}`;
};

/** Every `Entity.action` that the policy `name` covers, sorted. */
const coveredBy = (name: string) => model.entities.flatMap((entity) => entity.actions
  .filter((action) => covering(entity.name, action.name).some((policy) => policy.name === name))
  .map((action) => `${entity.name}.${action.name}`)).sort();

/** The input of each internal action over `populate`'s rows; any input that casts would do, since `internal` reads only `context`. */
const INTERNAL: Record<string, (p: Populated) => object | Promise<object>> = {
  "Event.record": (p) => eventOf(2, { recordId: p.task.id }),
  "Machine.report": () => ({ name: "desktop" }),
  "Run.settle": (p) => ({ id: p.run.id, result: "succeeded" }),
  "Assignment.start": (p) => ({ task: p.task.id, assignee: p.bot.id }),
  "Assignment.finish": async (p) => ({ id: (await one(p.hyper.readAssignment({ filter: { taskId: { eq: p.child.id } } }, asSystem(p.alice)))).id, reason: "unassigned" }),
  "Claim.expire": (p) => ({ id: p.claim.id }),
  "Claim.end": (p) => ({ id: p.claim.id, outcome: "expired", reason: "lease expired" }),
  "Completion.record": (p) => ({ rule: "performer-is-reviewer", task: p.task.id }),
  "Submission.settle": (p) => ({ id: p.submission.id, outcome: "returned" }),
  "Submission.recordAccepted": (p) => ({ task: p.task.id, taskVersion: 1 }),
  "Task.touch": (p) => ({ id: p.task.id }),
};

const GATE = ["isMember", "ownerOrMember"];
const OWNERS = ["isMember", "ownerOnly"];

/**
 * Every write `isMember` covers, with an input over `populate`'s rows and the full list of policies that refuse a
 * collaborator with no membership (N2): the gate, and each relationship check it fails too (the port's checks fail
 * closed). `claimAssignee` admits it, so a missing Task answers as an existing one; Task `complete` without a fence
 * and with no live claim passes `claimHolder`.
 */
const GATED: Record<string, { readonly input: (p: Populated) => object; readonly denied: readonly string[] }> = {
  "Workspace.create": { input: () => ({ name: "Mine" }), denied: OWNERS },
  "Workspace.rename": { input: (p) => ({ id: p.workspace.id, name: "Mine" }), denied: OWNERS },
  "Collaborator.register": { input: () => ({ kind: "agent", name: "sneaky" }), denied: OWNERS },
  "Collaborator.update": { input: (p) => ({ id: p.alice.id, name: "hijack" }), denied: ["isMember", "collaboratorSelfOrOwner"] },
  "Collaborator.retire": { input: (p) => ({ id: p.bot.id }), denied: OWNERS },
  "Membership.grant": { input: (p) => ({ collaborator: p.otto.id, role: "owner" }), denied: OWNERS },
  "Membership.changeRole": { input: (p) => ({ id: p.botMembership.id, role: "owner" }), denied: OWNERS },
  "Membership.revoke": { input: (p) => ({ id: p.botMembership.id }), denied: OWNERS },
  "Task.create": { input: () => ({ title: "x" }), denied: GATE },
  "Task.update": { input: (p) => ({ id: p.task.id, title: "x" }), denied: GATE },
  "Task.setPriority": { input: (p) => ({ id: p.task.id, priority: 1 }), denied: GATE },
  "Task.move": { input: (p) => ({ id: p.child.id, parent: null }), denied: GATE },
  "Task.assign": { input: (p) => ({ id: p.task.id, assignee: p.otto.id }), denied: GATE },
  "Task.complete": { input: (p) => ({ id: p.task.id }), denied: GATE },
  "Task.cancel": { input: (p) => ({ id: p.task.id, reason: "x" }), denied: [...GATE, "taskManager"] },
  "Task.reopen": { input: (p) => ({ id: p.child.id, reason: "x" }), denied: [...GATE, "taskManager"] },
  "Task.unassign": { input: (p) => ({ id: p.child.id }), denied: [...GATE, "taskUnassigner"] },
  "Claim.acquire": { input: (p) => ({ task: p.task.id }), denied: GATE },
  "Claim.renew": { input: (p) => ({ id: p.claim.id, fence: p.claim.fence }), denied: [...GATE, "claimHolder"] },
  "Claim.release": { input: (p) => ({ id: p.claim.id, fence: p.claim.fence }), denied: [...GATE, "claimHolder"] },
  "Claim.revoke": { input: (p) => ({ id: p.claim.id, reason: "x" }), denied: [...GATE, "claimRevoker"] },
  "Submission.submit": { input: (p) => ({ task: p.task.id, fence: p.claim.fence, summary: "x" }), denied: [...GATE, "claimHolder"] },
  "Submission.withdraw": { input: (p) => ({ id: p.submission.id }), denied: [...GATE, "submissionSubmitter"] },
  "Review.accept": { input: (p) => ({ submission: p.submission.id }), denied: [...GATE, "reviewReviewer"] },
  "Review.return": { input: (p) => ({ submission: p.submission.id, reasons: "x" }), denied: [...GATE, "reviewReviewer"] },
  "Dependency.add": { input: (p) => ({ dependent: p.child.id, prerequisite: p.task.id }), denied: GATE },
  "Dependency.remove": { input: (p) => ({ id: p.dependency.id }), denied: GATE },
  "EvidenceReference.record": { input: () => ({ kind: "link", locator: "https://example.com" }), denied: GATE },
  "LateResult.record": { input: (p) => ({ task: p.task.id, fence: p.claim.fence }), denied: GATE },
  "Run.start": { input: (p) => ({ task: p.task.id }), denied: GATE },
  "Run.cancel": { input: (p) => ({ id: p.run.id, reason: "x" }), denied: [...GATE, "runCanceler"] },
  "Attempt.start": { input: (p) => ({ run: p.run.id }), denied: [...GATE, "attemptClaimer"] },
  "Invocation.record": { input: (p) => ({ attempt: p.attempt.id, usageSource: "runtime" }), denied: [...GATE, "attemptPerformer"] },
  "Invocation.correct": { input: (p) => ({ corrects: p.invocation.id, reason: "x", usageSource: "estimate" }), denied: [...GATE, "invocationRecorder"] },
  "SessionReference.record": { input: (p) => ({ runtime: "claude", runtimeSessionId: "s-9", availability: "complete", machine: p.machine.id, agentProfile: p.bot.id }), denied: GATE },
  "SessionReference.redact": { input: (p) => ({ id: p.session.id, reason: "x" }), denied: OWNERS },
  "Machine.register": { input: () => ({ name: "desktop" }), denied: GATE },
  "Machine.update": { input: (p) => ({ id: p.machine.id, platform: "mac" }), denied: OWNERS },
  "Machine.retire": { input: (p) => ({ id: p.machine.id, reason: "x" }), denied: OWNERS },
};

/** Everything a refused call's `ForbiddenError` says, to compare two refusals; any other outcome fails the test. */
async function denialOf(call: Promise<unknown>) {
  const error = await call.then(() => null, (cause: unknown) => cause);
  if (!(error instanceof ForbiddenError)) throw new Error(`expected a ForbiddenError, got ${String(error)}`);
  const { name, code, message, entity, action, policies, reason, breakdown } = error;
  return { name, code, message, entity, action, policies, reason, breakdown };
}

// Hyper's policies as the generated actions pass them to `authorizer`, rebuilt from `.mesh/model.json` and the entity's
// expressions module, for acceptance tests (2) and (7).
interface ModelCheck { readonly params: readonly string[]; readonly plain?: unknown; readonly source: string }
interface ModelPolicy {
  readonly name: string;
  readonly types?: readonly string[];
  readonly actions?: readonly { readonly name: string }[];
  readonly authorizeIf?: readonly ModelCheck[];
  readonly forbidIf?: readonly ModelCheck[];
}
interface ModelEntity { readonly name: string; readonly fqn: string; readonly actions: readonly { readonly name: string; readonly kind: string }[]; readonly policies: readonly ModelPolicy[] }
const model = JSON.parse(readFileSync(resolve(import.meta.dir, "../.mesh/model.json"), "utf8")) as { readonly entities: readonly ModelEntity[] };

/** The policies of `entity` that cover `action` by their scope: `actions=` names it, `types=` names its kind, or neither is set. */
function covering(entity: string, action: string): readonly ModelPolicy[] {
  const declared = model.entities.find((candidate) => candidate.name === entity)!;
  const kind = action === "read" ? "read" : declared.actions.find((candidate) => candidate.name === action)!.kind;
  return declared.policies.filter((policy) =>
    policy.actions ? policy.actions.some((named) => named.name === action) : policy.types ? policy.types.includes(kind) : true);
}

function specsOf(entity: string, action: string, expressions: object): PolicySpec[] {
  const functions = expressions as Record<string, PolicyCheckSpec["run"]>;
  const checks = (policy: ModelPolicy, kind: PolicyCheckSpec["kind"], list: readonly ModelCheck[] = []) => list.map((check, n): PolicyCheckSpec => ({
    kind,
    check: check.source,
    // As M8a decides: a check that reads `self` or `tx`, or plain code, runs inside the transaction.
    record: check.params.includes("self") || check.params.includes("tx") || check.plain !== undefined,
    run: functions[`policy.${policy.name}.${kind}.${n}`]!,
  }));
  return covering(entity, action).map((policy) => ({
    name: policy.name,
    when: null,
    checks: [...checks(policy, "authorize-if", policy.authorizeIf), ...checks(policy, "forbid-if", policy.forbidIf)],
  }));
}

/** The declared order, the policies reversed, each policy's checks reversed, and both. */
function orders(policies: readonly PolicySpec[]): PolicySpec[][] {
  const flipped = policies.map((policy) => ({ ...policy, checks: [...policy.checks].reverse() }));
  return [[...policies], [...policies].reverse(), flipped, [...flipped].reverse()];
}

/** No transaction is running: a denial rejects the call. */
const layer = { refuseIfFailed: () => false } as unknown as DataLayer;

/** The decision of `authorizer` over the policies in this order: "allowed", or the refusing policies in a fixed order. */
async function decide(entity: string, action: string, policies: readonly PolicySpec[], scope: object): Promise<string> {
  const policy = authorizer(model.entities.find((candidate) => candidate.name === entity)!.fqn, action, policies);
  try {
    await policy.before(layer, scope);
    await policy.inside(scope);
    return "allowed";
  } catch (cause) {
    if (!(cause instanceof ForbiddenError)) throw cause;
    // `policies` follows the order given; the declared order makes answers from different orders comparable.
    const declared = covering(entity, action).map((spec) => spec.name);
    return [...cause.policies].sort((a, b) => declared.indexOf(a) - declared.indexOf(b)).join(",");
  }
}
