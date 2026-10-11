import { describe, expect, spyOn, test } from "bun:test";
import { recordWrite, composer, runAction, wantsChanges, type Change, type DataLayer, type DataOperations, type Seams } from "../src/index.ts";

/**
 * The seams on their own, over a layer that is told whether a call joins a running transaction. The joining rules belong
 * to the data layer; these check what Mesh's own run-time pieces do with the answer.
 */
function fake(joined = false) {
  const log: string[] = [];
  const ops = { insert: async (_t: unknown, row: unknown) => row, selectByKey: async () => undefined, updateByKey: async () => undefined, deleteByKey: async () => true } as unknown as DataOperations;
  const state = { joined, fail: false };
  const layer = {
    refuseIfFailed: () => state.joined,
    transaction: async <T>(run: (tx: DataOperations) => Promise<T>) => { log.push("open"); const result = await run(ops); log.push("commit"); return result; },
    close: async () => {},
  } as unknown as DataLayer;
  return { layer, ops, log, state };
}
const target = { entity: "Thing", action: "make" };

describe("wantsChanges", () => {
  test("is true for afterWrite or afterCommit only", () => {
    expect(wantsChanges(undefined)).toBe(false);
    expect(wantsChanges({})).toBe(false);
    expect(wantsChanges({ beforeTransaction() {} })).toBe(false);
    expect(wantsChanges({ afterWrite() {} })).toBe(true);
    expect(wantsChanges({ afterCommit() {} })).toBe(true);
  });
});

describe("runAction", () => {
  test("a call that opens the transaction runs beforeTransaction first, with the input and a context that is never undefined", async () => {
    const { layer, log } = fake();
    const events: unknown[] = [];
    const seams: Seams = { beforeTransaction: (event) => { log.push("before"); events.push(event); } };
    expect(await runAction(layer, seams, target, { a: 1 }, undefined, async () => "result")).toBe("result");
    expect(log).toEqual(["before", "open", "commit"]);
    expect(events).toEqual([{ ...target, input: { a: 1 }, context: {} }]);
  });

  test("a call that joins a running transaction runs neither beforeTransaction nor afterCommit", async () => {
    const { layer, log } = fake(true);
    const seams: Seams = { beforeTransaction: () => { log.push("before"); }, afterCommit: () => { log.push("after"); } };
    await runAction(layer, seams, target, {}, {}, async (tx) => { await recordWrite(tx, seams, target, null, { id: 1 }, {}, {}); });
    expect(log).toEqual(["open", "commit"]);
  });

  test("a throw in beforeTransaction rejects the call before any transaction opens", async () => {
    const { layer, log } = fake();
    const boom = new Error("refused");
    await expect(runAction(layer, { beforeTransaction() { throw boom; } }, target, {}, {}, async () => { log.push("body"); })).rejects.toBe(boom);
    expect(log).toEqual([]);
  });

  test("afterCommit runs once, after the commit, with every change the body recorded, in order", async () => {
    const { layer, log } = fake();
    const seams: Seams = { afterCommit: ({ changes }) => { log.push(`after ${changes.map((change) => change.action).join(",")}`); } };
    const result = await runAction(layer, seams, target, {}, {}, async (tx) => {
      await recordWrite(tx, seams, { entity: "Thing", action: "one" }, null, { id: 1 }, {}, {});
      await recordWrite(tx, seams, { entity: "Thing", action: "two" }, { id: 1 }, { id: 1, n: 2 }, {}, {});
      return 7;
    });
    expect(result).toBe(7);
    expect(log).toEqual(["open", "commit", "after one,two"]);
  });

  test("afterCommit is not called when the body rejects, and not when nothing was written", async () => {
    const { layer, log } = fake();
    const seams: Seams = { afterCommit: () => { log.push("after"); } };
    const boom = new Error("body");
    await expect(runAction(layer, seams, target, {}, {}, async (tx) => { await recordWrite(tx, seams, target, null, { id: 1 }, {}, {}); throw boom; })).rejects.toBe(boom);
    await runAction(layer, seams, target, {}, {}, async () => undefined);
    expect(log.filter((line) => line === "after")).toEqual([]);
  });

  test("a throw in afterCommit is reported with console.error naming the seam; the call resolves with its result", async () => {
    const { layer } = fake();
    const errors = spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const boom = new Error("late");
      const seams: Seams = { afterCommit: async () => { throw boom; } };
      expect(await runAction(layer, seams, target, {}, {}, async (tx) => { await recordWrite(tx, seams, target, null, { id: 1 }, {}, {}); return "done"; })).toBe("done");
      expect(errors).toHaveBeenCalledTimes(1);
      expect(String(errors.mock.calls[0]![0])).toContain("afterCommit");
      expect(errors.mock.calls[0]![1]).toBe(boom);
    } finally { errors.mockRestore(); }
  });
});

describe("afterWrite", () => {
  test("hands the seam db with the four operations only, the change and the call's input and context; a write through db is not recorded", async () => {
    const { layer } = fake();
    const seen: unknown[] = [];
    let committed: readonly Change[] = [];
    const seams: Seams = {
      async afterWrite(db, event) {
        seen.push(Object.keys(db).sort(), event);
        await db.insert({}, { id: 2 });
      },
      afterCommit: ({ changes }) => { committed = changes; },
    };
    await runAction(layer, seams, target, {}, {}, async (tx) => { await recordWrite(tx, seams, target, { id: 1, n: 1 }, { id: 1, n: 2 }, { n: 2 }, { actor: "a" }); });
    expect(seen).toEqual([
      ["deleteByKey", "insert", "selectByKey", "updateByKey"],
      { ...target, before: { id: 1, n: 1 }, after: { id: 1, n: 2 }, input: { n: 2 }, context: { actor: "a" } },
    ]);
    expect(committed).toEqual([{ ...target, before: { id: 1, n: 1 }, after: { id: 1, n: 2 } }]);
  });

  test("copies the rows, so a later change to the written row does not change what the seams saw; the change is frozen", async () => {
    const { layer } = fake();
    let committed: readonly Change[] = [];
    const row = { id: 1, nested: { n: 1 }, at: new Date(5) };
    const seams: Seams = { afterCommit: ({ changes }) => { committed = changes; } };
    await runAction(layer, seams, target, {}, {}, async (tx) => {
      await recordWrite(tx, seams, target, null, row, {}, {});
      row.nested.n = 99;
    });
    expect(committed[0]!.after).toMatchObject({ id: 1, nested: { n: 1 } });
    expect((committed[0]!.after as { at: Date }).at.getTime()).toBe(5);
    expect(Object.isFrozen(committed[0])).toBe(true);
  });

  test("does nothing when no seam wants the changes", async () => {
    const { ops } = fake();
    await recordWrite(ops, undefined, target, null, { id: 1 }, {}, {});
    await recordWrite(ops, { beforeTransaction() {} }, target, null, { id: 1 }, {}, {});
  });

  test("records nothing for afterCommit when only afterWrite is registered", async () => {
    const { layer } = fake();
    const seen: unknown[] = [];
    await runAction(layer, { afterWrite: (_db, event) => { seen.push(event.after); } }, target, {}, {}, async (tx) => {
      await recordWrite(tx, { afterWrite: (_db, event) => { seen.push(event.after); } }, target, null, { id: 1 }, {}, {});
    });
    expect(seen).toEqual([{ id: 1 }]);
  });

  test("hands out deeply frozen payloads: a seam cannot change the input, the top level of the context or what another seam sees", async () => {
    const { layer } = fake();
    const input = { title: "a", tags: ["x"] };
    const context = { actor: { id: 1 } };
    const attempts: string[] = [];
    const tryTo = (label: string, edit: () => void) => { try { edit(); attempts.push(`${label}: edited`); } catch { attempts.push(`${label}: refused`); } };
    let committed: readonly Change[] = [];
    const seams: Seams = {
      beforeTransaction: (event) => { tryTo("input", () => { (event.input as { title: string }).title = ""; }); tryTo("context", () => { (event.context as { actor: unknown }).actor = null; }); },
      afterWrite: (_db, event) => { tryTo("after", () => { (event.after as { n: number }).n = 0; }); tryTo("nested", () => { (event.after as { list: number[] }).list.push(9); }); },
      afterCommit: ({ changes }) => { committed = changes; },
    };
    await runAction(layer, seams, target, input, context, async (tx) => { await recordWrite(tx, seams, target, null, { n: 1, list: [1] }, input, context); });
    expect(attempts).toEqual(["input: refused", "context: refused", "after: refused", "nested: refused"]);
    expect(input).toEqual({ title: "a", tags: ["x"] });
    expect(context).toEqual({ actor: { id: 1 } });
    expect(committed[0]!.after).toEqual({ n: 1, list: [1] });
  });

  test("a seam cannot change a Date in a row, and afterCommit still sees the written value", async () => {
    const { layer } = fake();
    let committed: readonly Change[] = [];
    const attempts: string[] = [];
    const seams: Seams = {
      afterWrite: (_db, event) => {
        const createdAt = (event.after as { createdAt: Date }).createdAt;
        try { createdAt.setTime(0); attempts.push("edited"); } catch { attempts.push("refused"); }
      },
      afterCommit: ({ changes }) => { committed = changes; },
    };
    await runAction(layer, seams, target, {}, {}, async (tx) => { await recordWrite(tx, seams, target, null, { id: 1, createdAt: new Date(5) }, {}, {}); });
    expect(attempts).toEqual(["refused"]);
    expect((committed[0]!.after as { createdAt: Date }).createdAt.getTime()).toBe(5);
  });

  test("the context is the application's: a function, a logger, a class instance and a Uint8Array pass through as the same instances, and nothing the caller holds is frozen", async () => {
    class Logger { lines: string[] = []; info(line: string) { this.lines.push(line); } }
    const logger = new Logger();
    const signature = new Uint8Array([1, 2, 3]);
    const session = { roles: ["x"] };
    const trace = () => "traced";
    const context = { actor: { id: 1 }, logger, signature, session, trace };
    const { layer } = fake();
    const seen: unknown[] = [];
    const seams: Seams = {
      beforeTransaction: (event) => { seen.push(event.context); (event.context as typeof context).logger.info("before"); },
      afterWrite: (_db, event) => { seen.push(event.context); (event.context as typeof context).logger.info("write"); },
    };
    await runAction(layer, seams, target, {}, context, async (tx) => { await recordWrite(tx, seams, target, null, { id: 1 }, {}, context); });
    for (const each of seen) {
      const given = each as typeof context;
      expect(given.logger).toBe(logger);
      expect(given.signature).toBe(signature);
      expect(given.session).toBe(session);
      expect(given.trace).toBe(trace);
      expect(Object.isFrozen(given)).toBe(true);
    }
    expect(logger.lines).toEqual(["before", "write"]);
    // The caller's own objects are still theirs to change.
    for (const owned of [context, logger, session, session.roles, signature, context.actor]) expect(Object.isFrozen(owned) && !(owned instanceof Uint8Array)).toBe(false);
    logger.info("after");
    session.roles.push("y");
    context.actor.id = 2;
    signature[0] = 9;
    expect(logger.lines).toEqual(["before", "write", "after"]);
    expect(session.roles).toEqual(["x", "y"]);
  });

  test("a seam that assigns context.actor changes nothing for the call", async () => {
    const { layer } = fake();
    const context = { actor: { id: 1 } };
    const seams: Seams = { afterWrite: (_db, event) => { try { (event.context as { actor: unknown }).actor = null; } catch { /* frozen */ } } };
    await runAction(layer, seams, target, {}, context, async (tx) => { await recordWrite(tx, seams, target, null, { id: 1 }, {}, context); });
    expect(context.actor).toEqual({ id: 1 });
  });
});

describe("the composer's transaction", () => {
  test("is an outermost transaction: afterCommit runs once when it commits; a joined one leaves it to the outer", async () => {
    const calls: string[] = [];
    const seams: Seams = { afterCommit: ({ changes }) => { calls.push(`after ${changes.length}`); } };
    const outer = fake();
    const made = composer(outer.layer, seams);
    made.provide({}, {});
    await made.transaction(async () => { await recordWrite(outer.ops, seams, target, null, { id: 1 }, {}, {}); });
    expect(calls).toEqual(["after 1"]);
    const inner = fake(true);
    const joined = composer(inner.layer, seams);
    joined.provide({}, {});
    await joined.transaction(async () => { await recordWrite(inner.ops, seams, target, null, { id: 1 }, {}, {}); });
    expect(calls).toEqual(["after 1"]);
  });

  test("a rejected callback reports nothing", async () => {
    const calls: string[] = [];
    const seams: Seams = { afterCommit: () => { calls.push("after"); } };
    const { layer, ops } = fake();
    const throwing = { ...layer, transaction: async <T>(run: (tx: DataOperations) => Promise<T>) => run(ops) } as DataLayer;
    const made = composer(throwing, seams);
    made.provide({}, {});
    await expect(made.transaction(async () => { await recordWrite(ops, seams, target, null, { id: 1 }, {}, {}); throw new Error("no"); })).rejects.toThrow("no");
    expect(calls).toEqual([]);
  });
});

describe("a layer that hands every transaction the same operations object", () => {
  /** Transactions queue one after the other, and the promise settles a few ticks after the next one may start. */
  function reusing() {
    const ops = { insert: async (_t: unknown, row: unknown) => row, selectByKey: async () => undefined, updateByKey: async () => undefined, deleteByKey: async () => true } as unknown as DataOperations;
    let tail: Promise<unknown> = Promise.resolve();
    const layer = {
      refuseIfFailed: () => false,
      transaction: async <T>(run: (tx: DataOperations) => Promise<T>): Promise<T> => {
        const turn = tail.then(() => run(ops));
        tail = turn.catch(() => undefined);
        const result = await turn;
        await new Promise((resolve) => setTimeout(resolve, 2));
        return result;
      },
      close: async () => {},
    } as unknown as DataLayer;
    return { layer, ops };
  }

  test("concurrent top-level calls and application transactions each report exactly their own changes", async () => {
    const { layer, ops } = reusing();
    const reported: string[] = [];
    const seams: Seams = {
      afterWrite: async () => { await new Promise((resolve) => setTimeout(resolve, 1)); },
      afterCommit: ({ changes }) => { reported.push(changes.map((change) => change.action).join("+")); },
    };
    const made = composer(layer, seams);
    made.provide({}, {});
    const write = (action: string) => recordWrite(ops, seams, { entity: "Thing", action }, null, { id: 1 }, {}, {});
    await Promise.all([
      runAction(layer, seams, target, {}, {}, () => write("A")),
      runAction(layer, seams, target, {}, {}, () => write("B")),
      made.transaction(async () => { await write("C1"); await write("C2"); }),
      runAction(layer, seams, target, {}, {}, () => write("D")),
    ]);
    expect(reported.sort()).toEqual(["A", "B", "C1+C2", "D"]);
  });

  test("a call that rolled back leaves nothing for the next one", async () => {
    const { layer, ops } = reusing();
    const reported: string[] = [];
    const seams: Seams = { afterCommit: ({ changes }) => { reported.push(changes.map((change) => change.action).join("+")); } };
    const write = (action: string) => recordWrite(ops, seams, { entity: "Thing", action }, null, { id: 1 }, {}, {});
    await expect(runAction(layer, seams, target, {}, {}, async () => { await write("lost"); throw new Error("no"); })).rejects.toThrow("no");
    await runAction(layer, seams, target, {}, {}, () => write("kept"));
    expect(reported).toEqual(["kept"]);
  });
});
