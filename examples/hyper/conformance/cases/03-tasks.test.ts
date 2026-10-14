/**
 * Group 03 — Task lifecycle, hierarchy, priority and queries.
 * Enforces: domain/core/task.md#states, #rules, #priority, #commands, #events; domain/core/completion.md#rules;
 * implementation/acceptance-cases.md#heart cases 6 (no inheritance), 7 (parent rule), 8 (cycles).
 */
import { expect, test } from "bun:test";
import { E, expectRejected, suite, useWorld } from "./_setup.ts";

suite("03.1 create, update, cancel, reopen [domain/core/task.md#commands]", () => {
  const w = useWorld();

  test("task.create with a parent: the parent must exist (not_found) and be open (task.parent-open)", async () => {
    const o = w().owner;
    await expectRejected(o.do("task.create", { title: "orphan", parentId: "no-such-task" }), E.notFound, "exists");
    const p = await o.create("Closed parent");
    await o.do("task.cancel", { taskId: p.id, reason: "not needed" });
    await expectRejected(o.do("task.create", { title: "child", parentId: p.id }), E.ruleViolation, "task.parent-open");
  });

  test("no-ops are rejected: task.update with nothing that differs (task.unchanged), task.assign to the same assignee (assignment.unchanged)", async () => {
    const o = w().owner;
    const a = await w().add("same");
    const t = await o.create("Same", { intent: "x" });
    await expectRejected(o.do("task.update", { taskId: t.id, title: "Same" }), E.ruleViolation, "task.unchanged");
    await expectRejected(o.do("task.update", { taskId: t.id }), E.ruleViolation, "task.unchanged");
    await o.do("task.assign", { taskId: t.id, assigneeId: a.id });
    await expectRejected(o.do("task.assign", { taskId: t.id, assigneeId: a.id }), E.ruleViolation, "assignment.unchanged");
    const r = await o.do("task.assign", { taskId: t.id, assigneeId: a.id, waiveReview: true });
    expect(r.assignment.reviewWaived).toBe(true);
    expect((await o.task(t.id)).task.version).toBe(3);
  });

  test("one phase, several failures: a no-op update of a canceled Task may report task.open, task.unchanged, or both (content)", async () => {
    const o = w().owner;
    const t = await o.create("No change");
    await o.do("task.cancel", { taskId: t.id, reason: "x" });
    // Both checks are content-phase failures; the engine may return one or both. Extras are tolerated.
    await expectRejected(o.do("task.update", { taskId: t.id }), E.ruleViolation, ["task.open", "task.unchanged"]);
  });

  test("task.cancel/reopen: the assignee, the delegator or an owner — not another member (task.manager)", async () => {
    const lead = await w().add("lead");
    const worker = await w().add("worker");
    const other = await w().add("other");
    const t = await lead.create("Delegated");
    await lead.do("task.assign", { taskId: t.id, assigneeId: worker.id });
    await expectRejected(other.do("task.cancel", { taskId: t.id, reason: "mine now" }), E.permissionDenied, "task.manager");
    await worker.do("task.cancel", { taskId: t.id, reason: "cannot do" });
    await expectRejected(other.do("task.reopen", { taskId: t.id, reason: "x" }), E.permissionDenied, "task.manager");
    await lead.do("task.reopen", { taskId: t.id, reason: "retry" });
  });

  test("the creator may cancel and reopen its Task while it is unassigned, not once someone else delegated it", async () => {
    const maker = await w().add("maker2");
    const other = await w().add("other2");
    const t = await maker.create("Mine, unassigned");
    await expectRejected(other.do("task.cancel", { taskId: t.id, reason: "not yours" }), E.permissionDenied, "task.manager");
    await maker.do("task.cancel", { taskId: t.id, reason: "changed my mind" });
    await maker.do("task.reopen", { taskId: t.id, reason: "changed it back" });
    await w().owner.do("task.assign", { taskId: t.id, assigneeId: other.id });
    await expectRejected(maker.do("task.cancel", { taskId: t.id, reason: "now delegated" }), E.permissionDenied, "task.manager");
  });

  test("unknown Task IDs are not_found", async () => {
    await expectRejected(w().owner.do("task.update", { taskId: "nope", title: "x" }), E.notFound, "exists");
    const e = await w().owner.task("nope").catch((x) => x);
    expect(e.code).toBe(E.notFound);
  });
});

suite("03.2 hierarchy [domain/core/task.md#rules]", () => {
  const w = useWorld();

  test("task.move is rejected while the Task has an active claim (task.no-active-claim)", async () => {
    const o = w().owner;
    const p = await o.create("P");
    const t = await o.create("T", { intent: "x" });
    await o.do("claim.acquire", { taskId: t.id });
    await expectRejected(o.do("task.move", { taskId: t.id, parentId: p.id }), E.ruleViolation, "task.no-active-claim");
  });

  test("task.list filters by parent (null = top-level) and stored state", async () => {
    const o = w().owner;
    const p = await o.create("List parent");
    const c1 = await o.create("c1", { parentId: p.id });
    const c2 = await o.create("c2", { parentId: p.id });
    await o.do("task.cancel", { taskId: c2.id, reason: "dup" });
    const kids = (await o.query("task.list", { parentId: p.id })).tasks;
    expect(kids.map((t) => t.id)).toEqual([c1.id, c2.id]);
    const openKids = (await o.query("task.list", { parentId: p.id, state: "open" })).tasks;
    expect(openKids.map((t) => t.id)).toEqual([c1.id]);
    const top = (await o.query("task.list", { parentId: null })).tasks;
    expect(top.some((t) => t.id === p.id)).toBe(true);
    expect(top.some((t) => t.id === c1.id)).toBe(false);
  });

  test("case 8: two concurrent moves that together would make a parent cycle — exactly one is rejected", async () => {
    const o = w().owner;
    const x = await o.create("X");
    const y = await o.create("Y");
    const o2 = await o.reconnect();
    const rs = await Promise.allSettled([
      o.do("task.move", { taskId: x.id, parentId: y.id }),
      o2.do("task.move", { taskId: y.id, parentId: x.id }),
    ]);
    expect(rs.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const failed = rs.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect([failed.reason.code, failed.reason.phase]).toEqual([E.ruleViolation, "content"]);
    expect(failed.reason.failures.some((f: { check?: string }) => f.check === "task.no-cycle")).toBe(true);
  });
});

suite("03.3 parent rule and no cascades [domain/core/task.md#rules, domain/core/completion.md#rules]", () => {
  const w = useWorld();

  test("case 7: completing a parent with an open child fails naming the child; canceling the child with a reason allows it", async () => {
    const o = w().owner;
    const p = await o.create("Parent");
    const done = await o.create("Done child", { parentId: p.id });
    const open = await o.create("Open child", { parentId: p.id });
    await o.complete({ taskId: done.id });
    const e = await expectRejected(o.complete({ taskId: p.id }), E.ruleViolation, "task.children-settled");
    const f = e.failures!.find((x) => x.check === "task.children-settled")!;
    expect(f.details?.openChildren).toEqual([open.id]);
    expect(f.reason).toContain("Open child");
    await o.do("task.cancel", { taskId: open.id, reason: "no longer needed" });
    const r = await o.complete({ taskId: p.id });
    expect(r.task.state).toBe("done");
  });

  test("reopening a done Task keeps its earlier completion; completing again adds a second one", async () => {
    const o = w().owner;
    const t = await o.create("Twice");
    await o.complete({ taskId: t.id });
    await o.do("task.reopen", { taskId: t.id, reason: "found a mistake" });
    await o.complete({ taskId: t.id });
    const h = (await o.task(t.id)).history;
    expect(h.completions).toHaveLength(2);
    expect(h.completions.every((c) => c.rule === "performer-is-reviewer" && c.submissionId === null)).toBe(true);
  });
});
