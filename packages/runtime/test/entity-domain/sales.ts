import { entity } from "../../src/index.ts";
import type { Ran } from "./fake.ts";

export const Order = entity(
  "sales.Order",
  (layer, options) => Object.freeze({
    async place(input: unknown, context?: unknown): Promise<Ran> {
      return { layer: (layer as { name?: string }).name ?? "?", options, input, context };
    },
  }),
  null,
  (call) => ({
    place(input: { readonly total: number }, ...context: [context?: object]): Promise<Ran> {
      return call("place", input, context);
    },
  }),
);
