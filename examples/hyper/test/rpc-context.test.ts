// The context each call runs with (`src/rpc/context.ts`) and the records the transport resolves before an action runs
// (`src/rpc/resolve.ts`), on a world of Alice (owner), Bob and Bot (members).
import { describe, expect, test } from "bun:test";
import { type Call, RpcError } from "@meshfw/jsonrpc";
import { ForbiddenError, InvalidInputError, NotFoundError } from "@meshfw/runtime";
import { Idempotency } from "#mesh/domain/audit";
import { Collaborator, Membership } from "#mesh/domain/identity";
import { collaboratorRetire, membershipRevoke } from "../src/domain/identity/identity.commands";
import { contextFactory, ENGINE, ENGINE_ID } from "../src/rpc/context";
import { commandHash } from "../src/rpc/idempotency";
import { actorless, methods, unserved } from "../src/rpc/methods";
import { existingCollaborator, existingTask, isId, membershipOf, requireId } from "../src/rpc/resolve";
import { as, setup, within } from "./world";

const factory = contextFactory(new Set(["workspace.get"]), new Map());
const call = (method: string): Call => ({ method, id: 1, params: {}, connection: {} as Call["connection"] });
const params = (actor: string, extra: Record<string, unknown> = {}) => ({ commandId: "c-1", actor, caller: "cli", payload: {}, ...extra });

/** The failures of the `-32001` a context factory call is refused with. */
async function refusal(made: Promise<unknown>) {
  try {
    await made;
  } catch (error) {
    if (!(error instanceof RpcError)) throw error;
    expect(error.code).toBe(-32001);
    expect(error.message).toBe("permission_denied");
    return (error.data as { phase: string; failures: { check: string; reason: string }[] });
  }
  throw new Error("the call was not refused");
}

describe("contextFactory", () => {
  test("an actorless method gets the engine's context, whatever the params name", async () => {
    await within(async () => {
      expect(await factory(call("workspace.get"), {})).toBe(ENGINE);
      expect(await factory(call("workspace.get"), params("nobody"))).toBe(ENGINE);
      expect(ENGINE).toEqual({ actor: { id: "00000000-0000-4000-8000-000000000000", role: null }, system: true, caller: "engine" });
      expect(Object.isFrozen(ENGINE) && Object.isFrozen(ENGINE.actor)).toBe(true);
    });
  });

  test("an actor's role is read from its active membership, with the caller and the command id", async () => {
    await within(async ({ alice, bob }) => {
      expect(await factory(call("task.create"), params(alice.id))).toEqual({ actor: { id: alice.id, role: "owner" }, caller: "cli", commandId: "c-1", method: "task.create" });
      expect(await factory(call("task.create"), params(bob.id, { caller: "agent" }))).toEqual({ actor: { id: bob.id, role: "member" }, caller: "agent", commandId: "c-1", method: "task.create" });
    });
  });

  test("a guest's role is guest", async () => {
    await within(async ({ alice }) => {
      const carol = await Collaborator.register({ kind: "human", name: "Carol" }, setup);
      await Membership.grant({ collaborator: carol.id, role: "guest" }, as(alice));
      expect((await factory(call("task.create"), params(carol.id))).actor).toEqual({ id: carol.id, role: "guest" });
    });
  });

  test("a query, which has no command id, gets a context without one", async () => {
    await within(async ({ alice }) => {
      const context = await factory(call("task.get"), { actor: alice.id, caller: "cli", taskId: "t" });
      expect(context).toEqual({ actor: { id: alice.id, role: "owner" }, caller: "cli" });
      expect("commandId" in context).toBe(false);
    });
  });

  test("a commandId already stored: the same command gets a context with no role, another one is -32006 before the actor is read", async () => {
    await within(async ({ alice, bob }) => {
      const sent = params(alice.id, { commandId: "c-stored", payload: { title: "Ship" } });
      const stored = { ...call("task.create"), params: sent };
      await Idempotency.record({ commandId: "c-stored", method: "task.create", hash: commandHash("task.create", sent), result: { events: [] } }, setup);
      // A repeat is answered from the store (the method returns it), with no membership read: the actor may have lost it since.
      expect(await factory(stored, sent)).toEqual({ actor: { id: alice.id, role: null }, caller: "cli", commandId: "c-stored", method: "task.create" });
      // Another method, other params or another actor under the same commandId is the conflict, in the shape phase.
      for (const [method, other] of [
        ["task.update", sent],
        ["task.create", { ...sent, payload: { title: "Other" } }],
        ["task.create", { ...sent, actor: bob.id }],
      ] as const) {
        const error = await factory({ ...call(method), params: other }, other).catch((caught: unknown) => caught);
        expect(error).toBeInstanceOf(RpcError);
        expect(error).toMatchObject({ code: -32006, message: "idempotency_conflict", data: { phase: "shape", failures: [{ check: "command-id" }] } });
      }
      // The conflict comes before the membership check: an unknown actor reusing the id gets it too.
      const stranger = params("nobody", { commandId: "c-stored" });
      expect(await factory({ ...call("task.create"), params: stranger }, stranger).catch((caught: unknown) => caught)).toMatchObject({ code: -32006 });
    });
  });

  test("the daemon's --lease-ms is on every context, the engine's a frozen copy of ENGINE with it; without one, no context names it", async () => {
    await within(async ({ alice }) => {
      const leased = contextFactory(new Set(["workspace.get"]), new Map(), 30_000);
      expect(await leased(call("task.create"), params(alice.id))).toEqual({ actor: { id: alice.id, role: "owner" }, caller: "cli", commandId: "c-1", method: "task.create", leaseMs: 30_000 });
      expect(await leased(call("task.get"), { actor: alice.id, caller: "cli", taskId: "t" })).toEqual({ actor: { id: alice.id, role: "owner" }, caller: "cli", leaseMs: 30_000 });
      const engine = await leased(call("workspace.get"), {});
      expect(engine).toEqual({ ...ENGINE, leaseMs: 30_000 });
      expect(Object.isFrozen(engine)).toBe(true);
      expect(engine.actor).toBe(ENGINE.actor);
      // The same frozen object on every actorless call, and ENGINE itself unchanged.
      expect(await leased(call("workspace.get"), params("nobody"))).toBe(engine);
      expect("leaseMs" in ENGINE).toBe(false);
      expect("leaseMs" in (await factory(call("task.create"), params(alice.id)))).toBe(false);
    });
  });

  test("an unknown actor, by UUID or by any other string, is refused with the membership check", async () => {
    await within(async () => {
      for (const actor of [crypto.randomUUID(), "nope"]) {
        const data = await refusal(factory(call("task.create"), params(actor)));
        expect(data.phase).toBe("permission");
        expect(data.failures).toEqual([{ check: "membership", reason: `no collaborator with id ${actor}; register it, and have an owner grant it a membership` }]);
      }
    });
  });

  test("a collaborator with no membership is refused with the membership check", async () => {
    await within(async () => {
      const dan = await Collaborator.register({ kind: "agent", name: "Dan" }, setup);
      const data = await refusal(factory(call("task.create"), params(dan.id)));
      expect(data.failures).toEqual([{ check: "membership", reason: `collaborator ${dan.id} has no active membership; an owner can grant one` }]);
    });
  });

  test("a collaborator whose membership was revoked is refused with the membership check", async () => {
    await within(async ({ alice, bob, memberships, binding }) => {
      await membershipRevoke({ id: memberships.bob.id }, as(alice), binding);
      const data = await refusal(factory(call("task.create"), params(bob.id)));
      expect(data.failures.map((failure) => failure.check)).toEqual(["membership"]);
    });
  });

  test("a retired collaborator is refused with the membership check, naming the retirement", async () => {
    await within(async ({ alice, bot, binding }) => {
      await collaboratorRetire({ id: bot.id }, as(alice), binding);
      const data = await refusal(factory(call("task.create"), params(bot.id)));
      expect(data.failures).toEqual([{ check: "membership", reason: `collaborator ${bot.id} is retired and can no longer act` }]);
    });
  });
});

/** The methods whose params have no `actor` in the spec's `schemas/protocol.ts` (PROTOCOL.md:124, 132). */
const SPEC_ACTORLESS: readonly string[] = ["events.unsubscribe", "workspace.get"];

/** What the daemon's factory (`contextFactory(actorless, unserved(table))`) makes of `method` for `actor`: a context, or the error. */
async function outcome(table: typeof methods, method: string, actor: string): Promise<unknown> {
  return contextFactory(actorless, unserved(table))(call(method), params(actor)).catch((error: unknown) => error);
}

describe("the daemon's context factory", () => {
  test("only the methods the spec defines without an actor run with the engine's context", () => {
    expect([...actorless].sort()).toEqual([...SPEC_ACTORLESS]);
  });

  test("every unserved method answers -32010 before the actor is read, so an unknown actor is never reached", async () => {
    const reasons = unserved(methods);
    expect(reasons.size).toBeGreaterThan(0);
    await within(async () => {
      for (const [method, why] of reasons) {
        const error = await outcome(methods, method, crypto.randomUUID());
        expect(error).toBeInstanceOf(RpcError);
        expect(error).toMatchObject({
          code: -32010,
          message: "not_implemented",
          data: { phase: "shape", failures: [{ check: "method", reason: `${method} is not implemented by this engine: ${why}` }] },
        });
      }
    });
  });

  test("no method outside the spec's actorless list gets the engine's context: each takes the actor's, or is refused", async () => {
    await within(async ({ alice }) => {
      const reasons = unserved(methods);
      for (const method of Object.keys(methods).filter((name) => !SPEC_ACTORLESS.includes(name))) {
        const asEngine = await outcome(methods, method, ENGINE_ID);
        expect(asEngine).toBeInstanceOf(RpcError);
        expect((asEngine as RpcError).code).toBe(reasons.has(method) ? -32010 : -32001);
        const asAlice = await outcome(methods, method, alice.id);
        if (reasons.has(method)) expect((asAlice as RpcError).code).toBe(-32010);
        else expect(asAlice).toEqual({ actor: { id: alice.id, role: "owner" }, caller: "cli", commandId: "c-1", method });
      }
    });
  });

  test("serving a method takes it off the unserved map, and it then needs an actor with a membership", async () => {
    const served = { ...methods, "workspace.export": { run: () => ({}) } };
    expect(unserved(methods).has("workspace.export")).toBe(true);
    expect(unserved(served).has("workspace.export")).toBe(false);
    await within(async ({ alice }) => {
      expect(await outcome(served, "workspace.export", alice.id)).toEqual({ actor: { id: alice.id, role: "owner" }, caller: "cli", commandId: "c-1", method: "workspace.export" });
      expect((await outcome(served, "workspace.export", ENGINE_ID)) as RpcError).toMatchObject({ code: -32001, data: { failures: [{ check: "membership" }] } });
    });
  });

  test("the spec's actorless methods, workspace.get and events.unsubscribe, get the engine's context", async () => {
    await within(async () => {
      expect(await outcome(methods, "workspace.get", "anyone")).toBe(ENGINE);
      expect(await outcome(methods, "events.unsubscribe", "anyone")).toBe(ENGINE);
    });
  });
});

describe("resolve", () => {
  test("only a UUID can name a stored row", () => {
    expect(isId(crypto.randomUUID())).toBe(true);
    expect(isId("nope")).toBe(false);
    expect(isId("")).toBe(false);
    expect(() => requireId("work.Task", "nope")).toThrow(NotFoundError);
    const id = crypto.randomUUID();
    expect(requireId("work.Task", id)).toBe(id);
  });

  test("existingCollaborator and existingTask return the row, or throw NotFoundError naming the entity", async () => {
    await within(async ({ bob, task }) => {
      expect((await existingCollaborator(bob.id)).id).toBe(bob.id);
      expect((await existingTask(task.id)).id).toBe(task.id);
      for (const id of ["nope", crypto.randomUUID()]) {
        await expect(existingTask(id)).rejects.toMatchObject({ entity: "work.Task", key: { id } });
        await expect(existingCollaborator(id)).rejects.toMatchObject({ entity: "identity.Collaborator", key: { id } });
      }
    });
  });

  test("membershipOf takes the active membership", async () => {
    await within(async ({ alice, bob, memberships }) => {
      expect((await membershipOf(bob.id, as(alice), "changeRole")).id).toBe(memberships.bob.id);
    });
  });

  test("membershipOf takes the latest membership when none is active, so the action answers membership.active", async () => {
    await within(async ({ alice, bob, memberships, binding }) => {
      await membershipRevoke({ id: memberships.bob.id }, as(alice), binding);
      const membership = await membershipOf(bob.id, as(alice), "revoke");
      expect(membership.id).toBe(memberships.bob.id);
      expect(membership.state).toBe("revoked");
    });
  });

  test("membershipOf of a collaborator that never had one is membership.active for an owner, and the role denial for anyone else", async () => {
    await within(async ({ alice, bob }) => {
      const dan = await Collaborator.register({ kind: "agent", name: "Dan" }, setup);
      const forOwner = await membershipOf(dan.id, as(alice), "revoke").catch((error: unknown) => error);
      expect(forOwner).toBeInstanceOf(InvalidInputError);
      expect((forOwner as InvalidInputError).issues.map((issue) => issue.code)).toEqual(["membership.active"]);
      const forMember = await membershipOf(dan.id, as(bob), "changeRole").catch((error: unknown) => error);
      expect(forMember).toBeInstanceOf(ForbiddenError);
      expect(forMember).toMatchObject({ entity: "identity.Membership", action: "changeRole", policies: ["ownerOnly"], reason: "failed" });
    });
  });

  test("membershipOf of an unknown collaborator is NotFoundError", async () => {
    await within(async ({ alice }) => {
      await expect(membershipOf("nope", as(alice), "revoke")).rejects.toBeInstanceOf(NotFoundError);
    });
  });
});
