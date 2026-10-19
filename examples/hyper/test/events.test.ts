// The event log of the port (spec, Events and commands; PROTOCOL.md §4.3, §5, §6): the metadata each event is stored
// with (`metadata` in `src/events.ts`), the wire `Event` built from it (`toWire`), the stored commands that make a
// repeat idempotent (`src/rpc/idempotency.ts` and the `command` wrapper of `src/rpc/methods.ts`), and `events.read`'s
// pages (`readPage` in `src/rpc/subscriptions.ts`). The conformance cases of groups 01 to 09 check the same over the
// wire; these pin the parts they reach only indirectly.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { type Call, RpcError } from "@meshfw/jsonrpc";
import { CursorAheadError, type ActionContext } from "@meshfw/runtime";
import { eventClasses, readEvents, type EventRecord } from "#mesh";
import { Idempotency } from "#mesh/domain/audit";
import { Collaborator, Membership, Workspace } from "#mesh/domain/identity";
import { Claim, Task } from "#mesh/domain/work";
import { checkEvent } from "../conformance/harness/validate.ts";
import { bootstrap } from "../src/daemon/bootstrap";
import { reviewAccept, submissionSubmit } from "../src/domain/work/work.commands";
import { toWire, WIRE_TYPES, type WireEvent } from "../src/events";
import { engineRule } from "../src/rpc/context";
import { wireError } from "../src/rpc/errors";
import { attachEventLog } from "../src/rpc/event-log";
import { canonicalJson, commandHash } from "../src/rpc/idempotency";
import { methods } from "../src/rpc/methods";
import { params as schemas } from "../src/rpc/params";
import { readPage } from "../src/rpc/subscriptions";
import { as, asSystem, empty, setup, type Empty } from "./world";

/** Every committed event after `after`, as the wire carries it, read outside any transaction. */
async function wire(after = 0): Promise<WireEvent[]> {
  const [workspace] = await Workspace.read({}, setup);
  const page = await readEvents({ after, limit: 1000 });
  return page.events.map((record: EventRecord) => toWire(record, workspace?.id ?? ""));
}

/** The highest position the log holds, read through `readEvents`. */
async function head(): Promise<number> {
  return (await readEvents({ limit: 1 })).highest;
}

/**
 * A bootstrapped engine as the daemon starts one: the workspace, its owner (seq 1 to 3), a second member and a Task,
 * with the event log attached for the methods. `owner` and `bob` act through `as()`.
 */
async function engine() {
  const base = await empty();
  attachEventLog({ binding: base.hyper });
  return base.hyper.run(async () => {
    await bootstrap(base.hyper);
    const [owner] = await Collaborator.read({}, setup);
    const bob = await Collaborator.register({ kind: "human", name: "Bob" }, engineRule("test.setup"));
    await Membership.grant({ collaborator: bob.id, role: "member" }, { ...as(owner!), caller: "cli" });
    return { ...base, owner: owner!, bob };
  });
}

let open: Empty | undefined;
beforeEach(() => { open = undefined; });
afterEach(async () => {
  attachEventLog(undefined);
  await open?.db.close();
});

/** Runs `body` on a fresh engine, with its binding in scope. */
async function onEngine(body: (e: Awaited<ReturnType<typeof engine>>) => Promise<void>) {
  const e = await engine();
  open = e;
  await e.hyper.run(() => body(e));
}

describe("the events the port declares", () => {
  test("every event class has a wire type and every wire type a class: the 30 of PROTOCOL.md §6 the port publishes", () => {
    expect(Object.keys(eventClasses).sort()).toEqual(Object.keys(WIRE_TYPES).sort());
    expect(Object.keys(WIRE_TYPES)).toHaveLength(30);
    expect(new Set(Object.values(WIRE_TYPES)).size).toBe(30);
  });
});

describe("metadata and the wire Event", () => {
  test("bootstrap's three events are seq 1 to 3, by the engine, caused by the rule workspace.bootstrap, and valid on the wire", () => onEngine(async ({ owner }) => {
    const [registered, created, granted] = await wire();
    expect([registered!.type, created!.type, granted!.type]).toEqual(["collaborator.registered", "workspace.created", "membership.granted"]);
    expect([registered!.seq, created!.seq, granted!.seq]).toEqual([1, 2, 3]);
    for (const event of [registered!, created!, granted!]) {
      expect(event).toMatchObject({ actor: "engine", caller: "engine", cause: { kind: "rule", rule: "workspace.bootstrap" }, schemaVersion: 1, taskId: null });
      expect(checkEvent(JSON.parse(JSON.stringify(event)))).toEqual([]);
      expect(event.recordedAt).toBe(event.occurredAt);
    }
    // The workspace id is filled from the one workspace row, collaborator.registered included, which comes before it.
    const [workspace] = await Workspace.read({}, setup);
    expect(new Set([registered!.workspaceId, created!.workspaceId, granted!.workspaceId])).toEqual(new Set([workspace!.id]));
    expect(registered!.record).toEqual({ type: "collaborator", id: owner.id, version: 1 });
    expect(created!.record).toEqual({ type: "workspace", id: workspace!.id, version: 1 });
  }));

  test("a command's event names the actor and caller verbatim, the command as its cause, and the Task at the version it left", () => onEngine(async ({ owner }) => {
    const from = await head();
    const context: ActionContext = { ...as(owner), caller: "agent-7", commandId: "c-42", method: "task.create" };
    const task = await Task.create({ title: "Ship" }, context);
    await Task.setPriority({ id: task.id, priority: 4 }, { ...context, commandId: "c-43", method: "task.set-priority" });
    const [created, prioritized] = await wire(from);
    expect(created).toMatchObject({
      seq: from + 1, type: "task.created", actor: owner.id, caller: "agent-7", taskId: task.id,
      cause: { kind: "command", commandId: "c-42", method: "task.create" }, record: { type: "task", id: task.id, version: 1 },
      payload: { title: "Ship", intent: null, parentId: null, priority: null, creatorId: owner.id },
    });
    expect(prioritized).toMatchObject({ seq: from + 2, type: "task.priority-set", record: { version: 2 }, cause: { commandId: "c-43" }, payload: { oldPriority: null, newPriority: 4 } });
    for (const event of [created!, prioritized!]) expect(checkEvent(JSON.parse(JSON.stringify(event)))).toEqual([]);
  }));

  test("a call that is neither a command nor an engine rule cannot publish, and what it wrote rolls back", () => onEngine(async ({ owner }) => {
    const from = await head();
    const bare: ActionContext = { actor: { id: owner.id, role: "owner" } };
    await expect(Task.create({ title: "Nobody's" }, bare)).rejects.toThrow("neither a command (commandId and method) nor an engine rule");
    expect(await Task.read({ filter: { title: { eq: "Nobody's" } } }, setup)).toEqual([]);
    expect(await head()).toBe(from);
  }));

  test("claim.expired is the engine's rule claim.lease-expiry, whoever ended the claim", () => onEngine(async ({ owner, time }) => {
    const task = await Task.create({ title: "Lease" }, as(owner));
    const claim = await Claim.acquire({ task: task.id }, as(owner));
    time.now = new Date(claim.expiresAt.getTime() + 1);
    const from = await head();
    // The engine's nested context of a command, not the sweeper's: the expiry still names the rule.
    await Claim.expire({ id: claim.id, reason: "lease expired" }, asSystem(owner));
    const events = await wire(from);
    expect(events.map((event) => event.type)).toEqual(["claim.expired"]);
    expect(events[0]).toMatchObject({ actor: "engine", caller: "engine", cause: { kind: "rule", rule: "claim.lease-expiry" }, taskId: task.id });
  }));

  test("claim.acquire over a lapsed claim: claim.acquired comes first, caused by the command, then claim.expired by the rule (PROTOCOL.md §4.2)", () => onEngine(async ({ owner, time }) => {
    const task = await Task.create({ title: "Lapsed" }, as(owner));
    const lapsed = await Claim.acquire({ task: task.id }, as(owner));
    time.now = new Date(lapsed.expiresAt.getTime() + 1);
    const from = await head();
    const claim = await Claim.acquire({ task: task.id }, { ...as(owner), commandId: "c-again", method: "claim.acquire" });
    const events = await wire(from);
    expect(events.map((event) => event.type)).toEqual(["claim.acquired", "claim.expired"]);
    expect(events[0]).toMatchObject({ cause: { kind: "command", commandId: "c-again", method: "claim.acquire" }, payload: { claimId: claim.id } });
    expect(events[1]).toMatchObject({ actor: "engine", cause: { kind: "rule", rule: "claim.lease-expiry" }, payload: { claimId: lapsed.id } });
  }));

  test("review.accept: review.accepted and task.completed share the Task's one new version, one bump for the command", () => onEngine(async ({ owner, bob, binding }) => {
    const task = await Task.create({ title: "Review me" }, as(owner));
    await Task.assign({ id: task.id, assignee: bob.id }, as(owner));
    const claim = await Claim.acquire({ task: task.id }, as(bob));
    const submitted = await submissionSubmit({ task: task.id, fence: claim.fence, summary: "done" }, as(bob), binding);
    if (submitted.outcome !== "submitted") throw new Error(submitted.outcome);
    const from = await head();
    const accepted = await reviewAccept({ submission: submitted.submission.id }, { ...as(owner), commandId: "c-acc", method: "review.accept" }, binding);
    const events = await wire(from);
    expect(events.map((event) => event.type)).toEqual(["review.accepted", "task.completed"]);
    expect(events.map((event) => event.record.version)).toEqual([accepted.task.version, accepted.task.version]);
    expect(accepted.task.version).toBe(submitted.task.version + 1);
    expect(events.every((event) => event.cause.kind === "command" && event.cause.commandId === "c-acc")).toBe(true);
  }));
});

/** Runs `method` as the daemon would after its context factory: params parsed by the method's schema, then `run`. */
async function call(method: keyof typeof schemas, sent: Record<string, unknown>, context: ActionContext): Promise<any> {
  const made = { method, id: 1, params: sent, connection: {} } as unknown as Call;
  return JSON.parse(JSON.stringify(await methods[method]!.run(schemas[method].parse(sent) as never, { ...context, commandId: sent.commandId as string, method }, made)));
}

/** The error a call is refused with, as the client reads it. */
async function refusal(made: Promise<unknown>): Promise<RpcError> {
  const error = await made.catch((caught: unknown) => caught);
  if (!(error instanceof RpcError)) throw error;
  return error;
}

describe("idempotent commands (PROTOCOL.md §4.3)", () => {
  test("canonical JSON sorts keys at every depth and drops absent members, so key order never changes the hash", () => {
    expect(canonicalJson({ b: 1, a: { d: [1, { f: null, e: "x" }], c: undefined } })).toBe('{"a":{"d":[1,{"e":"x","f":null}]},"b":1}');
    expect(commandHash("task.create", { payload: { title: "A", intent: "B" }, actor: "x" })).toBe(commandHash("task.create", { actor: "x", payload: { intent: "B", title: "A" } }));
    expect(commandHash("task.create", { payload: { intent: null } })).not.toBe(commandHash("task.create", { payload: {} }));
    expect(commandHash("task.create", {})).not.toBe(commandHash("task.update", {}));
  });

  test("a repeat returns the stored result, events included, and changes nothing", () => onEngine(async ({ owner }) => {
    const sent = { commandId: "c-once", actor: owner.id, caller: "cli", payload: { title: "Once" } };
    const first = await call("task.create", sent, as(owner));
    const from = await head();
    const again = await call("task.create", { ...sent }, as(owner));
    expect(again).toEqual(first);
    expect(first.events.map((event: WireEvent) => event.type)).toEqual(["task.created"]);
    expect(await head()).toBe(from);
    expect(await Task.read({ filter: { title: { eq: "Once" } } }, setup)).toHaveLength(1);
    const [stored] = await Idempotency.read({ filter: { commandId: { eq: "c-once" } } }, setup);
    expect(stored).toMatchObject({ method: "task.create", hash: commandHash("task.create", sent), result: first });
  }));

  test("the same commandId with other params or another method is -32006 idempotency_conflict, and writes nothing", () => onEngine(async ({ owner }) => {
    const sent = { commandId: "c-twice", actor: owner.id, caller: "cli", payload: { title: "First" } };
    await call("task.create", sent, as(owner));
    const from = await head();
    for (const [method, other] of [["task.create", { ...sent, payload: { title: "Second" } }], ["evidence-reference.record", { ...sent, payload: { kind: "link", locator: "x" } }]] as const) {
      const error = await refusal(call(method, other, as(owner)));
      expect(error).toMatchObject({ code: -32006, message: "idempotency_conflict", data: { phase: "shape", failures: [{ check: "command-id" }] } });
    }
    expect(await head()).toBe(from);
    expect(await Task.read({ filter: { title: { eq: "Second" } } }, setup)).toEqual([]);
  }));

  test("a rejected command is not stored: the same commandId may be sent again once it can pass", () => onEngine(async ({ owner }) => {
    const sent = { commandId: "c-retry", actor: owner.id, caller: "cli", payload: { title: "Child", parentId: crypto.randomUUID() } };
    expect((await refusal(call("task.create", sent, as(owner)))).code).toBe(-32005);
    expect(await Idempotency.read({ filter: { commandId: { eq: "c-retry" } } }, setup)).toEqual([]);
    // The params differ now, and no conflict answers, since nothing was stored under the id.
    const done = await call("task.create", { ...sent, payload: { title: "Child" } }, as(owner));
    expect(done.task).toMatchObject({ title: "Child", parentId: null });
  }));
});

describe("events.read (PROTOCOL.md §5)", () => {
  test("pages by seq: the cursor is the last seq scanned, hasMore holds while the log has more", () => onEngine(async () => {
    const top = await head();
    const first = await readPage({ after: 0, limit: 2 });
    expect(first.events.map((event) => event.seq)).toEqual([1, 2]);
    expect(first).toMatchObject({ cursor: 2, hasMore: true });
    const rest = await readPage({ after: first.cursor });
    expect(rest.events.map((event) => event.seq)).toEqual(Array.from({ length: top - 2 }, (_, i) => i + 3));
    expect(rest).toMatchObject({ cursor: top, hasMore: false });
    expect(await readPage({ after: top })).toEqual({ events: [], cursor: top, hasMore: false });
  }));

  test("types keeps the named types, an unknown type matches nothing, and the cursor still passes what was filtered", () => onEngine(async ({ owner }) => {
    await Task.create({ title: "One" }, as(owner));
    const top = await head();
    const tasks = await readPage({ after: 0, types: ["task.created"] });
    expect(tasks.events.map((event) => event.type)).toEqual(["task.created"]);
    expect(tasks).toMatchObject({ cursor: top, hasMore: false });
    expect((await readPage({ after: 0, types: ["no.such-type"] })).events).toEqual([]);
  }));

  test("an after above the log's head is -32602 invalid_params on after, not -32603", () => onEngine(async () => {
    const top = await head();
    const error = await readPage({ after: top + 5 }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(CursorAheadError);
    const wired = wireError(error, { method: "events.read", id: 1, params: { after: top + 5 } } as unknown as Call);
    expect(wired).toMatchObject({ code: -32602, message: "invalid_params", data: { phase: "shape", failures: [{ check: "schema", details: { path: ["after"], head: top } }] } });
  }));

  test("taskSubtree keeps the events of the Task and of its descendants as they are now", () => onEngine(async ({ owner }) => {
    const parent = await Task.create({ title: "Parent" }, as(owner));
    const child = await Task.create({ title: "Child", parent: parent.id }, as(owner));
    const other = await Task.create({ title: "Other" }, as(owner));
    await Task.setPriority({ id: other.id, priority: 1 }, as(owner));
    const subtree = await readPage({ after: 0, taskSubtree: parent.id });
    expect(subtree.events.map((event) => event.taskId)).toEqual([parent.id, child.id]);
    // Moved under the parent later, the other Task's earlier events belong to the subtree from then on.
    await Task.move({ id: other.id, parent: parent.id }, as(owner));
    const moved = await readPage({ after: 0, taskSubtree: parent.id });
    expect(moved.events.map((event) => event.taskId)).toEqual([parent.id, child.id, other.id, other.id, other.id]);
    expect((await readPage({ after: 0, taskSubtree: child.id })).events.map((event) => event.type)).toEqual(["task.created"]);
  }));
});
