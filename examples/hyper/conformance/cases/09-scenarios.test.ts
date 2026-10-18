/**
 * Group 09 — end-to-end scenarios (core parts only).
 * Enforces: overview/heart.md (the lead-and-swarm journey); implementation/acceptance-cases.md#heart cases 1
 * (journey), 2–3 (following live and replaying, core events only — runs are out of this slice), 10 (solo);
 * domain/scenarios.md#trip, #solo; domain/core/index.md#responsibilities (the boundary checks).
 */
import { expect, test } from "bun:test";
import type { Event } from "../schemas/protocol.ts";
import { E, expectRejected, suite, types, until, useWorld } from "./_setup.ts";

suite("09.1 case 1: the lead-and-swarm journey [overview/heart.md, acceptance-cases.md#heart]", () => {
  const w = useWorld();

  test("a lead decomposes, delegates, waits, returns one result, accepts both and hands the parent back for review", async () => {
    const human = w().owner;
    const lead = await w().add("lead-agent");
    const agentA = await w().add("agent-a");
    const agentB = await w().add("agent-b");

    // The human asks the lead for the parent.
    const parent = await human.create("Add CSV export", { intent: "Users can export a report as CSV" });
    await human.do("task.assign", { taskId: parent.id, assigneeId: lead.id });

    // The lead follows the subtree live (case 2) from before it decomposes.
    const leadConn = await lead.reconnect();
    const live: Event[] = [];
    leadConn.client.onNotification((m, p) => m === "events.event" && live.push(p.event));
    await leadConn.query("events.subscribe", { after: 0, taskSubtree: parent.id });

    // Decompose: two children with a dependency.
    const c1 = await lead.create("Write the CSV encoder", { parentId: parent.id, intent: "RFC 4180 compliant" });
    const c2 = await lead.create("Wire the export button", { parentId: parent.id, intent: "Button downloads the CSV" });
    await lead.do("dependency.add", { dependentId: c2.id, prerequisiteId: c1.id });
    await lead.do("task.assign", { taskId: c1.id, assigneeId: agentA.id });
    await lead.do("task.assign", { taskId: c2.id, assigneeId: agentB.id });
    const c2view = (await lead.task(c2.id)).task;
    expect(c2view.derived.state).toBe("blocked");
    expect(c2view.derived.reasons[0]).toMatchObject({ kind: "dependency", taskId: c1.id });
    expect(c2view.reviewer).toEqual({ collaboratorId: lead.id, rule: "parent-assignee" });

    // B has nothing to do yet; A does.
    expect((await agentB.query("task.next", {})).task).toBeNull();
    expect((await agentA.query("task.next", {})).task?.id).toBe(c1.id);

    // A works and submits; the lead returns it with reasons.
    const a1 = await agentA.do("claim.acquire", { taskId: c1.id });
    const ev1 = await agentA.do("evidence-reference.record", { kind: "file", locator: "src/csv.ts", contentHash: "sha256:1" });
    const s1 = await agentA.do("submission.submit", { taskId: c1.id, fence: a1.claim.fence, summary: "encoder done", evidence: [ev1.evidenceReference.id] });
    if (s1.outcome !== "submitted") throw new Error("expected submitted");
    await lead.do("review.return", { submissionId: s1.submission.id, reasons: "quotes inside fields are not escaped" });

    // A revises and resubmits; the lead accepts. C2 becomes ready for B.
    const a2 = await agentA.do("claim.acquire", { taskId: c1.id });
    expect(a2.claim.fence).toBe(a1.claim.fence + 1);
    const s2 = await agentA.do("submission.submit", { taskId: c1.id, fence: a2.claim.fence, summary: "escaping fixed" });
    if (s2.outcome !== "submitted") throw new Error("expected submitted");
    await lead.do("review.accept", { submissionId: s2.submission.id });
    expect((await agentB.query("task.next", {})).task?.id).toBe(c2.id);

    // B works; the lead accepts.
    const b1 = await agentB.do("claim.acquire", { taskId: c2.id });
    const s3 = await agentB.do("submission.submit", { taskId: c2.id, fence: b1.claim.fence, summary: "button wired" });
    if (s3.outcome !== "submitted") throw new Error("expected submitted");
    await lead.do("review.accept", { submissionId: s3.submission.id });

    // The lead completes the parent. It is top-level, so its creator (the human) reviews it.
    expect((await lead.task(parent.id)).task.reviewer).toEqual({ collaboratorId: human.id, rule: "task-creator" });
    const lp = await lead.do("claim.acquire", { taskId: parent.id });
    await expectRejected(lead.complete({ taskId: parent.id, fence: lp.claim.fence }), E.ruleViolation, "task.review-required");
    const sp = await lead.do("submission.submit", { taskId: parent.id, fence: lp.claim.fence, summary: "CSV export shipped" });
    if (sp.outcome !== "submitted") throw new Error("expected submitted");
    const done = await human.do("review.accept", { submissionId: sp.submission.id });
    expect(done.task.state).toBe("done");

    // Attribution: responsibility, performance and acceptance are separate facts.
    const h1 = (await human.task(c1.id)).history;
    expect(h1.assignments[0]).toMatchObject({ assigneeId: agentA.id, delegatorId: lead.id });
    expect(h1.submissions.map((s) => [s.submitterId, s.state])).toEqual([[agentA.id, "returned"], [agentA.id, "accepted"]]);
    expect(h1.completions[0]).toMatchObject({ rule: "review-accepted", completedBy: lead.id });

    // Case 3: the replay of the subtree equals what the lead saw live, in order.
    const replay = await w().events(0, { taskSubtree: parent.id });
    // Delivery is at least once: compare distinct events, waiting until the last replayed one arrived live.
    const distinctLive = () => live.filter((e, i) => live.findIndex((x) => x.id === e.id) === i);
    await until(async () => distinctLive().some((e) => e.id === replay[replay.length - 1]!.id));
    expect(distinctLive().map((e) => e.id)).toEqual(replay.map((e) => e.id));
    const seen = new Set(types(replay));
    for (const t of ["task.created", "dependency.added", "assignment.started", "claim.acquired", "submission.submitted", "claim.released", "review.returned", "review.accepted", "task.completed"]) {
      expect(seen.has(t as Event["type"])).toBe(true);
    }
  }, 30_000);
});

suite("09.2 solo — case 10 [domain/scenarios.md#solo, domain/core/index.md#rules rule 9]", () => {
  const w = useWorld();

  test("one person creates, completes and reopens Tasks with no assignment, parent, dependency or review; history shows every step", async () => {
    const me = w().owner;
    const start = await w().head();
    const tasks = [];
    for (const title of ["Buy milk", "Call the bank", "Renew passport"]) tasks.push(await me.create(title));
    for (const t of tasks) {
      const r = await me.complete({ taskId: t.id });
      expect(types(r.events)).toEqual(["task.completed"]);
      expect(r.completion).toMatchObject({ rule: "performer-is-reviewer", submissionId: null, completedBy: me.id });
    }
    const reopened = await me.do("task.reopen", { taskId: tasks[1]!.id, reason: "the bank called back" });
    expect(reopened.events[0]!.payload).toEqual({ reason: "the bank called back", fromState: "done" });
    const h = await me.task(tasks[1]!.id);
    expect(h.history.completions).toHaveLength(1);
    expect(h.history.assignments).toEqual([]);
    expect(h.history.submissions).toEqual([]);
    const log = await w().events(start);
    expect(types(log)).toEqual([
      "task.created", "task.created", "task.created",
      "task.completed", "task.completed", "task.completed",
      "task.reopened",
    ]);
    expect(log.every((e) => e.actor === me.id)).toBe(true);
  });
});

suite("09.3 trip to Japan [domain/scenarios.md#trip]", () => {
  const w = useWorld();

  test("Ana and a research agent prepare a trip with only core concepts", async () => {
    const ana = await w().add("Ana", "member", "human");
    const agent = await w().add("research-agent", "member", "agent");

    // 1. A parent and two children; booking depends on research.
    const trip = await ana.create("Trip to Japan in May");
    const research = await ana.create("Research visa requirements", { parentId: trip.id, intent: "Know what visa we need" });
    const book = await ana.create("Book flights", { parentId: trip.id, intent: "Round trip, economy" });
    await ana.do("dependency.add", { dependentId: book.id, prerequisiteId: research.id });

    // 2. Ana assigns the research to the agent. Booking is blocked, waiting for the research.
    await ana.do("task.assign", { taskId: research.id, assigneeId: agent.id });
    const blocked = (await ana.task(book.id)).task;
    expect(blocked.derived).toEqual({ state: "blocked", reasons: [{ kind: "dependency", taskId: research.id, message: expect.any(String) }] });

    // 3. The agent claims, records the embassy page as evidence, and submits.
    const { claim } = await agent.do("claim.acquire", { taskId: research.id });
    const page = await agent.do("evidence-reference.record", { kind: "link", locator: "https://www.mofa.go.jp/j_info/visit/visa/", description: "Embassy visa page" });
    const sub = await agent.do("submission.submit", {
      taskId: research.id,
      fence: claim.fence,
      summary: "No visa needed for stays under 90 days",
      evidence: [page.evidenceReference.id],
    });
    if (sub.outcome !== "submitted") throw new Error("expected submitted");

    // 4. Ana is responsible for the parent, so she reviews. She accepts; booking becomes ready.
    expect((await ana.task(research.id)).task.reviewer.collaboratorId).toBe(ana.id);
    await ana.do("review.accept", { submissionId: sub.submission.id });
    expect((await ana.task(book.id)).task.derived).toEqual({ state: "ready", reasons: [] });

    // 5. Ana claims and books the flights herself: performer and reviewer, so no review. Then she completes the parent.
    const own = await ana.do("claim.acquire", { taskId: book.id });
    const booked = await ana.complete({ taskId: book.id, fence: own.claim.fence });
    expect(booked.completion.rule).toBe("performer-is-reviewer");
    const tripDone = await ana.complete({ taskId: trip.id });
    expect(tripDone.completion).toMatchObject({ rule: "performer-is-reviewer", completedBy: ana.id });

    const all = await w().events(0, { taskSubtree: trip.id });
    expect(types(all).filter((t) => t === "task.completed")).toHaveLength(3);
    expect(types(all)).not.toContain("review.returned");
  });
});
