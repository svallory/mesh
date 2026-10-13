import { describe, expect, test } from "bun:test";
import { AsyncLocalStorage } from "node:async_hooks";
import {
  BIND,
  BIND_READS,
  ENTITY,
  bindDomain,
  entity,
  bindingInScope,
  connectBinding,
  cloneValue,
  FrameworkError,
  isEntityValue,
  Mesh,
  releaseBinding,
  settled,
  type Privileged,
  type Seams,
} from "../src/index.ts";
import * as clash from "./entity-domain/clash.ts";
import * as domain from "./entity-domain/fake.ts";
import { gate, layerNamed, Task } from "./entity-domain/fake.ts";
import * as framed from "./entity-domain/framed.ts";
import { Account, joiningLayer } from "./entity-domain/framed.ts";
import * as other from "./entity-domain/other.ts";

/**
 * Entity values and bindings (CMP-16, PRJ-13, PRJ-19) over a fake domain whose actions report what they ran on. The
 * generated code calls the same functions: an actions file defines its entity value with `entity`, and `binding.ts`'s
 * `bind` is `bindDomain` over the root barrel, with the project's one `AsyncLocalStorage` as its frame.
 */
const frame = new AsyncLocalStorage<unknown>();
const seams = (label: string): Seams => ({ afterCommit: () => void label });

describe("entity values", () => {
  test("an entity value has a null prototype, is frozen and holds one member per action; Mesh's internals are symbols", () => {
    expect(Object.getPrototypeOf(Task)).toBeNull();
    expect(Object.isFrozen(Task)).toBe(true);
    expect(Object.keys(Task)).toEqual(["open", "toString", "constructor"]);
    expect(Task[ENTITY]).toBe("work.Task");
    expect(typeof Task[BIND]).toBe("function");
    expect(typeof Task[BIND_READS]).toBe("function");
    expect(domain.sales.Order[BIND_READS]).toBeNull();
    expect(isEntityValue(Task)).toBe(true);
    expect(isEntityValue(domain.loadTaskFields)).toBe(false);
    expect(isEntityValue({ [ENTITY]: 1 })).toBe(false);
  });

  test("an action named toString or constructor is a plain member, called like any other", async () => {
    const binding = bindDomain(domain, layerNamed("db"), {}, frame);
    const [named, built] = await binding.run(async () => [await Task.toString({ n: 1 }), await Task.constructor({ n: 2 })]);
    expect(named.input).toEqual({ n: 1 });
    expect(built.input).toEqual({ n: 2 });
    // Not Object.prototype's: the value has none, so string conversion of it fails rather than calling the action.
    expect(() => `${Task as unknown as string}`).toThrow(TypeError);
  });

  test("the context arguments reach the bound action as they were passed", async () => {
    const binding = bindDomain(domain, layerNamed("db"), {}, frame);
    expect((await binding.run(() => Task.open({ title: "a" }, { actor: "x" }))).context).toEqual({ actor: "x" });
    expect((await binding.run(() => Task.open({ title: "a" }))).context).toBeUndefined();
  });
});

describe("bindDomain", () => {
  test("binds the entity values of every namespace it reaches and skips every other export", async () => {
    const binding = bindDomain(domain, layerNamed("db"), {}, frame);
    expect(Object.isFrozen(binding)).toBe(true);
    expect(Object.keys(binding).sort()).toEqual(["run", "transaction"]);
    const placed = await binding.run(() => domain.sales.Order.place({ total: 3 }));
    expect(placed).toMatchObject({ layer: "db", input: { total: 3 } });
  });

  test("Mesh.privileged(Task) holds the binding's reads of Task, frozen, each run with the context it is given and no policy", async () => {
    const binding = bindDomain(domain, layerNamed("db"), {}, frame);
    const reads = await binding.run(async () => Mesh.privileged(Task));
    expect(Object.isFrozen(reads)).toBe(true);
    expect(Object.keys(reads)).toEqual(["read"]);
    const read = await binding.transaction(() => Mesh.privileged(Task).read({ limit: 1 }, { actor: "t" }));
    expect(read).toEqual([{ layer: "db", options: {}, input: { limit: 1 }, context: { actor: "t" } }]);
    // An entity with no read action has no privileged read.
    expect(Object.keys(await binding.run(async () => Mesh.privileged(domain.sales.Order)))).toEqual([]);
  });

  test("transaction(fn) hands fn nothing (TXN-20)", async () => {
    const binding = bindDomain(domain, layerNamed("db"), {}, frame);
    expect(await binding.transaction(async (...args: unknown[]) => args.length)).toBe(0);
  });

  test("two bindings on one data layer keep their own options inside run, concurrently", async () => {
    const layer = layerNamed("shared");
    const first = { seams: seams("first") };
    const second = { seams: seams("second") };
    const a = bindDomain(domain, layer, first, frame);
    const b = bindDomain(domain, layer, second, frame);
    const [fromA, fromB] = await Promise.all([
      a.run(async () => {
        await Promise.resolve();
        return Task.open({ title: "a" });
      }),
      b.run(() => Task.open({ title: "b" })),
    ]);
    expect(fromA.options).toBe(first);
    expect(fromB.options).toBe(second);
    expect(fromA.layer).toBe("shared");
  });

  test("a nested run uses the innermost binding, and the outer one again after it", async () => {
    const outer = bindDomain(domain, layerNamed("outer"), {}, frame);
    const inner = bindDomain(domain, layerNamed("inner"), {}, frame);
    const seen = await outer.run(async () => {
      const before = (await Task.open({ title: "1" })).layer;
      const nested = await inner.run(async () => {
        expect(bindingInScope(frame)).toBe(inner);
        return (await Task.open({ title: "2" })).layer;
      });
      expect(bindingInScope(frame)).toBe(outer);
      const after = (await Task.open({ title: "3" })).layer;
      return [before, nested, after];
    });
    expect(seen).toEqual(["outer", "inner", "outer"]);
    expect(bindingInScope(frame)).toBeUndefined();
  });

  test("a binding's transaction puts it in scope for the entity calls its callback makes", async () => {
    const binding = bindDomain(domain, layerNamed("tx"), {}, frame);
    const ran = await binding.transaction(async () => {
      expect(bindingInScope(frame)).toBe(binding);
      return Task.open({ title: "t" });
    });
    expect(ran.layer).toBe("tx");
  });

  test("a call outside any run uses the connected binding; with neither, it rejects as not connected", async () => {
    await expect(Task.open({ title: "x" })).rejects.toThrow(
      new FrameworkError("work.Task#open was called while not connected: call connect() first, or call it inside run() of bind(db) with a data layer of your own"),
    );
    const connected = bindDomain(domain, layerNamed("connected"), {}, frame);
    const scoped = bindDomain(domain, layerNamed("scoped"), {}, frame);
    connectBinding(connected);
    try {
      expect((await Task.open({ title: "x" })).layer).toBe("connected");
      expect((await domain.sales.Order.place({ total: 1 })).layer).toBe("connected");
      expect((await scoped.run(() => Task.open({ title: "y" }))).layer).toBe("scoped");
    } finally {
      releaseBinding(connected);
    }
    await expect(Task.open({ title: "x" })).rejects.toBeInstanceOf(FrameworkError);
  });

  test("an entity value no binding knows is not connected, even inside run() of a binding", async () => {
    const stray = entity("work.Task", () => Object.freeze({ async open() { return "stray"; } }), null, (call) => ({
      open(input: { readonly title: string }): Promise<string> {
        return call("open", input, []);
      },
    }));
    const binding = bindDomain(domain, layerNamed("db"), {}, frame);
    await expect(binding.run(() => stray.open({ title: "x" }))).rejects.toThrow(/^work\.Task#open was called while not connected/);
  });

  test("an entity value the binding in scope did not bind is refused, even with the same FQN", async () => {
    // Bound by another binding of the same frame: a second copy of the project's barrels, which never happens in one build.
    bindDomain(other, layerNamed("other"), {}, frame);
    const binding = bindDomain(domain, layerNamed("db"), {}, frame);
    await expect(binding.run(() => other.Task.open({ title: "x" }))).rejects.toThrow(/work\.Task#open was called inside run\(\) or transaction\(\) of a binding that does not bind it/);
  });

  test("an entity value bound with one async frame is refused by a binding with another", () => {
    bindDomain(domain, layerNamed("db"), {}, frame);
    expect(() => bindDomain(domain, layerNamed("db"), {}, new AsyncLocalStorage<unknown>())).toThrow(
      new FrameworkError("work.Task was bound before with another async frame: a project's entity values are bound only through its own bind()"),
    );
  });

  test("two entities with one name in two modules bind side by side", async () => {
    const binding = bindDomain(clash, layerNamed("db"), {}, frame);
    const [sales, billing] = await binding.run(async () => [await clash.Order.place({ total: 1 }), await clash.billing.Order.place({ total: 2 })]);
    expect(sales).toMatchObject({ layer: "db", input: { total: 1 } });
    expect(billing).toBe("billing");
  });

  test("after disconnect() released the connected binding, a call left in its scope is not connected; one in flight goes on", async () => {
    const connected = bindDomain(domain, layerNamed("connected"), {}, frame);
    connectBinding(connected);
    let fire!: () => void;
    const later = new Promise<void>((resolve) => (fire = resolve));
    let stray!: Promise<unknown>;
    let open!: () => void;
    gate.wait = new Promise<void>((resolve) => (open = resolve));
    let nested!: Promise<unknown>;
    try {
      // A continuation chained inside the binding's transaction keeps the binding in scope after the transaction ends.
      await connected.transaction(async () => {
        stray = later.then(() => Task.open({ title: "late" }));
      });
      // A transaction still running when disconnect() releases the binding: the calls it makes go on.
      const running = connected.transaction(async () => {
        await gate.wait;
        nested = Task.open({ title: "inside" });
        return nested;
      });
      releaseBinding(connected);
      expect(bindingInScope(frame)).toBeUndefined();
      open();
      expect(await running).toMatchObject({ layer: "connected", input: { title: "inside" } });
      await settled(connected);
      fire();
      await expect(stray).rejects.toThrow(/^work\.Task#open was called while not connected/);
      await expect(connected.run(async () => bindingInScope(frame))).resolves.toBeUndefined();
    } finally {
      delete gate.wait;
      releaseBinding(connected);
    }
  });

  test("after disconnect() released the connected binding, a call left in a scope that has settled is not connected, even while another call on it is in flight", async () => {
    const connected = bindDomain(domain, layerNamed("connected"), {}, frame);
    connectBinding(connected);
    let fire!: () => void;
    const later = new Promise<void>((resolve) => (fire = resolve));
    let stray!: Promise<unknown>;
    let open!: () => void;
    try {
      await connected.run(async () => {
        stray = later.then(() => Task.open({ title: "late" }));
      });
      gate.wait = new Promise<void>((resolve) => (open = resolve));
      const running = connected.run(() => Task.open({ title: "slow" }));
      releaseBinding(connected);
      fire();
      await expect(stray).rejects.toThrow(/^work\.Task#open was called while not connected/);
      open();
      expect(await running).toMatchObject({ input: { title: "slow" } });
    } finally {
      delete gate.wait;
      releaseBinding(connected);
    }
  });

  test("settled waits for an entity call in flight, however long it takes", async () => {
    const binding = bindDomain(domain, layerNamed("db"), {}, frame);
    let open!: () => void;
    gate.wait = new Promise<void>((resolve) => (open = resolve));
    try {
      const call = binding.run(() => Task.open({ title: "slow" }));
      let done = false;
      const waiting = settled(binding).then(() => (done = true));
      await new Promise((resolve) => setTimeout(resolve, 5));
      expect(done).toBe(false);
      open();
      await waiting;
      expect(done).toBe(true);
      expect((await call).input).toEqual({ title: "slow" });
    } finally {
      delete gate.wait;
    }
    await settled(binding);
  });

  test("a value that is not a binding is refused by connectBinding and settled", async () => {
    expect(() => connectBinding({ run: async () => {}, transaction: async () => {} } as never)).toThrow(FrameworkError);
    await expect(settled({} as never)).rejects.toBeInstanceOf(FrameworkError);
  });
});

describe("the call frame (TXN-16, TXN-18, ACT-09)", () => {
  const ENDED = new FrameworkError("a call was made inside a transaction that has ended: await every entity call and privileged read before the function or the transaction callback returns");

  test("inside an action's function, an entity call and a privileged read join its transaction and resolve with read-only views", async () => {
    const { layer, opened } = joiningLayer();
    const binding = bindDomain(framed, layer, {}, frame);
    const result = await binding.run(() => Account.act({
      step: async () => {
        const nested = await Account.act({});
        expect(() => { nested.tags.push("b"); }).toThrow(/bank\.Account#act/);
        const [row] = await Mesh.privileged(Account).read({});
        expect(() => { row!.id = 2; }).toThrow(FrameworkError);
        return "stepped";
      },
    }));
    expect(opened).toHaveLength(1);
    // The caller outside any action gets the plain value.
    result.tags.push("b");
    expect(result).toEqual({ id: 1, tags: ["a", "b"], stepped: "stepped" });
  });

  test("inside the application's transaction, an entity call and a privileged read join it and resolve with plain values", async () => {
    const { layer, opened } = joiningLayer();
    const binding = bindDomain(framed, layer, {}, frame);
    const [acted, row] = await binding.transaction(async () => {
      const acted = await Account.act({});
      acted.tags.push("b");
      const [row] = await Mesh.privileged(Account).read({});
      row!.id = 2;
      return [acted, row] as const;
    });
    expect(opened).toHaveLength(1);
    expect(acted.tags).toEqual(["a", "b"]);
    expect(row!.id).toBe(2);
  });

  test("a privileged read inside an action reads the action's instant and only the context it is given, never the action's", async () => {
    const binding = bindDomain(framed, joiningLayer().layer, {}, frame);
    const seen: framed.Row[] = [];
    await binding.run(() => Account.act({
      at: 42,
      step: async () => {
        // Read-only views: copied to compare them.
        seen.push(...cloneValue(await Mesh.privileged(Account).read({})));
        seen.push(...cloneValue(await Mesh.privileged(Account).read({}, { actor: "given" })));
      },
    }, { actor: "running" }));
    expect(seen.map(({ at, context, policies }) => ({ at, context, policies }))).toEqual([
      { at: new Date(42), context: null, policies: false },
      { at: new Date(42), context: { actor: "given" }, policies: false },
    ]);
    // Outside any action it has no instant to read: the read takes its own.
    const [outside] = await binding.run(() => Mesh.privileged(Account).read({}));
    expect(outside!.at).toBeNull();
  });

  test("an entity call or privileged read a function leaves running after its action's transaction ended is refused", async () => {
    const binding = bindDomain(framed, joiningLayer().layer, {}, frame);
    let fire!: () => void;
    const later = new Promise<void>((resolve) => (fire = resolve));
    let call!: Promise<unknown>;
    let read!: Promise<unknown>;
    await binding.run(() => Account.act({
      step: () => {
        call = later.then(() => Account.act({})).catch((error: unknown) => error);
        read = later.then(() => Mesh.privileged(Account).read({})).catch((error: unknown) => error);
      },
    }));
    fire();
    expect(await call).toEqual(ENDED);
    expect(await read).toEqual(ENDED);
  });

  test("a call the application's transaction callback leaves running after it returned is refused", async () => {
    const binding = bindDomain(framed, joiningLayer().layer, {}, frame);
    let fire!: () => void;
    const later = new Promise<void>((resolve) => (fire = resolve));
    let call!: Promise<unknown>;
    await binding.transaction(async () => {
      call = later.then(() => Account.act({}));
    });
    fire();
    await expect(call).rejects.toThrow(ENDED);
  });

  test("during disconnect(), an action in flight goes on two levels deep: a step of a nested action calls another action", async () => {
    const binding = bindDomain(framed, joiningLayer().layer, {}, frame);
    connectBinding(binding);
    let open!: () => void;
    const gate = new Promise<void>((resolve) => (open = resolve));
    try {
      const running = Account.act({
        step: async () => {
          await gate;
          return (await Account.act({ step: async () => (await Account.act({})).id })).stepped;
        },
      });
      releaseBinding(binding);
      const closing = settled(binding);
      open();
      expect(await running).toMatchObject({ stepped: 1 });
      await closing;
    } finally {
      releaseBinding(binding);
    }
  });

  test("during disconnect(), the application's transaction in flight goes on: a step of an action it calls reads through privileged", async () => {
    const binding = bindDomain(framed, joiningLayer().layer, {}, frame);
    connectBinding(binding);
    let open!: () => void;
    const gate = new Promise<void>((resolve) => (open = resolve));
    try {
      const running = binding.transaction(async () => {
        await gate;
        return Account.act({ step: async () => (await Mesh.privileged(Account).read({}))[0]!.id });
      });
      releaseBinding(binding);
      const closing = settled(binding);
      open();
      expect(await running).toMatchObject({ stepped: 1 });
      await closing;
      // Once it settled, the binding is gone.
      await expect(binding.run(() => Account.act({}))).rejects.toThrow(/^bank\.Account#act was called while not connected/);
    } finally {
      releaseBinding(binding);
    }
  });

  test("privileged and an entity call throw while a computed field is evaluated, naming the field (TXN-18)", async () => {
    const binding = bindDomain(framed, joiningLayer().layer, {}, frame);
    const message = (what: string) => `${what} was called while computed :balance of bank.Account is evaluated: a computed field and a read policy read the record and what it loads, and call no action, make no privileged read and ask no action's policies. Load what it needs instead, or do it in a step or a check`;
    await expect(binding.run(() => Account.read({ computed: () => Mesh.privileged(Account) }))).rejects.toThrow(new FrameworkError(message("Mesh.privileged(bank.Account)")));
    const reads = await binding.run(async () => Mesh.privileged(Account));
    await expect(binding.run(() => Account.read({ computed: () => reads.read({}) }))).rejects.toThrow(new FrameworkError(message("Mesh.privileged(bank.Account).read")));
    // So is an entity call.
    await expect(binding.run(() => Account.read({ computed: () => Account.act({}) }))).rejects.toThrow(new FrameworkError(message("bank.Account#act")));
    // All refuse by throwing, not by rejecting: a handle obtained before the mark too, and an entity call.
    const refusesBy = (call: () => Promise<unknown>) => { try { call().catch(() => undefined); return "returned"; } catch { return "threw"; } };
    expect((await binding.run(() => Account.read({ computed: () => refusesBy(() => reads.read({})) })))[0]!.computed).toBe("threw");
    expect((await binding.run(() => Account.read({ computed: () => refusesBy(() => Account.act({})) })))[0]!.computed).toBe("threw");
    // A privileged read's own computed fields are evaluated under the same rule.
    await expect(binding.run(() => Mesh.privileged(Account).read({ computed: () => Mesh.privileged(Account) }))).rejects.toThrow(FrameworkError);
    // Outside the evaluation, it reads.
    expect((await binding.run(() => Account.read({ computed: () => "plain" })))[0]!.computed).toBe("plain");
  });

  test("privileged and an entity call throw while a read policy is evaluated, naming the policy (TXN-18)", async () => {
    const binding = bindDomain(framed, joiningLayer().layer, {}, frame);
    const message = (what: string) => `${what} was called while policy :mine of bank.Account is evaluated: a computed field and a read policy read the record and what it loads, and call no action, make no privileged read and ask no action's policies. Load what it needs instead, or do it in a step or a check`;
    await expect(binding.run(() => Account.read({ policy: () => Mesh.privileged(Account) }))).rejects.toThrow(new FrameworkError(message("Mesh.privileged(bank.Account)")));
    await expect(binding.run(() => Account.read({ policy: () => Account.act({}) }))).rejects.toThrow(new FrameworkError(message("bank.Account#act")));
    // A policy check may await: a call made after the await is still refused.
    await expect(binding.run(() => Account.read({ policy: async () => { await Promise.resolve(); return Account.act({}); } }))).rejects.toThrow(new FrameworkError(message("bank.Account#act")));
    expect(await binding.run(() => Account.read({ policy: () => true }))).toHaveLength(1);
  });

  test("privileged of a value that is not an entity value is a FrameworkError; of one no binding has bound, not connected", async () => {
    expect(() => Mesh.privileged({} as never)).toThrow(new FrameworkError("Mesh.privileged() takes an entity value, such as Mesh.privileged(Task), and was given an object that is not one"));
    expect(() => Mesh.privileged(undefined as never)).toThrow(/was given undefined$/);
    const Unbound = entity("x.Unbound", () => ({}), () => ({ read: async (_input: object) => [] }), () => ({}));
    expect(() => Mesh.privileged(Unbound)).toThrow(new FrameworkError("Mesh.privileged(x.Unbound) was called while not connected: call connect() first, or call it inside run() of bind(db) with a data layer of your own"));
    // Bound, it only names the entity: the read is what finds no binding in scope and none connected.
    bindDomain({ Unbound }, layerNamed("db"), {}, frame);
    const reads = Mesh.privileged(Unbound);
    await expect(reads.read({})).rejects.toThrow(new FrameworkError("Mesh.privileged(x.Unbound).read was called while not connected: call connect() first, or call it inside run() of bind(db) with a data layer of your own"));
  });

  test("a privileged handle kept past disconnect() reads nothing: outside any scope, its read is not connected and opens no transaction", async () => {
    let opened = 0;
    const base = layerNamed("db");
    const layer = { ...base, transaction: <T>(run: (ops: never) => Promise<T>) => { opened++; return base.transaction(run as never) as Promise<T>; } } as typeof base;
    const binding = bindDomain(domain, layer, {}, frame);
    connectBinding(binding);
    const reads = Mesh.privileged(Task);
    expect(await reads.read({})).toEqual([{ layer: "db", options: {}, input: {}, context: undefined }]);
    releaseBinding(binding);
    await settled(binding);
    const before = opened;
    await expect(reads.read({})).rejects.toThrow(new FrameworkError("Mesh.privileged(work.Task).read was called while not connected: call connect() first, or call it inside run() of bind(db) with a data layer of your own"));
    expect(opened).toBe(before);
    // Connected again, the same handle reads through the binding connected now.
    const again = bindDomain(domain, layerNamed("again"), {}, frame);
    connectBinding(again);
    try {
      expect((await reads.read({}))[0]!.layer).toBe("again");
    } finally {
      releaseBinding(again);
    }
  });

  test("a privileged handle taken in one binding and used in another's run or transaction reads through the binding in scope", async () => {
    const a = bindDomain(domain, layerNamed("a"), {}, frame);
    const b = bindDomain(domain, layerNamed("b"), {}, frame);
    const reads = await a.run(async () => Mesh.privileged(Task));
    expect((await b.transaction(() => reads.read({})))[0]!.layer).toBe("b");
    expect((await b.run(() => reads.read({})))[0]!.layer).toBe("b");
    // And the one taken in b reads through a inside a's run.
    const fromB = await b.run(async () => Mesh.privileged(Task));
    expect((await a.run(() => fromB.read({})))[0]!.layer).toBe("a");
    // One handle per entity value, whichever binding it was taken in.
    expect(fromB).toBe(reads);
  });

  test("Privileged<E> has one function per read action, and is never for a value that is not an entity", () => {
    const read: Privileged<typeof Account>["read"] = async () => [];
    void read;
    // @ts-expect-error an entity's action that is not a read is not on it
    const act: Privileged<typeof Account>["act"] = undefined;
    void act;
    const none: Privileged<{ read(): void }> = undefined as never;
    void none;
    // @ts-expect-error privileged takes an entity value
    expect(() => Mesh.privileged({ read() {} })).toThrow(FrameworkError);
  });
});
