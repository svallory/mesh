import { authorizer, entity, NO_FRAME, type ActionFrame, type DataLayer } from "../../src/index.ts";

/**
 * A domain for `raw-query.test.ts`, bound with that file's own async frame (an entity value is bound with one frame only,
 * so it cannot share `framed.ts` with `entity.test.ts`). `Ledger.act` runs its `step` inside its transaction, through
 * the binding's frame, as a generated action runs its steps; its read runs `policy` as the check of a read policy and
 * `computed` the way a load evaluates a computed field, both marked through the frame.
 */
export interface ReadInput {
  readonly computed?: () => unknown;
  readonly policy?: () => unknown;
}

const read = (layer: DataLayer, frame: ActionFrame = NO_FRAME) => async (input: ReadInput) => {
  if (input.policy) {
    const mine = { name: "mine", when: null, checks: [{ kind: "authorize-if" as const, check: "mine", record: false, run: input.policy }] };
    await authorizer("bank.Ledger", "read", [mine], frame).admits({});
  }
  return layer.transaction(async () => [{ computed: input.computed ? await frame.marked("computed :balance of bank.Ledger", input.computed) : null }]);
};

export const Ledger = entity(
  "bank.Ledger",
  (layer, _options, frame = NO_FRAME) => Object.freeze({
    async act(input: { readonly step?: () => unknown }) {
      return layer.transaction((tx) => frame.within(tx, () => new Date(0), "bank.Ledger#act", async () => ({ stepped: await input.step?.() })));
    },
    async read(input: ReadInput) { return read(layer, frame)(input); },
  }),
  (layer, _options, frame) => Object.freeze({ read: read(layer, frame) }),
  (call) => ({
    act(input: { readonly step?: () => unknown }, ...context: [context?: object]): Promise<{ stepped: unknown }> { return call("act", input, context); },
    read(input: ReadInput, ...context: [context?: object]): Promise<{ computed: unknown }[]> { return call("read", input, context); },
  }),
);
