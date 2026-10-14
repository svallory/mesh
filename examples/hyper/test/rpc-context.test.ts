// The context each call runs with (`src/rpc/context.ts`) and the records the transport resolves before an action runs
// (`src/rpc/resolve.ts`), on a world of Alice (owner), Bob and Bot (members).
import { describe, expect, test } from "bun:test";
import { type Call, RpcError } from "@meshfw/jsonrpc";
import { ForbiddenError, InvalidInputError, NotFoundError } from "@meshfw/runtime";
import { Collaborator, Membership } from "#mesh/domain/identity";
import { collaboratorRetire, membershipRevoke } from "../src/domain/identity/identity.commands";
import { contextFactory, ENGINE } from "../src/rpc/context";
import { existingCollaborator, existingTask, isId, membershipOf, requireId } from "../src/rpc/resolve";
import { as, setup, within } from "./world";

const factory = contextFactory(new Set(["workspace.get"]));
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
      expect(await factory(call("task.create"), params(alice.id))).toEqual({ actor: { id: alice.id, role: "owner" }, caller: "cli", commandId: "c-1" });
      expect(await factory(call("task.create"), params(bob.id, { caller: "agent" }))).toEqual({ actor: { id: bob.id, role: "member" }, caller: "agent", commandId: "c-1" });
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
