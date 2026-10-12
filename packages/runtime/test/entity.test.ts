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
  FrameworkError,
  isEntityValue,
  releaseBinding,
  settled,
  type Seams,
} from "../src/index.ts";
import * as clash from "./entity-domain/clash.ts";
import * as domain from "./entity-domain/fake.ts";
import { gate, layerNamed, Task } from "./entity-domain/fake.ts";
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

  test("the composer's handles name each action and read by the action followed by the entity's export name", async () => {
    const binding = bindDomain(domain, layerNamed("db"), {}, frame);
    const names = await binding.transaction(async ({ actions, tx }) => [Object.keys(actions).sort(), Object.keys(tx)]);
    expect(names).toEqual([["constructorTask", "openTask", "placeOrder", "toStringTask"], ["readTask"]]);
    const read = await binding.transaction(async ({ tx }) => (tx as Record<string, (input: unknown) => Promise<unknown>>).readTask!({ limit: 1 }), { actor: "t" } as never);
    expect(read).toEqual([{ layer: "db", options: {}, input: { limit: 1 }, context: { actor: "t" } }]);
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

  test("two calls the composer's handles would name alike are a FrameworkError naming the key and both calls", () => {
    expect(() => bindDomain(clash, layerNamed("db"), {}, frame)).toThrow(
      new FrameworkError("sales.Order#place and billing.Order#place would both be actions.placeOrder: rename one of the two"),
    );
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
