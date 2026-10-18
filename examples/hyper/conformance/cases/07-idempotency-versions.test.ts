/**
 * Group 07 — command IDs and expected versions.
 * Enforces: domain/commands-and-events.md#commands (command ID, expected version, check phases);
 * domain/core/task.md#attributes (version increments on every change); PROTOCOL.md#idempotency;
 * implementation/acceptance-cases.md#heart case 9 (retry).
 */
import { expect, test } from "bun:test";
import { E, newCommandId, expectRejected, suite, types, useWorld } from "./_setup.ts";

suite("07.1 idempotent command IDs — case 9 [domain/commands-and-events.md#commands]", () => {
  const w = useWorld();

  test("resending a command with the same ID and content returns the first result and has one effect", async () => {
    const o = w().owner;
    const commandId = newCommandId("retry");
    const first = await o.do("task.create", { title: "Exactly once" }, { commandId });
    const head = await w().head();
    const second = await o.do("task.create", { title: "Exactly once" }, { commandId });
    expect(second).toEqual(first);
    expect(await w().head()).toBe(head);
    const all = (await o.query("task.list", {})).tasks.filter((t) => t.title === "Exactly once");
    expect(all).toHaveLength(1);
  });

  test("a retry after a lost response (new connection) returns the first result", async () => {
    const o = w().owner;
    const commandId = newCommandId("lost");
    const first = await o.do("task.create", { title: "Lost response" }, { commandId });
    const o2 = await o.reconnect();
    const again = await o2.do("task.create", { title: "Lost response" }, { commandId });
    expect(again.task.id).toBe(first.task.id);
    expect(again.events.map((e) => e.id)).toEqual(first.events.map((e) => e.id));
  });

  test("the same ID with different content, or for another method, is rejected (idempotency_conflict)", async () => {
    const o = w().owner;
    const commandId = newCommandId("conflict");
    const { task } = await o.do("task.create", { title: "Original" }, { commandId });
    await expectRejected(o.do("task.create", { title: "Different" }, { commandId }), E.idempotencyConflict, "command-id");
    await expectRejected(o.do("task.update", { taskId: task.id, title: "Other method" }, { commandId }), E.idempotencyConflict);
    const other = await w().add("other");
    await expectRejected(other.do("task.create", { title: "Original" }, { commandId }), E.idempotencyConflict);
    expect((await o.task(task.id)).task.title).toBe("Original");
  });

  test("concurrent duplicates of one command have one effect", async () => {
    const o = w().owner;
    const o2 = await o.reconnect();
    const commandId = newCommandId("dup");
    const [a, b] = await Promise.all([
      o.do("task.create", { title: "Concurrent dup" }, { commandId }),
      o2.do("task.create", { title: "Concurrent dup" }, { commandId }),
    ]);
    expect(a.task.id).toBe(b.task.id);
    expect((await o.query("task.list", {})).tasks.filter((t) => t.title === "Concurrent dup")).toHaveLength(1);
  });

  test("a rejected command is not remembered: the same ID can be sent again once the rule holds", async () => {
    const o = w().owner;
    const p = await o.create("Parent");
    const c = await o.create("Child", { parentId: p.id });
    const commandId = newCommandId("later");
    await expectRejected(o.complete({ taskId: p.id }, { commandId }), E.ruleViolation, "task.children-settled");
    await o.do("task.cancel", { taskId: c.id, reason: "skip" });
    const r = await o.complete({ taskId: p.id }, { commandId });
    expect(r.task.state).toBe("done");
  });

  test("a retried claim.acquire returns the same claim, not a rejection", async () => {
    const a = await w().add("claimer");
    const t = await w().owner.create("Claim retry", { intent: "x" });
    const commandId = newCommandId("claim");
    const first = await a.do("claim.acquire", { taskId: t.id }, { commandId });
    const second = await a.do("claim.acquire", { taskId: t.id }, { commandId });
    expect(second.claim).toEqual(first.claim);
  });
});

suite("07.2 versions and expected-version conflicts [domain/commands-and-events.md#commands]", () => {
  const w = useWorld();

  test("the Task version increments once per changing command, and every event of the command carries it", async () => {
    const o = w().owner;
    const a = await w().add("agent");
    const t = await o.create("Versioned", { intent: "x" });
    expect(t.version).toBe(1);
    const u = await o.do("task.update", { taskId: t.id, title: "Versioned 2" });
    expect(u.task.version).toBe(2);
    const c = await a.do("claim.acquire", { taskId: t.id });
    expect(c.task.version).toBe(3);
    expect(c.events.map((e) => e.record.version)).toEqual([3, 3]);
    const rn = await a.do("claim.renew", { taskId: t.id, fence: c.claim.fence });
    expect(rn.events[0]!.record.version).toBe(4);
    expect((await o.task(t.id)).task.version).toBe(4);
  });

  test("a matching expectedVersion succeeds; a stale one is rejected with both versions and changes nothing", async () => {
    const o = w().owner;
    const t = await o.create("Optimistic");
    const ok = await o.do("task.update", { taskId: t.id, title: "v2" }, { expectedVersion: 1 });
    expect(ok.task.version).toBe(2);
    const head = await w().head();
    const e = await expectRejected(o.do("task.update", { taskId: t.id, title: "lost update" }, { expectedVersion: 1 }), E.versionConflict, "expected-version");
    expect(e.failures!.find((f) => f.check === "expected-version")!.details).toMatchObject({ expectedVersion: 1, actualVersion: 2 });
    expect(await w().head()).toBe(head);
    expect((await o.task(t.id)).task.title).toBe("v2");
  });

  test("expectedVersion is checked on the command's target: the dependent for dependency.add, the membership for change-role", async () => {
    const o = w().owner;
    const pre = await o.create("pre");
    const dep = await o.create("dep");
    await expectRejected(o.do("dependency.add", { dependentId: dep.id, prerequisiteId: pre.id }, { expectedVersion: 7 }), E.versionConflict, "expected-version");
    await o.do("dependency.add", { dependentId: dep.id, prerequisiteId: pre.id }, { expectedVersion: 1 });
    const m = await w().add("m");
    await expectRejected(o.do("membership.change-role", { collaboratorId: m.id, role: "guest" }, { expectedVersion: 5 }), E.versionConflict, "expected-version");
    const r = await o.do("membership.change-role", { collaboratorId: m.id, role: "guest" }, { expectedVersion: 1 });
    expect(r.membership.version).toBe(2);
  });

  test("version and entity rules share the content phase: a stale update on a canceled Task may report expected-version, task.open, or both", async () => {
    const o = w().owner;
    const t = await o.create("Canceled soon");
    await o.do("task.cancel", { taskId: t.id, reason: "x" });
    // Both checks fail in the same phase; the engine may return one or both, with either failure's code.
    const e = await o.do("task.update", { taskId: t.id, title: "y" }, { expectedVersion: 1 }).catch((x) => x);
    expect([E.versionConflict, E.ruleViolation]).toContain(e.code);
    expect(e.phase).toBe("content");
    expect(e.failures.some((f: { check?: string }) => ["expected-version", "task.open"].includes(f.check!))).toBe(true);
    // With the current version only the entity rule fails.
    await expectRejected(o.do("task.update", { taskId: t.id, title: "y" }, { expectedVersion: 2 }), E.ruleViolation, "task.open");
  });

  test("rejections are not events", async () => {
    const o = w().owner;
    const head = await w().head();
    await expectRejected(o.do("task.update", { taskId: "missing", title: "x" }), E.notFound);
    await expectRejected(o.do("workspace.create", {}), E.ruleViolation);
    expect(await w().head()).toBe(head);
    expect(types(await w().events(head))).toEqual([]);
  });
});
