/**
 * Group 08 — the event log, reads and subscriptions.
 * Enforces: domain/core/event.md#attributes, #rules, #subscriptions; domain/commands-and-events.md#events;
 * architecture/persistence-and-events.md#activity-history, #subscriptions;
 * implementation/acceptance-cases.md#heart cases 2 (following live), 3 (inspecting later: replay), 11 (lead restart).
 */
import { expect, test } from "bun:test";
import type { Event } from "../schemas/protocol.ts";
import { checkEvent } from "../harness/validate.ts";
import { claimAndSubmit, leadWithChild, suite, types, until, useWorld } from "./_setup.ts";
import type { Actor } from "./_setup.ts";

/** Collects `events.event` notifications for one subscription on the actor's connection. */
async function subscribe(actor: Actor, params: { after: number; taskSubtree?: string; types?: string[] }) {
  const got: Event[] = [];
  const buffered: { subscriptionId: string; event: Event }[] = [];
  let subscriptionId: string | undefined;
  const off = actor.client.onNotification((method, p) => {
    if (method !== "events.event") return;
    if (subscriptionId === undefined) buffered.push(p);
    else if (p.subscriptionId === subscriptionId) got.push(p.event);
  });
  const r = await actor.query("events.subscribe", params);
  subscriptionId = r.subscriptionId;
  // Notifications parsed in the same chunk as the response land here before the await resumes.
  got.unshift(...buffered.filter((p) => p.subscriptionId === subscriptionId).map((p) => p.event));
  // PROTOCOL.md#subscriptions: the response must come before any notification of the subscription.
  const firstMention = actor.client.log
    .map((l) => JSON.parse(l))
    .find((m) => m.result?.subscriptionId === subscriptionId || m.params?.subscriptionId === subscriptionId);
  const responseFirst = firstMention?.result?.subscriptionId === subscriptionId;
  return {
    id: r.subscriptionId,
    /** Every notification received, repeats included (delivery is at least once). */
    raw: got,
    /** Distinct events by ID, in first-seen order. */
    get events(): Event[] {
      return distinct(got);
    },
    responseFirst,
    off,
  };
}

/** Deduplicates by event ID (PROTOCOL.md#subscriptions: consumers ignore repeats by ID). */
function distinct(events: Event[]): Event[] {
  const seen = new Set<string>();
  return events.filter((e) => (seen.has(e.id) ? false : (seen.add(e.id), true)));
}

suite("08.1 event envelope and log [domain/core/event.md#attributes, #rules]", () => {
  const w = useWorld();

  test("every event validates; seq is gapless from 1; the log is append-only across reads", async () => {
    const { lead, worker, child } = await leadWithChild(w());
    const { submission } = await claimAndSubmit(worker, child.id);
    await lead.do("review.accept", { submissionId: submission.id });
    const all = await w().events(0);
    expect(all.map((e) => e.seq)).toEqual(all.map((_, i) => i + 1));
    for (const e of all) expect(checkEvent(e)).toEqual([]);
    expect(new Set(all.map((e) => e.id)).size).toBe(all.length);
    const again = await w().events(0);
    expect(again.slice(0, all.length)).toEqual(all);
  });

  test("actor and caller are recorded separately and verbatim; cause names the command", async () => {
    const a = await w().add("synced");
    const commandId = "sync-connector-cmd-1";
    const r = await a.do("task.create", { title: "From ClickUp" }, { commandId, caller: "sync:clickup" });
    expect(r.events[0]).toMatchObject({ actor: a.id, caller: "sync:clickup", cause: { kind: "command", commandId, method: "task.create" } });
    expect(Date.parse(r.events[0]!.recordedAt)).toBeGreaterThanOrEqual(Date.parse(r.events[0]!.occurredAt));
  });

  test("events.read pages with limit, cursor and hasMore; filtered reads still advance the cursor", async () => {
    const o = w().owner;
    for (let i = 0; i < 5; i++) await o.create(`page ${i}`);
    const head = await w().head();
    const p1 = await o.query("events.read", { after: head - 5, limit: 2 });
    expect(p1.events.map((e) => e.seq)).toEqual([head - 4, head - 3]);
    expect(p1).toMatchObject({ cursor: head - 3, hasMore: true });
    const p2 = await o.query("events.read", { after: p1.cursor, limit: 10 });
    expect(p2.events.map((e) => e.seq)).toEqual([head - 2, head - 1, head]);
    expect(p2).toMatchObject({ cursor: head, hasMore: false });
    const none = await o.query("events.read", { after: head - 5, types: ["claim.expired"] });
    expect(none.events).toEqual([]);
    expect(none.cursor).toBe(head);
    const empty = await o.query("events.read", { after: head });
    expect(empty).toMatchObject({ events: [], cursor: head, hasMore: false });
  });

  test("taskSubtree covers the Task and its current descendants only; types filters exactly", async () => {
    const o = w().owner;
    const p = await o.create("Root");
    const c = await o.create("Child", { parentId: p.id });
    const g = await o.create("Grandchild", { parentId: c.id });
    const u = await o.create("Unrelated");
    await o.do("task.update", { taskId: u.id, title: "Unrelated 2" });
    await o.do("task.update", { taskId: g.id, title: "Grandchild 2" });
    const sub = await w().events(0, { taskSubtree: p.id });
    expect(new Set(sub.map((e) => e.taskId))).toEqual(new Set([p.id, c.id, g.id]));
    const onlyUpdates = await w().events(0, { taskSubtree: p.id, types: ["task.updated"] });
    expect(onlyUpdates.map((e) => e.taskId)).toEqual([g.id]);
  });
});

suite("08.2 subscriptions [domain/core/event.md#subscriptions, architecture/persistence-and-events.md#subscriptions]", () => {
  const w = useWorld();

  test("case 2: a subscriber gets the backlog after its cursor, then live events, in seq order, after the subscribe response", async () => {
    const o = w().owner;
    const watcher = await (await w().add("watcher", "guest", "human")).reconnect();
    const p = await o.create("Watched");
    const s = await subscribe(watcher, { after: 0, taskSubtree: p.id });
    await until(async () => s.events.length >= 1);
    expect(types(s.events)).toEqual(["task.created"]);
    const c = await o.create("Live child", { parentId: p.id });
    await o.do("task.update", { taskId: c.id, title: "Live child 2" });
    await o.create("Elsewhere");
    await until(async () => s.events.length >= 3);
    await Bun.sleep(100);
    expect(types(s.events)).toEqual(["task.created", "task.created", "task.updated"]);
    expect(s.events.map((e) => e.seq)).toEqual([...s.events.map((e) => e.seq)].sort((a, b) => a - b));
    expect(s.responseFirst).toBe(true);
    s.off();
  });

  test("case 11: a subscriber that disconnects and resubscribes from its cursor misses no event", async () => {
    const o = w().owner;
    const leadConn = await o.reconnect();
    const start = await w().head();
    const s1 = await subscribe(leadConn, { after: start });
    await o.create("before disconnect 1");
    await o.create("before disconnect 2");
    await until(async () => s1.events.length >= 2);
    const cursor = Math.max(...s1.events.map((e) => e.seq));
    await leadConn.client.close(); // the lead process dies

    for (let i = 0; i < 5; i++) await o.create(`while away ${i}`);

    const restarted = await o.reconnect();
    const s2 = await subscribe(restarted, { after: cursor });
    await o.create("after restart");
    const end = await w().head();
    await until(async () => s2.events.some((e) => e.seq === end));
    const seen = new Set([...s1.events, ...s2.events].map((e) => e.seq));
    for (let seq = start + 1; seq <= end; seq++) expect(seen.has(seq)).toBe(true);
    expect(s2.events[0]!.seq).toBe(cursor + 1);
  });

  test("a subtree subscription picks up children created after it started", async () => {
    const o = w().owner;
    const p = await o.create("Growing");
    const conn = await o.reconnect();
    const s = await subscribe(conn, { after: await w().head(), taskSubtree: p.id });
    const c = await o.create("new child", { parentId: p.id });
    const g = await o.create("new grandchild", { parentId: c.id });
    await until(async () => s.events.length >= 2);
    expect(s.events.map((e) => e.taskId)).toEqual([c.id, g.id]);
  });

  test("events.unsubscribe stops notifications", async () => {
    const o = w().owner;
    const conn = await o.reconnect();
    const s = await subscribe(conn, { after: await w().head() });
    await o.create("seen");
    await until(async () => s.events.length >= 1);
    await conn.client.request("events.unsubscribe", { subscriptionId: s.id });
    await o.create("not seen");
    await Bun.sleep(200);
    expect(types(s.events)).toEqual(["task.created"]);
    expect(s.events[0]!.payload).toMatchObject({ title: "seen" });
  });

  test("two subscriptions on one connection are delivered independently", async () => {
    const o = w().owner;
    const conn = await o.reconnect();
    const a = await o.create("A root");
    const b = await o.create("B root");
    const sa = await subscribe(conn, { after: 0, taskSubtree: a.id });
    const sb = await subscribe(conn, { after: 0, taskSubtree: b.id });
    await o.do("task.update", { taskId: b.id, title: "B root 2" });
    await until(async () => sa.events.length >= 1 && sb.events.length >= 2);
    expect(sa.events.every((e) => e.taskId === a.id)).toBe(true);
    expect(sb.events.every((e) => e.taskId === b.id)).toBe(true);
  });
});
