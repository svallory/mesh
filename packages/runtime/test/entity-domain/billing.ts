import { entity } from "../../src/index.ts";

/** `billing.Order`: exported as `Order` like `sales.Order`, with the same action, which the removed `actions` handle named alike (`placeOrder`). */
export const Order = entity("billing.Order", () => Object.freeze({ async place() { return "billing"; } }), null, (call) => ({
  place(input: { readonly total: number }): Promise<string> {
    return call("place", input, []);
  },
}));
