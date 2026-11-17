import { afterEach, describe, expect, test } from "bun:test";
import { AsyncLocalStorage } from "node:async_hooks";
import {
  ForbiddenError, FrameworkError, InvalidInputError, Mesh, OPERATIONS, SERVICE, bindDomain, connectBinding, expr, isEntityValue, isServiceValue, releaseBinding,
  service, settled, type Binding, type Change, type DataOperations, type Seams,
} from "../src/index.ts";
import { handlerScope } from "../src/entity.ts";
import * as domain from "./service-domain/work.ts";
import { Billing, Claim, Member, Task, Work, hooks, memoryLayer, reset, schemaOf, tables } from "./service-domain/work.ts";

/**
 * Service values and `runOperation` (services design, sections 5.2 and 8) over a domain written as `mesh build` writes
 * one (`service-domain/work.ts`), on an in-memory layer whose transactions join, roll back and refuse a call after a
 * joined one failed, as the SQL adapters' do. `work.Work#handOver` uses `work.Task` `[:create, :complete, :read]` and
 * `work.Claim` `[:read]`, and nothing of `work.Member`.
 */
const frame = new AsyncLocalStorage<unknown>();
const actor = { actor: { id: "u1" } };

function world(seams?: Seams, clock?: () => Date) {
  const { layer, state } = memoryLayer();
  const binding = bindDomain(domain, layer, { ...(seams ? { seams } : {}), ...(clock ? { clock } : {}) }, frame);
  return { binding, state, layer };
}
const rows = (state: ReturnType<typeof memoryLayer>["state"], table: string) => state.committed[table]!;

async function rejection(run: () => Promise<unknown>): Promise<Error> {
  try { await run(); } catch (error) { return error as Error; }
  throw new Error("expected a rejection");
}

afterEach(reset);

describe("service values", () => {
  test("a service value has a null prototype, is frozen, holds one member per operation, and Mesh's internals are symbols", () => {
    expect(Object.getPrototypeOf(Work)).toBeNull();
    expect(Object.isFrozen(Work)).toBe(true);
    expect(Object.keys(Work)).toEqual(["handOver", "uncovered", "toString"]);
    expect(Work[SERVICE]).toBe("work.Work");
    expect(Object.keys(Work[OPERATIONS])).toEqual(["handOver", "uncovered", "toString"]);
    expect(Object.isFrozen(Work[OPERATIONS])).toBe(true);
    expect(isServiceValue(Work)).toBe(true);
    expect(isServiceValue(Task)).toBe(false);
    expect(isEntityValue(Work)).toBe(false);
    expect(isServiceValue({ [SERVICE]: 1 })).toBe(false);
  });

  test("an operation named toString is a plain member, called like any other", async () => {
    const { binding } = world();
    hooks.bodies["work.Work#toString"] = () => "ran";
    expect(await binding.run(() => Work.toString({}))).toBe("ran");
  });

  test("two service values with one FQN in one domain are refused by bindDomain", () => {
    const twin = service("work.Work", {}, () => ({}));
    expect(() => bindDomain({ Work, twin }, memoryLayer().layer, {}, frame)).toThrow(new FrameworkError("Two service values in the domain have the FQN work.Work"));
    // The same value reached twice (a barrel and a namespace) is one, and a value bound with another frame is refused.
    expect(() => bindDomain({ Work, again: Work }, memoryLayer().layer, {}, frame)).not.toThrow();
    expect(() => bindDomain({ Work }, memoryLayer().layer, {}, new AsyncLocalStorage())).toThrow(/bound before with another async frame/);
  });

  test("an operation outside any binding is not connected; connect() makes the binding the one it runs on", async () => {
    const { binding } = world();
    hooks.bodies["work.Work#handOver"] = () => "ran";
    expect((await rejection(() => Work.handOver({ task: "t" }, actor))).message).toBe(
      "work.Work#handOver was called while not connected: call connect() first, or call it inside run() of bind(db) with a data layer of your own");
    connectBinding(binding);
    try {
      expect(await Work.handOver({ task: "t" }, actor)).toBe("ran");
    } finally {
      releaseBinding(binding);
    }
    expect(await rejection(() => Work.handOver({ task: "t" }, actor))).toBeInstanceOf(FrameworkError);
  });
});

describe("the operation lifecycle", () => {
  test("a listed call commits, inside one transaction, and the call resolves with what the body returns, as plain values", async () => {
    const { binding, state } = world();
    hooks.bodies["work.Work#handOver"] = async ({ input, context }) => {
      const task = await Task.create({ title: input.task }, context);
      return Task.complete({ id: task.id, done: true }, context);
    };
    const result = await binding.run(() => Work.handOver({ task: "write" }, actor)) as Record<string, unknown>;
    expect(result).toMatchObject({ title: "write", done: true });
    expect(Object.isFrozen(result)).toBe(false);
    expect(rows(state, "tasks")).toEqual([expect.objectContaining({ title: "write", done: true })]);
    expect(state.opened).toBe(1);
  });

  test("a failed cast rejects with InvalidInputError and runs nothing: no policy, no transaction, no body", async () => {
    const { binding, state } = world();
    let ran = false;
    hooks.actorOnly = () => { ran = true; return true; };
    hooks.bodies["work.Work#handOver"] = () => { ran = true; };
    const error = await rejection(() => binding.run(() => Work.handOver({ task: 1 }, actor)));
    expect(error).toBeInstanceOf(InvalidInputError);
    expect(ran).toBe(false);
    expect(state.opened).toBe(0);
  });

  test("an operation no policy covers is ForbiddenError before any transaction or seam, naming the service and the operation", async () => {
    const log: string[] = [];
    const { binding, state } = world({ beforeTransaction: () => { log.push("before"); }, afterCommit: () => { log.push("after"); } });
    hooks.bodies["work.Work#uncovered"] = () => { log.push("body"); };
    const error = await rejection(() => binding.run(() => Work.uncovered({}, actor))) as ForbiddenError;
    expect(error).toBeInstanceOf(ForbiddenError);
    expect([error.entity, error.action, error.reason, error.policies]).toEqual(["work.Work", "uncovered", "not-covered", []]);
    expect(state.opened).toBe(0);
    expect(log).toEqual([]);
  });

  test("a check that reads only the actor and fails denies before the transaction opens", async () => {
    const { binding, state } = world();
    let deep = false;
    hooks.actorOnly = ({ actor: who }) => who != null;
    hooks.deep = () => { deep = true; return true; };
    const error = await rejection(() => binding.run(() => Work.handOver({ task: "t" }))) as ForbiddenError;
    expect([error.entity, error.action, error.policies]).toEqual(["work.Work", "handOver", ["members"]]);
    expect(state.opened).toBe(0);
    expect(deep).toBe(false);
  });

  test("a check with record: true (a helper call) that returns false denies from inside the transaction, which writes nothing", async () => {
    const { binding, state } = world();
    let body = false;
    hooks.deep = async () => false;
    hooks.bodies["work.Work#handOver"] = () => { body = true; };
    const error = await rejection(() => binding.run(() => Work.handOver({ task: "t" }, actor))) as ForbiddenError;
    expect(error).toBeInstanceOf(ForbiddenError);
    expect(error.policies).toEqual(["deep"]);
    expect(state.opened).toBe(1);
    expect(body).toBe(false);
  });

  test("a policy that reads an entity no uses line lists through Mesh.privileged is evaluated, not refused", async () => {
    const { binding } = world();
    await binding.run(() => Member.create({ name: "u1" }));
    hooks.deep = async ({ actor: who }) => (await Mesh.privileged(Member).read({})).some((row) => row.name === (who as { id: string }).id);
    hooks.bodies["work.Work#handOver"] = () => "admitted";
    expect(await binding.run(() => Work.handOver({ task: "t" }, actor))).toBe("admitted");
    expect(await rejection(() => binding.run(() => Work.handOver({ task: "t" }, { actor: { id: "u2" } })))).toBeInstanceOf(ForbiddenError);
  });

  test("the body reads input, actor and context, and the context reaches the entity calls only as the body passes it", async () => {
    const { binding } = world();
    const seen: unknown[] = [];
    hooks.policies["work.Task#create"] = (s) => { seen.push((s as { context: unknown }).context); return true; };
    hooks.bodies["work.Work#handOver"] = async ({ input, actor: who, context }) => {
      seen.push(input, who, context);
      await Task.create({ title: "x" });
    };
    await binding.run(() => Work.handOver({ task: "t" }, actor));
    expect(seen).toEqual([{ task: "t" }, { id: "u1" }, actor, {}]);
  });

  test("an entity action in the body that fails its check rolls the whole operation back, also when the body catches it", async () => {
    const { binding, state } = world();
    hooks.bodies["work.Work#handOver"] = async ({ context }) => {
      const task = await Task.create({ title: "x" }, context);
      await Task.complete({ id: task.id, fail: true }, context);
    };
    expect(await rejection(() => binding.run(() => Work.handOver({ task: "t" }, actor)))).toBeInstanceOf(InvalidInputError);
    hooks.bodies["work.Work#handOver"] = async ({ context }) => {
      const task = await Task.create({ title: "x" }, context);
      await Task.complete({ id: task.id, fail: true }, context).catch(() => undefined);
      return "caught";
    };
    const caught = await rejection(() => binding.run(() => Work.handOver({ task: "t" }, actor)));
    expect(caught).toBeInstanceOf(FrameworkError);
    expect((caught as { cause?: unknown }).cause).toBeInstanceOf(InvalidInputError);
    expect(rows(state, "tasks")).toEqual([]);
  });
});

describe("the uses check", () => {
  const unlisted = (what: string, action: string, entity: string) =>
    `work.Work#handOver called ${what}, which its \`uses\` lines do not list: add :${action} to \`uses entity=${entity} actions=[...]\``;

  test("an unlisted direct call is refused and rolls back the earlier writes, also when the body catches the refusal", async () => {
    const { binding, state } = world();
    let created = false;
    hooks.steps["work.Claim#create"] = () => { created = true; };
    hooks.bodies["work.Work#handOver"] = async ({ context }) => {
      await Task.create({ title: "x" }, context);
      await Claim.create({ task: "x" }, context);
    };
    const error = await rejection(() => binding.run(() => Work.handOver({ task: "t" }, actor)));
    expect(error).toEqual(new FrameworkError(unlisted("work.Claim#create", "create", "Claim")));
    hooks.bodies["work.Work#handOver"] = async ({ context }) => {
      await Task.create({ title: "x" }, context);
      await Task.destroy({ id: "x" }, context).catch(() => undefined);
    };
    const caught = await rejection(() => binding.run(() => Work.handOver({ task: "t" }, actor)));
    expect((caught as { cause?: unknown }).cause).toEqual(new FrameworkError(unlisted("work.Task#destroy", "destroy", "Task")));
    expect(created).toBe(false);
    expect(rows(state, "tasks")).toEqual([]);
  });

  test("an unlisted call is refused before its input is cast: the refusal is the uses check's, not InvalidInputError", async () => {
    const { binding } = world();
    hooks.bodies["work.Work#handOver"] = ({ context }) => Task.destroy({}, context);
    expect(await rejection(() => binding.run(() => Work.handOver({ task: "t" }, actor)))).toEqual(new FrameworkError(unlisted("work.Task#destroy", "destroy", "Task")));
  });

  test("a Mesh.privileged read of an entity the uses lines list without :read is refused", async () => {
    const Writer = service("work.Writer", { go: { schema: schemaOf(), policies: [{ name: "open", when: null, checks: [{ kind: "authorize-if", check: "() => true", record: false, run: () => true }] }], uses: { "work.Task": ["create"] }, body: () => Mesh.privileged(Task).read({}) } },
      (call) => ({ go: (input: object, context?: object) => call("go", input, [context]) }));
    const binding = bindDomain({ ...domain, Writer }, memoryLayer().layer, {}, frame);
    expect(await rejection(() => binding.run(() => Writer.go({}, actor)))).toEqual(new FrameworkError(
      "work.Writer#go called Mesh.privileged(work.Task).read, which its `uses` lines do not list: add :read to `uses entity=Task actions=[...]`"));
  });

  test("Mesh.privileged reads are held to the uses lines: a listed one runs, an unlisted one is refused and rolls back", async () => {
    const { binding, state } = world();
    hooks.bodies["work.Work#handOver"] = async () => (await Mesh.privileged(Claim).read({})).length;
    expect(await binding.run(() => Work.handOver({ task: "t" }, actor))).toBe(0);
    hooks.bodies["work.Work#handOver"] = async ({ context }) => {
      await Task.create({ title: "x" }, context);
      return Mesh.privileged(Member).read({});
    };
    expect(await rejection(() => binding.run(() => Work.handOver({ task: "t" }, actor))))
      .toEqual(new FrameworkError(unlisted("Mesh.privileged(work.Member).read", "read", "Member")));
    expect(rows(state, "tasks")).toEqual([]);
  });

  test("a policy question is held to the uses lines: about a listed action it answers, about an unlisted one it is refused", async () => {
    const { binding, state } = world();
    hooks.bodies["work.Work#handOver"] = () => Mesh.can(Task.create as never, { title: "x" } as never, {});
    expect(await binding.run(() => Work.handOver({ task: "t" }, actor))).toBe(true);
    hooks.bodies["work.Work#handOver"] = async ({ context }) => {
      await Task.create({ title: "x" }, context);
      return Mesh.checkPolicies(Task.destroy as never, { id: "x" } as never, {}).catch(() => "caught");
    };
    const error = await rejection(() => binding.run(() => Work.handOver({ task: "t" }, actor)));
    expect((error as { cause?: unknown }).cause).toEqual(new FrameworkError(unlisted("Mesh.checkPolicies(work.Task#destroy)", "destroy", "Task")));
    expect(rows(state, "tasks")).toEqual([]);
  });

  test("a call a listed action makes from its own step is the action's work, not the operation's, and is not checked", async () => {
    const { binding, state } = world();
    hooks.steps["work.Task#create"] = ({ row, context }) => Claim.create({ task: row!.id }, context as object);
    hooks.bodies["work.Work#handOver"] = ({ context }) => Task.create({ title: "x" }, context);
    await binding.run(() => Work.handOver({ task: "t" }, actor));
    expect(rows(state, "claims")).toHaveLength(1);
  });

  test("a read of a listed entity that loads an unlisted one runs: the load is part of the read", async () => {
    const { binding } = world();
    await binding.run(() => Task.create({ title: "x" }));
    hooks.bodies["work.Work#handOver"] = () => Task.read({ load: ["claims"] });
    expect(await binding.run(() => Work.handOver({ task: "t" }, actor))).toEqual([expect.objectContaining({ title: "x", claims: [] })]);
  });

  test("a helper that opens transaction(fn) or run(fn) inside the body is still held to the uses lines", async () => {
    const { binding } = world();
    for (const open of [(fn: () => Promise<unknown>) => binding.transaction(fn), (fn: () => Promise<unknown>) => binding.run(fn)]) {
      hooks.bodies["work.Work#handOver"] = ({ context }) => open(() => Claim.create({ task: "x" }, context));
      expect(await rejection(() => binding.run(() => Work.handOver({ task: "t" }, actor)))).toEqual(new FrameworkError(unlisted("work.Claim#create", "create", "Claim")));
    }
  });

  test("an operation with only Mesh.privileged reads writes nothing and commits", async () => {
    const { binding, state } = world();
    hooks.bodies["work.Work#handOver"] = async () => (await Mesh.privileged(Task).read({})).length;
    expect(await binding.run(() => Work.handOver({ task: "t" }, actor))).toBe(0);
    expect(state.opened).toBe(1);
  });
});

describe("where an operation may be called (R17)", () => {
  const R17 = "an operation is called from application code, a handler, or a seam that runs outside a transaction (beforeTransaction, afterCommit), not from inside another operation or an action's transaction (its steps, checks, policies, afterWrite seam or a helper of them)";

  test("an operation called from inside another operation's body fails the running transaction", async () => {
    const { binding, state } = world();
    hooks.bodies["billing.Billing#charge"] = () => "charged";
    hooks.bodies["work.Work#handOver"] = async ({ context }) => {
      await Task.create({ title: "x" }, context);
      const helper = () => Billing.charge({}, context);
      return helper().catch(() => "caught");
    };
    const error = await rejection(() => binding.run(() => Work.handOver({ task: "t" }, actor)));
    expect((error as { cause?: unknown }).cause).toEqual(new FrameworkError(`billing.Billing#charge was called inside work.Work#handOver: ${R17}`));
    expect(rows(state, "tasks")).toEqual([]);
  });

  test("an operation called from an action's step fails that action's transaction", async () => {
    const { binding, state } = world();
    hooks.bodies["work.Work#handOver"] = () => "ran";
    hooks.steps["work.Task#create"] = ({ context }) => Work.handOver({ task: "t" }, context as object);
    const error = await rejection(() => binding.run(() => Task.create({ title: "x" }, actor)));
    expect(error.message).toBe(`work.Work#handOver was called inside work.Task#create: ${R17}`);
    expect(rows(state, "tasks")).toEqual([]);
  });

  test("an operation called through a helper of a step that opens transaction(fn) or run(fn) fails that action's transaction", async () => {
    const { binding, state } = world();
    hooks.bodies["work.Work#handOver"] = () => "ran";
    hooks.bodies["billing.Billing#charge"] = ({ context }) => Claim.create({ task: "paid" }, context);
    const opens = [(fn: () => Promise<unknown>) => binding.transaction(fn), (fn: () => Promise<unknown>) => binding.run(fn)];
    for (const open of opens) {
      for (const [op, call] of [["work.Work#handOver", (context: object) => Work.handOver({ task: "t" }, context)], ["billing.Billing#charge", (context: object) => Billing.charge({}, context)]] as const) {
        hooks.steps["work.Task#create"] = ({ context }) => open(() => call(context as object));
        const error = await rejection(() => binding.run(() => Task.create({ title: "x" }, actor)));
        expect(error).toEqual(new FrameworkError(`${op} was called inside work.Task#create: ${R17}`));
      }
    }
    expect(rows(state, "tasks")).toEqual([]);
    expect(rows(state, "claims")).toEqual([]);
  });

  test("an operation called from the policy of an action a step calls fails the outer action's transaction", async () => {
    const { binding, state } = world();
    hooks.bodies["billing.Billing#charge"] = () => "charged";
    hooks.policies["work.Claim#create"] = async () => { await Billing.charge({}, actor); return true; };
    hooks.steps["work.Task#create"] = ({ context }) => Claim.create({ task: "x" }, context as object);
    // The nested action's policy check fails the joined transaction; the refusal that follows carries R17's error.
    const error = await rejection(() => binding.run(() => Task.create({ title: "x" }, actor)));
    expect((error as { cause?: unknown }).cause).toEqual(new FrameworkError(`billing.Billing#charge was called inside work.Task#create: ${R17}`));
    expect(rows(state, "tasks")).toEqual([]);
    expect(rows(state, "claims")).toEqual([]);
  });

  test("an operation called from the policy of a listed action the body calls is refused: it cannot widen the uses lines", async () => {
    const { binding, state } = world();
    // Billing may create a Claim; Work may not, and must not get one through Task#create's policy.
    hooks.bodies["billing.Billing#charge"] = ({ context }) => Claim.create({ task: "x" }, context);
    hooks.policies["work.Task#create"] = async () => { await Billing.charge({}, actor); return true; };
    hooks.bodies["work.Work#handOver"] = ({ context }) => Task.create({ title: "x" }, context);
    const error = await rejection(() => binding.run(() => Work.handOver({ task: "t" }, actor)));
    expect((error as { cause?: unknown }).cause).toEqual(new FrameworkError(`billing.Billing#charge was called inside work.Work#handOver: ${R17}`));
    expect(rows(state, "tasks")).toEqual([]);
    expect(rows(state, "claims")).toEqual([]);
  });

  test("an operation's own policies: one checked inside its transaction may not call an operation, one checked before it may", async () => {
    const { binding, state } = world();
    hooks.bodies["billing.Billing#charge"] = ({ context }) => Claim.create({ task: "paid" }, context);
    hooks.bodies["work.Work#handOver"] = ({ context }) => Task.create({ title: "x" }, context);
    hooks.deep = async () => { await Billing.charge({}, actor); return true; };
    expect(await rejection(() => binding.run(() => Work.handOver({ task: "t" }, actor))))
      .toEqual(new FrameworkError(`billing.Billing#charge was called inside work.Work#handOver: ${R17}`));
    expect(rows(state, "claims")).toEqual([]);
    expect(rows(state, "tasks")).toEqual([]);
    delete hooks.deep;
    // A `before` policy runs before any transaction, as application code does: the call commits on its own.
    hooks.actorOnly = async () => { await Billing.charge({}, actor); return true; };
    await binding.run(() => Work.handOver({ task: "t" }, actor));
    expect(rows(state, "claims")).toHaveLength(1);
    expect(rows(state, "tasks")).toHaveLength(1);
  });

  test("a beforeTransaction or afterCommit seam may call an operation; an afterWrite seam, inside the action's transaction, may not", async () => {
    hooks.bodies["billing.Billing#charge"] = ({ context }) => Claim.create({ task: "paid" }, context);
    const charge = async ({ entity }: { entity: string }) => { if (entity === "work.Task") await Billing.charge({}, actor); };
    for (const seams of [{ beforeTransaction: charge }, { afterCommit: ({ changes }: { changes: readonly Change[] }) => charge({ entity: changes[0]!.entity }) }] as Seams[]) {
      const { binding, state } = world(seams);
      await binding.run(() => Task.create({ title: "x" }, actor));
      expect(rows(state, "tasks")).toHaveLength(1);
      expect(rows(state, "claims")).toHaveLength(1);
    }
    const { binding, state } = world({ afterWrite: (_db, { entity }) => charge({ entity }) });
    expect(await rejection(() => binding.run(() => Task.create({ title: "x" }, actor))))
      .toEqual(new FrameworkError(`billing.Billing#charge was called inside work.Task#create: ${R17}`));
    expect(rows(state, "tasks")).toEqual([]);
    expect(rows(state, "claims")).toEqual([]);
  });

  test("two operations run one after the other inside one application transaction, joining it: afterCommit runs once with every change", async () => {
    const commits: Change[][] = [];
    const before: string[] = [];
    const { binding, state } = world({ beforeTransaction: ({ entity, action }) => { before.push(`${entity}#${action}`); }, afterCommit: ({ changes }) => { commits.push([...changes]); } });
    hooks.bodies["work.Work#handOver"] = ({ input, context }) => Task.create({ title: input.task }, context);
    hooks.bodies["billing.Billing#charge"] = () => "charged";
    const result = await binding.transaction(async () => [await Work.handOver({ task: "a" }, actor), await Billing.charge({}, actor), await Work.handOver({ task: "b" }, actor)]);
    expect(result[1]).toBe("charged");
    expect(state.opened).toBe(1);
    expect(commits).toHaveLength(1);
    expect(commits[0]!.map((change) => change.after?.title)).toEqual(["a", "b"]);
    expect(before).toEqual([]);
  });

  test("no beforeTransaction runs for an operation or for any entity call inside it; afterCommit runs once, after the commit", async () => {
    const log: string[] = [];
    const { binding } = world({ beforeTransaction: ({ entity, action }) => { log.push(`before ${entity}#${action}`); }, afterCommit: ({ changes }) => { log.push(`after ${changes.length}`); } });
    hooks.bodies["work.Work#handOver"] = async ({ context }) => {
      const task = await Task.create({ title: "x" }, context);
      await Task.complete({ id: task.id, done: true }, context);
      log.push("body");
    };
    await binding.run(() => Work.handOver({ task: "t" }, actor));
    expect(log).toEqual(["body", "after 2"]);
  });

  test("an operation called from a process handler runs, and an event an action publishes inside it is caused by the handled event", async () => {
    const { binding, state } = world();
    hooks.bodies["work.Work#handOver"] = ({ context }) => Task.create({ title: "x", publish: true }, context);
    await handlerScope(binding, "handler :onPaid", "event-1", true, () => Work.handOver({ task: "t" }, actor));
    expect(state.outbox.map((row) => [row.name, row.causedBy])).toEqual([["work.TaskCreated", "event-1"]]);
  });
});

describe("one instant, the call chain and the refusals at entry", () => {
  test("the pre-check, the policies inside, the body and the calls it makes read one instant, also when the operation joins a transaction", async () => {
    let tick = 0;
    const { binding } = world(undefined, () => new Date(Date.UTC(2026, 0, 1, 0, 0, ++tick)));
    const instants: number[] = [];
    const read = (s: { clock: () => Date }) => instants.push(expr.now(s as never).getTime());
    hooks.actorOnly = (s) => { read(s); return true; };
    hooks.deep = (s) => { read(s); return true; };
    hooks.steps["work.Task#create"] = ({ clock }) => { instants.push(clock().getTime()); };
    hooks.bodies["work.Work#handOver"] = async (s) => { read(s); await Task.create({ title: "x" }, s.context); };
    await binding.run(() => Work.handOver({ task: "t" }, actor));
    expect(instants).toHaveLength(4);
    expect(new Set(instants).size).toBe(1);
    instants.length = 0;
    await binding.transaction(async () => {
      await Task.create({ title: "y" });
      await Work.handOver({ task: "t" }, actor);
    });
    expect(instants).toHaveLength(5);
    expect(new Set(instants).size).toBe(1);
  });

  test("settled(binding) waits for an operation in flight", async () => {
    const { binding } = world();
    let open!: () => void;
    const gate = new Promise<void>((resolve) => { open = resolve; });
    hooks.bodies["work.Work#handOver"] = () => gate;
    const call = binding.run(() => Work.handOver({ task: "t" }, actor));
    let waited = false;
    const done = settled(binding).then(() => { waited = true; });
    await Bun.sleep(5);
    expect(waited).toBe(false);
    open();
    await call;
    await done;
    expect(waited).toBe(true);
  });

  test("the call-depth cap counts through an operation: a cycle under it rejects the operation with the cap's error", async () => {
    const { binding, state } = world();
    hooks.steps["work.Task#create"] = ({ context }) => Task.create({ title: "again" }, context as object);
    hooks.bodies["work.Work#handOver"] = ({ context }) => Task.create({ title: "x" }, context);
    const error = await rejection(() => binding.run(() => Work.handOver({ task: "t" }, actor)));
    expect(error.message).toStartWith("work.Task#create was called more than 1000 nested calls deep, in a chain that began with work.Work#handOver");
    expect(rows(state, "tasks")).toEqual([]);
  });

  test("a call made after the operation settled starts a new call chain", async () => {
    const { binding } = world();
    hooks.steps["work.Task#create"] = ({ context }) => Task.create({ title: "again" }, context as object);
    let later: Promise<unknown> | undefined;
    hooks.bodies["work.Work#handOver"] = ({ context }) => {
      later = new Promise((resolve) => setTimeout(() => resolve(binding.transaction(() => Task.create({ title: "loop" }, context)).catch((error) => error)), 5));
    };
    await binding.run(() => Work.handOver({ task: "t" }, actor));
    expect(((await later) as Error).message).toStartWith("work.Task#create was called more than 1000 nested calls deep, in a chain that began with work.Task#create");
  });

  test("an operation whose body caught the cap's error rejects with the cap's error, not the rollback that wraps it", async () => {
    const { binding, state } = world();
    hooks.steps["work.Task#create"] = ({ context }) => Task.create({ title: "again" }, context as object);
    hooks.bodies["work.Work#handOver"] = ({ context }) => Task.create({ title: "x" }, context).catch(() => "caught");
    const error = await rejection(() => binding.run(() => Work.handOver({ task: "t" }, actor)));
    expect(error.message).toStartWith("work.Task#create was called more than 1000 nested calls deep, in a chain that began with work.Work#handOver");
    expect(rows(state, "tasks")).toEqual([]);
  });

  test("work the body leaves running past the operation is refused, as after an application transaction: the transaction has ended", async () => {
    const { binding, state } = world();
    let later: Promise<PromiseSettledResult<unknown>[]> | undefined;
    hooks.bodies["work.Work#handOver"] = ({ context }) => {
      later = new Promise((resolve) => setTimeout(() => resolve(Promise.allSettled([Task.create({ title: "late" }, context), Claim.create({ task: "late" }, context)])), 5));
    };
    await binding.run(() => Work.handOver({ task: "t" }, actor));
    const [task, claim] = await later!;
    expect(((task as PromiseRejectedResult).reason as Error).message).toStartWith("a call was made inside a transaction that has ended");
    // Still the operation's work: an unlisted call is refused by the uses check first.
    expect(((claim as PromiseRejectedResult).reason as Error).message).toStartWith("work.Work#handOver called work.Claim#create");
    expect(rows(state, "tasks")).toEqual([]);
  });

  test("an operation called while a computed field is evaluated throws", async () => {
    const { binding } = world();
    await binding.run(() => Task.create({ title: "x" }));
    hooks.computed = () => Work.handOver({ task: "t" }, actor);
    const error = await rejection(() => binding.run(() => Task.read({})));
    expect(error.message).toStartWith("work.Work#handOver was called while computed :lapsed of work.Task is evaluated");
  });

  test("an operation called while Mesh.checkPolicies is answered is refused as a write is", async () => {
    const { binding } = world();
    hooks.bodies["work.Work#handOver"] = () => "ran";
    hooks.policies["work.Task#create"] = async () => { await Work.handOver({ task: "t" }, actor); return true; };
    const error = await rejection(() => binding.run(() => Mesh.checkPolicies(Task.create as never, { title: "x" } as never, {})));
    expect(error).toBeInstanceOf(FrameworkError);
    expect(error.message).toStartWith("Mesh.checkPolicies(work.Task#create) cannot answer without writing: work.Work#handOver, called while its policies were checked, writes a row");
  });

  test("a delete, guarded or not, on a read's transaction while Mesh.checkPolicies is answered is refused as a write", async () => {
    const guard = { checks: [false], policies: [{ forbid: [], authorize: [0] }] };
    const writes = {
      deleteByKey: (tx: DataOperations) => tx.deleteByKey(tables.tasks, { id: "t" }),
      deleteByKeyGuarded: (tx: DataOperations) => tx.deleteByKeyGuarded!(tables.tasks, { id: "t" }, guard),
    };
    for (const [name, write] of Object.entries(writes)) {
      reset();
      const { binding } = world();
      hooks.read = write;
      hooks.policies["work.Task#create"] = async () => { await Task.read({}); return true; };
      const error = await rejection(() => binding.run(() => Mesh.checkPolicies(Task.create as never, { title: "x" } as never, {})));
      expect(error, name).toBeInstanceOf(FrameworkError);
      expect(error.message, name).toStartWith("Mesh.checkPolicies(work.Task#create) cannot answer without writing: a call made while its policies were checked writes a row");
    }
  });

  test("an operation of a value no binding of the project binds is refused inside another binding's run", async () => {
    const lone = service("work.Lone", { go: { schema: schemaOf(), policies: [], uses: {}, body: () => undefined } }, (call) => ({ go: (input: object) => call("go", input, []) }));
    bindDomain({ lone }, memoryLayer().layer, {}, frame);
    const { binding } = world();
    expect((await rejection(() => binding.run(() => lone.go({})))).message).toStartWith("work.Lone#go was called inside run() or transaction() of a binding that does not bind it");
  });

  test("the binding's own run and transaction are unchanged: a Binding has exactly its four members", () => {
    const { binding } = world();
    expect(Object.keys(binding as Binding).sort()).toEqual(["deliver", "run", "startDelivery", "transaction"]);
  });
});
