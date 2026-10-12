import { entity, type BindOptions, type DataLayer, type DataOperations } from "../../src/index.ts";

/**
 * A domain of fake entity values for `entity.test.ts`: each bound action resolves with what it ran on (the layer's name
 * and the binding's options), so a test can tell which binding a call used. `gate` holds a call until the test opens it.
 */
export interface Ran {
  readonly layer: string;
  readonly options: BindOptions;
  readonly input: unknown;
  readonly context: unknown;
}

export const gate: { wait?: Promise<void> } = {};

export function layerNamed(name: string): DataLayer & { readonly name: string } {
  const operations = {} as DataOperations;
  return {
    name,
    transaction: <T>(run: (ops: DataOperations) => Promise<T>) => run(operations),
    refuseIfFailed: () => false,
    close: async () => {},
  } as unknown as DataLayer & { readonly name: string };
}

const ran = (layer: DataLayer, options: BindOptions, input: unknown, context: unknown): Ran =>
  ({ layer: (layer as { name?: string }).name ?? "?", options, input, context });

export const Task = entity(
  "work.Task",
  (layer, options) => Object.freeze({
    async open(input: unknown, context?: unknown) {
      if (gate.wait) await gate.wait;
      return ran(layer, options, input, context);
    },
    async toString(input: unknown, context?: unknown) { return ran(layer, options, input, context); },
    async constructor(input: unknown, context?: unknown) { return ran(layer, options, input, context); },
  }),
  (layer, options) => Object.freeze({ async read(input: unknown, context?: unknown) { return [ran(layer, options, input, context)]; } }),
  (call) => ({
    open(input: { readonly title: string }, ...context: [context?: object]): Promise<Ran> {
      return call("open", input, context);
    },
    toString(input: { readonly n: number }, ...context: [context?: object]): Promise<Ran> {
      return call("toString", input, context);
    },
    constructor(input: { readonly n: number }, ...context: [context?: object]): Promise<Ran> {
      return call("constructor", input, context);
    },
  }),
);

/** Not an entity value: the walk skips it, as it skips a barrel's load functions. */
export function loadTaskFields(): void {}

export * as sales from "./sales.ts";
