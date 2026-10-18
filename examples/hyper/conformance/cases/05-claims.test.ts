/**
 * Group 05 — claims, leases and fencing.
 * Enforces: domain/core/claim.md#lease, #fencing, #revocation, #rules, #commands, #events;
 * architecture/execution-and-accountability.md#claims; domain/core/submission.md#rules (rule 4: stale fence);
 * implementation/acceptance-cases.md#heart cases 4 (claim race) and 5 (stale worker).
 */
import { expect, test } from "bun:test";
import type { Event } from "../schemas/protocol.ts";
import { E, expectRejected, suite, types, until, useWorld, type World } from "./_setup.ts";

suite("05.1 acquire, renew, release, revoke [domain/core/claim.md#commands]", () => {
  const w = useWorld();

  test("claim.acquire on an unassigned ready Task: fence 1, lease, and the claimer becomes assignee", async () => {
    const a = await w().add("agent");
    const t = await w().owner.create("Ready", { intent: "x" });
    const before = Date.now();
    const r = await a.do("claim.acquire", { taskId: t.id });
    expect(types(r.events)).toEqual(["claim.acquired", "assignment.started"]);
    expect(r.claim).toMatchObject({ taskId: t.id, holderId: a.id, fence: 1, state: "active" });
    const lease = Date.parse(r.claim.expiresAt) - before;
    expect(lease).toBeGreaterThan(9 * 60_000); // default 10 minutes
    expect(lease).toBeLessThan(11 * 60_000);
    expect(r.events[0]!.payload).toMatchObject({ claimId: r.claim.id, taskId: t.id, holderId: a.id, fence: 1 });
    expect(r.events[1]!.payload).toMatchObject({ assigneeId: a.id, delegatorId: a.id, reviewWaived: false });
    expect(r.task).toMatchObject({ derived: { state: "claimed" }, assignment: { assigneeId: a.id }, activeClaim: { fence: 1 } });
    expect(r.events.every((e) => e.record.version === r.task.version)).toBe(true);
  });

  test("an assigned Task can be claimed only by its assignee (claim.assignee); a claimed Task is not ready (claim.task-ready)", async () => {
    const o = w().owner;
    const a = await w().add("assignee");
    const b = await w().add("stranger");
    const t = await o.create("Assigned", { intent: "x" });
    await o.do("task.assign", { taskId: t.id, assigneeId: a.id });
    await expectRejected(b.do("claim.acquire", { taskId: t.id }), E.permissionDenied, "claim.assignee");
    const r = await a.do("claim.acquire", { taskId: t.id });
    expect(types(r.events)).toEqual(["claim.acquired"]);
    await expectRejected(a.do("claim.acquire", { taskId: t.id }), E.ruleViolation, "claim.task-ready");
  });

  test("claim.renew moves the expiry forward; wrong fence (claim.current-fence) and non-holder (claim.holder) are rejected", async () => {
    const a = await w().add("renewer");
    const b = await w().add("other");
    const t = await w().owner.create("Renewable", { intent: "x" });
    const { claim } = await a.do("claim.acquire", { taskId: t.id });
    await Bun.sleep(20);
    const r = await a.do("claim.renew", { taskId: t.id, fence: claim.fence });
    expect(Date.parse(r.claim.expiresAt)).toBeGreaterThan(Date.parse(claim.expiresAt));
    expect(types(r.events)).toEqual(["claim.renewed"]);
    expect(r.events[0]!.payload).toEqual({ claimId: claim.id, fence: claim.fence, expiresAt: r.claim.expiresAt });
    await expectRejected(a.do("claim.renew", { taskId: t.id, fence: claim.fence + 1 }), E.ruleViolation, "claim.current-fence");
    await expectRejected(b.do("claim.renew", { taskId: t.id, fence: claim.fence }), E.permissionDenied, "claim.holder");
  });

  test("claim.release ends the claim; the Task is ready again for its assignee; renewal cannot revive; the next claim gets fence 2", async () => {
    const a = await w().add("releaser");
    const t = await w().owner.create("Releasable", { intent: "x" });
    const { claim } = await a.do("claim.acquire", { taskId: t.id });
    const r = await a.do("claim.release", { taskId: t.id, fence: claim.fence, reason: "blocked on credentials" });
    expect(types(r.events)).toEqual(["claim.released"]);
    expect(r.claim.state).toBe("released");
    expect(r.task).toMatchObject({ derived: { state: "ready" }, activeClaim: null, assignment: { assigneeId: a.id } });
    await expectRejected(a.do("claim.renew", { taskId: t.id, fence: claim.fence }), E.ruleViolation, "claim.active");
    const again = await a.do("claim.acquire", { taskId: t.id });
    expect(again.claim.fence).toBe(2);
  });

  test("claim.revoke: by the delegator or an owner, not by another member (claim.revoker)", async () => {
    const lead = await w().add("lead");
    const a = await w().add("worker");
    const other = await w().add("bystander");
    const t = await lead.create("Revocable", { intent: "x" });
    await lead.do("task.assign", { taskId: t.id, assigneeId: a.id });
    const { claim } = await a.do("claim.acquire", { taskId: t.id });
    await expectRejected(other.do("claim.revoke", { taskId: t.id, reason: "mine" }), E.permissionDenied, "claim.revoker");
    const r = await lead.do("claim.revoke", { taskId: t.id, reason: "wrong approach" });
    expect(r.events[0]!.payload).toEqual({ claimId: claim.id, fence: claim.fence, revokedBy: lead.id, reason: "wrong approach" });
    expect(r.claim.state).toBe("revoked");
    await expectRejected(lead.do("claim.revoke", { taskId: t.id, reason: "again" }), E.ruleViolation, "claim.active");
    const { claim: c2 } = await a.do("claim.acquire", { taskId: t.id });
    await w().owner.do("claim.revoke", { taskId: t.id, reason: "owner intervenes" });
    expect(c2.fence).toBe(2);
  });

  test("reassigning or canceling revokes the active claim in the same change", async () => {
    const o = w().owner;
    const a = await w().add("a");
    const b = await w().add("b");
    const t = await o.create("Handover", { intent: "x" });
    await o.do("task.assign", { taskId: t.id, assigneeId: a.id });
    await a.do("claim.acquire", { taskId: t.id });
    const re = await o.do("task.assign", { taskId: t.id, assigneeId: b.id });
    expect(types(re.events)).toEqual(["claim.revoked", "assignment.ended", "assignment.started"]);
    expect(re.events[1]!.payload).toMatchObject({ formerAssigneeId: a.id, endReason: "reassigned" });
    await b.do("claim.acquire", { taskId: t.id });
    const c = await o.do("task.cancel", { taskId: t.id, reason: "stop" });
    expect(types(c.events)).toEqual(["claim.revoked", "task.canceled"]);
  });

  test("task.unassign: assignee, delegator or owner; ends the assignment and revokes the assignee's claim", async () => {
    const o = w().owner;
    const a = await w().add("a2");
    const other = await w().add("other2");
    const t = await o.create("Unassign me", { intent: "x" });
    await o.do("task.assign", { taskId: t.id, assigneeId: a.id });
    await a.do("claim.acquire", { taskId: t.id });
    await expectRejected(other.do("task.unassign", { taskId: t.id }), E.permissionDenied, "task.manager");
    const r = await a.do("task.unassign", { taskId: t.id, reason: "overloaded" });
    expect(types(r.events)).toEqual(["claim.revoked", "assignment.ended"]);
    expect(r.events[1]!.payload).toMatchObject({ formerAssigneeId: a.id, endReason: "unassigned" });
    expect(r.task).toMatchObject({ assignment: null, activeClaim: null, derived: { state: "ready" } });
    await expectRejected(o.do("task.unassign", { taskId: t.id }), E.ruleViolation, "assignment.current");
    const h = (await o.task(t.id)).history;
    expect(h.assignments).toHaveLength(1);
    expect(h.assignments[0]!.endReason).toBe("unassigned");
  });

  test("parent and child claims are independent", async () => {
    const o = w().owner;
    const p = await o.create("P", { intent: "x" });
    const c = await o.create("C", { parentId: p.id, intent: "x" });
    const r = await o.do("claim.acquire", { taskId: p.id });
    expect(r.events.every((e) => e.taskId === p.id)).toBe(true);
    expect((await o.task(c.id)).task.derived.state).toBe("ready");
    await o.do("claim.acquire", { taskId: c.id });
  });
});

suite("05.2 claim race — case 4 [domain/core/claim.md#rules]", () => {
  const w = useWorld();

  test("eight agents claim the same ready Task at once on separate connections: exactly one wins", async () => {
    const t = await w().owner.create("Contested", { intent: "x" });
    const agents = await Promise.all(Array.from({ length: 8 }, (_, i) => w().add(`racer${i}`)));
    const conns = await Promise.all(agents.map((a) => a.reconnect()));
    const rs = await Promise.allSettled(conns.map((a) => a.do("claim.acquire", { taskId: t.id })));
    const wins = rs.filter((r) => r.status === "fulfilled");
    expect(wins).toHaveLength(1);
    for (const r of rs) if (r.status === "rejected") expect([E.permissionDenied, E.ruleViolation]).toContain(r.reason.code);
    const winner = (wins[0] as PromiseFulfilledResult<{ claim: { holderId: string } }>).value.claim.holderId;
    const now = (await w().owner.task(t.id)).task;
    expect(now.activeClaim?.holderId).toBe(winner);
    const acquired = (await w().events(0, { taskSubtree: t.id, types: ["claim.acquired"] }));
    expect(acquired).toHaveLength(1);
  });

  test("race on an assigned Task between its assignee's two connections: one wins, the other gets claim.task-ready", async () => {
    const a = await w().add("double");
    const t = await w().owner.create("Double", { intent: "x" });
    await w().owner.do("task.assign", { taskId: t.id, assigneeId: a.id });
    const a2 = await a.reconnect();
    const rs = await Promise.allSettled([a.do("claim.acquire", { taskId: t.id }), a2.do("claim.acquire", { taskId: t.id })]);
    expect(rs.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const lost = rs.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect([lost.reason.code, lost.reason.phase]).toEqual([E.ruleViolation, "content"]);
    expect(lost.reason.failures.some((f: { check?: string }) => f.check === "claim.task-ready")).toBe(true);
  });
});

const LEASE_MS = 400;
/** The contract (PROTOCOL.md#behavior): claim.expired is recorded no later than 1000 ms after expiresAt. */
const EXPIRY_CONTRACT_MS = 1000;
/** Test-side allowance for delivering the notification over the socket and scheduling this process; not part of the contract. */
const DELIVERY_ALLOWANCE_MS = 250;

/**
 * Subscribes to claim.expired for one Task (without touching the Task) and, when it arrives, checks when it was
 * *recorded* and when it was *delivered* against the claim's expiresAt — never its occurredAt, which an engine
 * could backdate.
 */
async function waitExpired(w: World, taskId: string): Promise<Event[]> {
  const conn = await w.owner.reconnect();
  let arrived: { event: Event; at: number } | undefined;
  conn.client.onNotification((m, p) => {
    if (m === "events.event" && p.event.type === "claim.expired" && !arrived) arrived = { event: p.event, at: Date.now() };
  });
  try {
    await conn.query("events.subscribe", { after: 0, taskSubtree: taskId, types: ["claim.expired"] });
    const got = await until(async () => arrived, LEASE_MS + EXPIRY_CONTRACT_MS + DELIVERY_ALLOWANCE_MS + 2000, 10);
    const claim = (await w.owner.task(taskId)).history.claims.find((c) => c.fence === (got.event.payload as { fence: number }).fence)!;
    const expiresAt = Date.parse(claim.expiresAt);
    expect(Date.parse(got.event.recordedAt) - expiresAt).toBeLessThanOrEqual(EXPIRY_CONTRACT_MS);
    expect(Date.parse(got.event.recordedAt)).toBeGreaterThanOrEqual(expiresAt);
    expect(got.at - expiresAt).toBeLessThanOrEqual(EXPIRY_CONTRACT_MS + DELIVERY_ALLOWANCE_MS);
    return [got.event];
  } finally {
    await conn.client.close();
  }
}

suite("05.3 lease expiry and stale workers — case 5 [domain/core/claim.md#lease, #fencing]", () => {
  const w = useWorld({ leaseMs: LEASE_MS });

  test("--lease-ms sets the lease; the engine emits claim.expired on its own, as the engine, with the expiry rule as cause", async () => {
    const a = await w().add("sleepy");
    const t = await w().owner.create("Will expire", { intent: "x" });
    const { claim } = await a.do("claim.acquire", { taskId: t.id });
    const lease = Date.parse(claim.expiresAt) - Date.parse(claim.acquiredAt);
    expect(lease).toBeGreaterThanOrEqual(LEASE_MS - 5);
    expect(lease).toBeLessThanOrEqual(LEASE_MS + 50);
    const [ev] = await waitExpired(w(), t.id);
    expect(ev!.actor).toBe("engine");
    expect(ev!.cause).toMatchObject({ kind: "rule" });
    expect(ev!.payload).toMatchObject({ claimId: claim.id, fence: claim.fence });
    const now = (await w().owner.task(t.id)).task;
    expect(now).toMatchObject({ activeClaim: null, derived: { state: "ready" }, assignment: { assigneeId: a.id } });
    await expectRejected(a.do("claim.renew", { taskId: t.id, fence: claim.fence }), E.ruleViolation, "claim.expired");
    await expectRejected(a.do("claim.release", { taskId: t.id, fence: claim.fence }), E.ruleViolation, "claim.expired");
  }, 10_000);

  test("renewing just after expiresAt is rejected with claim.expired even before claim.expired is emitted", async () => {
    const a = await w().add("just-late");
    const t = await w().owner.create("Just late", { intent: "x" });
    const { claim } = await a.do("claim.acquire", { taskId: t.id });
    await Bun.sleep(Math.max(0, Date.parse(claim.expiresAt) - Date.now()) + 20);
    await expectRejected(a.do("claim.renew", { taskId: t.id, fence: claim.fence }), E.ruleViolation, "claim.expired");
    expect((await a.task(t.id)).task.activeClaim).toBeNull();
  }, 10_000);

  test("one phase, several failures: renewing an expired claim with a wrong fence may report claim.expired, claim.current-fence, or both (content)", async () => {
    const a = await w().add("late-and-wrong");
    const t = await w().owner.create("Expired and fenced", { intent: "x" });
    const { claim } = await a.do("claim.acquire", { taskId: t.id });
    await Bun.sleep(Math.max(0, Date.parse(claim.expiresAt) - Date.now()) + 20);
    // Both checks are content-phase failures; the engine may return one or both. Extras are tolerated.
    await expectRejected(a.do("claim.renew", { taskId: t.id, fence: claim.fence + 9 }), E.ruleViolation, ["claim.expired", "claim.current-fence"]);
  }, 10_000);

  test("stale worker: A's claim expires, B claims with a new fence, A's late submission is recorded as claim.late-result-recorded and changes nothing", async () => {
    const o = w().owner;
    const a = await w().add("agent-a");
    const b = await w().add("agent-b");
    const t = await o.create("Contested work", { intent: "x" });
    await o.do("task.assign", { taskId: t.id, assigneeId: a.id });
    const { claim: ca } = await a.do("claim.acquire", { taskId: t.id });
    await waitExpired(w(), t.id);
    await o.do("task.assign", { taskId: t.id, assigneeId: b.id });
    const { claim: cb } = await b.do("claim.acquire", { taskId: t.id });
    expect(cb.fence).toBe(ca.fence + 1);
    // Renew B so the lease does not run out mid-test.
    await b.do("claim.renew", { taskId: t.id, fence: cb.fence });

    const before = (await o.task(t.id)).task;
    const { evidenceReference } = await a.do("evidence-reference.record", { kind: "report", locator: "file:///tmp/a-report.md" });
    const late = await a.do("submission.submit", { taskId: t.id, fence: ca.fence, summary: "my late result", evidence: [evidenceReference.id] });
    expect(late.outcome).toBe("late-result-recorded");
    expect(types(late.events)).toEqual(["claim.late-result-recorded"]);
    expect(late.events[0]!.payload).toMatchObject({ fence: ca.fence, submitterId: a.id, summary: "my late result", evidence: [evidenceReference.id] });
    expect(late.events[0]!.record.version).toBe(before.version);

    const after = await o.task(t.id);
    expect(after.task.version).toBe(before.version);
    expect(after.task.pendingSubmission).toBeNull();
    expect(after.task.activeClaim?.holderId).toBe(b.id);
    expect(after.history.lateResults).toHaveLength(1);
    expect(after.history.submissions).toHaveLength(0);
    // A stale fence cannot complete either: recorded as a late result even though B holds the claim now.
    const lateComplete = await a.do("task.complete", { taskId: t.id, fence: ca.fence });
    expect(lateComplete.outcome).toBe("late-result-recorded");
    expect(types(lateComplete.events)).toEqual(["claim.late-result-recorded"]);
    expect((await o.task(t.id)).task).toMatchObject({ state: "open", version: before.version });
    // B's submission still works.
    await b.do("claim.renew", { taskId: t.id, fence: cb.fence });
    const ok = await b.do("submission.submit", { taskId: t.id, fence: cb.fence, summary: "on time" });
    expect(ok.outcome).toBe("submitted");
  }, 15_000);

  for (const how of ["expired", "revoked"] as const) {
    test(`stale completion with no replacement claim (${how}): the fenced complete is a late result; an unfenced one is claim.invalidated`, async () => {
      const o = w().owner;
      const a = await w().add(`solo-${how}`);
      const t = await a.create(`Solo ${how}`, { intent: "x" }); // a is creator and reviewer: no review needed
      const { claim } = await a.do("claim.acquire", { taskId: t.id });
      if (how === "expired") await waitExpired(w(), t.id);
      else await o.do("claim.revoke", { taskId: t.id, reason: "intervene" });
      const version = (await a.task(t.id)).task.version;

      const late = await a.do("task.complete", { taskId: t.id, fence: claim.fence, summary: "finished anyway" });
      if (late.outcome !== "late-result-recorded") throw new Error("expected a late result");
      expect(types(late.events)).toEqual(["claim.late-result-recorded"]);
      expect(late.lateResult).toMatchObject({ fence: claim.fence, submitterId: a.id, summary: "finished anyway" });
      const noSummary = await a.do("task.complete", { taskId: t.id, fence: claim.fence });
      if (noSummary.outcome !== "late-result-recorded") throw new Error("expected a late result");
      expect(noSummary.lateResult.summary).toBeNull();

      const e = await expectRejected(a.do("task.complete", { taskId: t.id }), E.ruleViolation, "claim.invalidated");
      expect(e.failures!.find((x) => x.check === "claim.invalidated")!.details?.fences).toEqual([claim.fence]);
      const now = (await a.task(t.id)).task;
      expect(now).toMatchObject({ state: "open", version });

      // Claiming again gives a current fence, which completes.
      const again = await a.do("claim.acquire", { taskId: t.id });
      const done = await a.complete({ taskId: t.id, fence: again.claim.fence });
      expect(done.task.state).toBe("done");
      // After a reopen, the old invalidated claim no longer blocks an unfenced completion.
      await a.do("task.reopen", { taskId: t.id, reason: "one more thing" });
      expect((await a.complete({ taskId: t.id })).task.state).toBe("done");
    }, 10_000);
  }

  test("a result under a revoked fence is also a late result; a fence the actor never held is claim.current-fence", async () => {
    const o = w().owner;
    const a = await w().add("revoked-worker");
    const t = await o.create("Revoked", { intent: "x" });
    const { claim } = await a.do("claim.acquire", { taskId: t.id });
    await o.do("claim.revoke", { taskId: t.id, reason: "intervene" });
    const r = await a.do("submission.submit", { taskId: t.id, fence: claim.fence, summary: "late" });
    expect(r.outcome).toBe("late-result-recorded");
    await expectRejected(a.do("submission.submit", { taskId: t.id, fence: 42, summary: "made up" }), E.ruleViolation, "claim.current-fence");
  });

  test("expiry happens without any traffic on the Task, and the Task is claimable again", async () => {
    const a = await w().add("idle");
    const t = await w().owner.create("Idle", { intent: "x" });
    const { claim } = await a.do("claim.acquire", { taskId: t.id });
    await waitExpired(w(), t.id); // subscribes only: no command touches the Task
    const ev = await w().events(0, { taskSubtree: t.id, types: ["claim.expired"] });
    expect(ev).toHaveLength(1);
    const again = await a.do("claim.acquire", { taskId: t.id });
    expect(again.claim.fence).toBe(claim.fence + 1);
  }, 10_000);

  test("renewing before expiry keeps the claim alive past the original lease", async () => {
    const a = await w().add("heartbeat");
    const t = await w().owner.create("Heartbeat", { intent: "x" });
    const { claim } = await a.do("claim.acquire", { taskId: t.id });
    for (let i = 0; i < 4; i++) {
      await Bun.sleep(LEASE_MS / 2);
      await a.do("claim.renew", { taskId: t.id, fence: claim.fence });
    }
    expect((await a.task(t.id)).task.activeClaim?.fence).toBe(claim.fence);
    expect(await w().events(0, { taskSubtree: t.id, types: ["claim.expired"] })).toHaveLength(0);
  }, 10_000);
});
