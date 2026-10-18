/**
 * Group 02 — collaborators, memberships and permission checks.
 * Enforces: domain/core/membership.md#roles, #rules, #commands; domain/core/collaborator.md#rules, #commands;
 * domain/core/assignment.md#attributes (assignee must be member or owner); domain/commands-and-events.md#commands
 * (check phases: permission before content).
 */
import { expect, test } from "bun:test";
import { E, expectRejected, suite, types, useWorld } from "./_setup.ts";

suite("02.1 guests [domain/core/membership.md#roles]", () => {
  const w = useWorld();

  test("a guest cannot send work commands: permission_denied role", async () => {
    const guest = await w().add("guest", "guest", "human");
    await expectRejected(guest.do("task.create", { title: "not allowed" }), E.permissionDenied, "role");
    const t = await w().owner.create("Owner's task");
    await expectRejected(guest.do("claim.acquire", { taskId: t.id }), E.permissionDenied, "role");
    await expectRejected(guest.do("evidence-reference.record", { kind: "link", locator: "https://example.com" }), E.permissionDenied, "role");
  });

  test("a guest can read (queries need any active membership)", async () => {
    const guest = await w().add("reader", "guest", "human");
    const t = await w().owner.create("Readable");
    expect((await guest.task(t.id)).task.title).toBe("Readable");
    expect((await guest.query("task.list", {})).tasks.length).toBeGreaterThan(0);
    expect((await guest.query("events.read", { after: 0, limit: 5 })).events.length).toBe(5);
  });

  test("a guest cannot be assigned work: rule_violation assignment.assignee-role", async () => {
    const guest = await w().add("g", "guest", "agent");
    const t = await w().owner.create("Work");
    await expectRejected(w().owner.do("task.assign", { taskId: t.id, assigneeId: guest.id }), E.ruleViolation, "assignment.assignee-role");
    expect((await w().owner.task(t.id)).task.assignment).toBeNull();
  });

  test("task.next for a guest is null (a guest may not claim)", async () => {
    const guest = await w().add("g2", "guest");
    await w().owner.create("Ready work");
    expect((await guest.query("task.next", {})).task).toBeNull();
  });

  test("a collaborator with no membership cannot act or read: permission_denied membership", async () => {
    const { collaborator } = await w().owner.do("collaborator.register", { kind: "agent", name: "outsider" });
    await expectRejected(
      w().client.request("task.create", { commandId: "outsider-1", actor: collaborator.id, caller: "t", payload: { title: "x" } }),
      E.permissionDenied,
      "membership",
    );
    const q = await w().client.request("task.list", { actor: collaborator.id, caller: "t" }).catch((x) => x);
    expect([q.code, q.phase]).toEqual([E.permissionDenied, "permission"]);
  });
});

suite("02.2 only owners manage memberships and collaborators [domain/core/membership.md#commands]", () => {
  const w = useWorld();

  test("a member cannot register, grant, change roles, revoke or retire: permission_denied role", async () => {
    const m = await w().add("member");
    const other = await w().add("other");
    await expectRejected(m.do("collaborator.register", { kind: "agent", name: "sneaky" }), E.permissionDenied, "role");
    const { collaborator } = await w().owner.do("collaborator.register", { kind: "agent", name: "fresh" });
    await expectRejected(m.do("membership.grant", { collaboratorId: collaborator.id, role: "member" }), E.permissionDenied, "role");
    await expectRejected(m.do("membership.change-role", { collaboratorId: other.id, role: "owner" }), E.permissionDenied, "role");
    await expectRejected(m.do("membership.change-role", { collaboratorId: m.id, role: "owner" }), E.permissionDenied, "role");
    await expectRejected(m.do("membership.revoke", { collaboratorId: other.id }), E.permissionDenied, "role");
    await expectRejected(m.do("collaborator.retire", { collaboratorId: other.id }), E.permissionDenied, "role");
  });

  test("an owner grants, changes a role and revokes, with events and granted/revoked by", async () => {
    const o = w().owner;
    const { collaborator } = await o.do("collaborator.register", { kind: "human", name: "Ana" });
    const g = await o.do("membership.grant", { collaboratorId: collaborator.id, role: "guest" });
    expect(g.membership).toMatchObject({ role: "guest", state: "active", grantedBy: o.id, collaboratorId: collaborator.id });
    expect(g.events[0]!.payload).toEqual({ collaboratorId: collaborator.id, role: "guest", grantedBy: o.id });
    const c = await o.do("membership.change-role", { collaboratorId: collaborator.id, role: "member" });
    expect(c.membership.role).toBe("member");
    expect(c.events[0]!.payload).toMatchObject({ oldRole: "guest", newRole: "member" });
    const r = await o.do("membership.revoke", { collaboratorId: collaborator.id, reason: "left" });
    expect(r.membership).toMatchObject({ state: "revoked", revokedBy: o.id });
    expect(types(r.events)).toEqual(["membership.revoked"]);
  });

  test("one active membership per collaborator: rule_violation membership.none-active", async () => {
    const m = await w().add("dup");
    await expectRejected(w().owner.do("membership.grant", { collaboratorId: m.id, role: "guest" }), E.ruleViolation, "membership.none-active");
  });

  test("a revoked collaborator returns through a new grant (a new membership)", async () => {
    const m = await w().add("returning");
    const r = await w().owner.do("membership.revoke", { collaboratorId: m.id });
    const g = await w().owner.do("membership.grant", { collaboratorId: m.id, role: "member" });
    expect(g.membership.id).not.toBe(r.membership.id);
    expect((await m.create("back")).title).toBe("back");
  });

  test("the last owner cannot be demoted or revoked: rule_violation membership.last-owner", async () => {
    const o = w().owner;
    await expectRejected(o.do("membership.change-role", { collaboratorId: o.id, role: "member" }), E.ruleViolation, "membership.last-owner");
    await expectRejected(o.do("membership.revoke", { collaboratorId: o.id }), E.ruleViolation, "membership.last-owner");
    await expectRejected(o.do("collaborator.retire", { collaboratorId: o.id }), E.ruleViolation, "membership.last-owner");
  });

  test("a second owner can manage memberships; then the first owner may be demoted", async () => {
    const o2 = await w().add("co-owner", "owner", "human");
    const m = await w().add("managed");
    await o2.do("membership.change-role", { collaboratorId: m.id, role: "guest" });
    const r = await o2.do("membership.change-role", { collaboratorId: w().owner.id, role: "member" });
    expect(r.membership.role).toBe("member");
    await o2.do("membership.change-role", { collaboratorId: w().owner.id, role: "owner" });
  });

  test("collaborator names are unique among active collaborators: rule_violation collaborator.name-unique", async () => {
    await w().owner.do("collaborator.register", { kind: "agent", name: "reviewer-agent" });
    await expectRejected(w().owner.do("collaborator.register", { kind: "human", name: "reviewer-agent" }), E.ruleViolation, "collaborator.name-unique");
  });

  test("collaborator.update: the collaborator itself or an owner; kind never changes", async () => {
    const a = await w().add("renamer");
    const b = await w().add("bystander");
    const r = await a.do("collaborator.update", { collaboratorId: a.id, name: `${a.name}-v2` });
    expect(r.collaborator.name).toBe(`${a.name}-v2`);
    expect(r.events[0]!.payload).toEqual({ changes: { name: { old: a.name, new: `${a.name}-v2` } } });
    await expectRejected(b.do("collaborator.update", { collaboratorId: a.id, name: "hijack" }), E.permissionDenied, "collaborator.self-or-owner");
    await expectRejected(a.do("collaborator.update", { collaboratorId: a.id, kind: "human" }), E.ruleViolation, "collaborator.kind-immutable");
  });

  test("a guest may update its own profile, and only its own (collaborator.self-or-owner)", async () => {
    const guest = await w().add("self-guest", "guest", "human");
    const other = await w().add("someone");
    const r = await guest.do("collaborator.update", { collaboratorId: guest.id, name: `${guest.name}-x` });
    expect(r.collaborator.name).toBe(`${guest.name}-x`);
    await expectRejected(guest.do("collaborator.update", { collaboratorId: other.id, name: "renamed" }), E.permissionDenied, "collaborator.self-or-owner");
  });

  test("changing a role to the one it already has is rejected (membership.unchanged)", async () => {
    const m = await w().add("same-role");
    await expectRejected(w().owner.do("membership.change-role", { collaboratorId: m.id, role: "member" }), E.ruleViolation, "membership.unchanged");
  });

  test("phase precedence: a guest with a stale expectedVersion is rejected by the permission phase; content never runs", async () => {
    const guest = await w().add("early", "guest");
    const t = await w().owner.create("Versioned");
    // role (permission) and expected-version (content) would both fail: the rejection reports the
    // earlier phase, and no expected-version failure can appear because the content phase did not run.
    const e = await expectRejected(guest.do("task.update", { taskId: t.id, title: "x" }, { expectedVersion: 99 }), E.permissionDenied, "role");
    expect(e.failures!.some((f) => f.check === "expected-version")).toBe(false);
  });

  test("one phase, several failures: a guest claiming a Task assigned to someone else may report role, claim.assignee, or both (permission)", async () => {
    const guest = await w().add("grabbing", "guest");
    const worker = await w().add("assigned-worker");
    const t = await w().owner.create("Assigned work", { intent: "x" });
    await w().owner.do("task.assign", { taskId: t.id, assigneeId: worker.id });
    // Both checks are permission-phase failures; the engine may return one or both. Extras are tolerated.
    await expectRejected(guest.do("claim.acquire", { taskId: t.id }), E.permissionDenied, ["role", "claim.assignee"]);
  });
});

suite("02.3 revoking and retiring end active authority [domain/core/membership.md#rules, domain/core/collaborator.md#rules]", () => {
  const w = useWorld();

  test("revoking a membership revokes the collaborator's active claims in the same change; assignments stay", async () => {
    const worker = await w().add("worker");
    const t = await w().owner.create("Claimed work", { intent: "x" });
    await worker.do("claim.acquire", { taskId: t.id });
    const r = await w().owner.do("membership.revoke", { collaboratorId: worker.id, reason: "offboarded" });
    expect(types(r.events)).toEqual(["membership.revoked", "claim.revoked"]);
    expect(r.events[1]!.taskId).toBe(t.id);
    const after = (await w().owner.task(t.id)).task;
    expect(after.activeClaim).toBeNull();
    expect(after.assignment).toMatchObject({ assigneeId: worker.id, endedAt: null, endReason: null });
    await expectRejected(worker.do("task.create", { title: "after revoke" }), E.permissionDenied, "membership");
  });

  test("retiring a collaborator revokes its memberships and claims, keeps its history, and it can no longer act", async () => {
    const worker = await w().add("retiree");
    const t = await w().owner.create("Retiree's work", { intent: "x" });
    await worker.do("claim.acquire", { taskId: t.id });
    const r = await w().owner.do("collaborator.retire", { collaboratorId: worker.id, reason: "model retired" });
    expect(types(r.events)).toEqual(["collaborator.retired", "membership.revoked", "claim.revoked"]);
    expect(r.collaborator.state).toBe("retired");
    const h = (await w().owner.task(t.id)).history;
    expect(h.assignments).toHaveLength(1);
    expect(h.assignments[0]).toMatchObject({ assigneeId: worker.id, endedAt: null });
    expect(h.claims[0]!.holderId).toBe(worker.id);
    expect(h.claims[0]!.state).toBe("revoked");
    await expectRejected(worker.do("task.create", { title: "ghost" }), E.permissionDenied, "membership");
    await expectRejected(w().owner.do("membership.grant", { collaboratorId: worker.id, role: "member" }), E.ruleViolation, "collaborator.active");
  });
});
