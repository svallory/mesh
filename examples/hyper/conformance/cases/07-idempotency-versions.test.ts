/**
 * Group 07 — command IDs and expected versions.
 * Enforces: domain/commands-and-events.md#commands (command ID, expected version, check phases);
 * domain/core/task.md#attributes (version increments on every change); PROTOCOL.md#idempotency;
 * implementation/acceptance-cases.md#heart case 9 (retry).
 */
import { expect, test } from "bun:test";
import { E, expectRejected, suite, useWorld } from "./_setup.ts";

suite("07.2 versions and expected-version conflicts [domain/commands-and-events.md#commands]", () => {
  const w = useWorld();

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
});
