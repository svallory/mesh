import { entity, NO_FRAME, type ActionFrame, type Clock, type DataLayer, type DataOperations } from "../../src/index.ts";

/**
 * A domain for the call frame tests of `entity.test.ts` (TXN-16, TXN-18, ACT-09). `Account.act` runs its `step` inside its
 * transaction, through the binding's frame, as a generated action runs its checks and steps; its read runs `computed`
 * the way a load evaluates a computed field, marked through the frame.
 */
export interface Row {
  id: number;
  tags: string[];
  /** What the read's clock gave, or null when it was handed none. */
  at: Date | null;
  /** The context the read was handed, or null. */
  context: unknown;
  /** Whether the read ran its policies: `privileged` runs none. */
  policies: boolean;
  computed: unknown;
}

/**
 * A layer that opens a transaction with fresh operations, or joins the running one, as the SQLite layer does. It tracks
 * the running transaction in a variable, not in async context, so the tests that use it make their calls one at a time.
 */
export function joiningLayer(): { layer: DataLayer; opened: DataOperations[] } {
  let current: DataOperations | undefined;
  const opened: DataOperations[] = [];
  const layer = {
    async transaction<T>(run: (ops: DataOperations) => Promise<T>): Promise<T> {
      if (current) return run(current);
      const ops = {} as DataOperations;
      opened.push(ops);
      current = ops;
      try {
        return await run(ops);
      } finally {
        current = undefined;
      }
    },
    refuseIfFailed: () => current !== undefined,
    close: async () => {},
  } as unknown as DataLayer;
  return { layer, opened };
}

const read = (layer: DataLayer, frame: ActionFrame = NO_FRAME) =>
  async (input: { computed?: () => unknown }, context?: unknown, clock?: Clock, policies?: boolean): Promise<Row[]> =>
    layer.transaction(async () => [{
      id: 1,
      tags: ["a"],
      at: clock?.() ?? null,
      context: context ?? null,
      policies: policies ?? true,
      computed: input.computed ? await frame.marked("computed :balance of bank.Account", input.computed) : null,
    }]);

export interface ActInput {
  readonly step?: () => unknown;
  /** The action's instant, in milliseconds. */
  readonly at?: number;
}

export const Account = entity(
  "bank.Account",
  (layer, _options, frame = NO_FRAME) => Object.freeze({
    async act(input: ActInput) {
      const clock = () => new Date(input.at ?? 0);
      return layer.transaction((tx) => frame.within(tx, clock, "bank.Account#act", async () => ({ id: 1, tags: ["a"], stepped: await input.step?.() })));
    },
    async read(input: { computed?: () => unknown }, context?: unknown) {
      return read(layer, frame)(input, context);
    },
  }),
  (layer, _options, frame) => Object.freeze({ read: read(layer, frame) }),
  (call) => ({
    act(input: ActInput, ...context: [context?: object]): Promise<{ id: number; tags: string[]; stepped: unknown }> {
      return call("act", input, context);
    },
    read(input: { computed?: () => unknown }, ...context: [context?: object]): Promise<Row[]> {
      return call("read", input, context);
    },
  }),
);
