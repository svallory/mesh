import { entity } from "../../src/index.ts";

/** `billing.Order`: exported as `Order` like `sales.Order`, with the same action, so both would be `actions.placeOrder`. */
export const Order = entity("billing.Order", () => Object.freeze({ async place() { return "billing"; } }), null, (call) => ({
  place(input: { readonly total: number }): Promise<string> {
    return call("place", input, []);
  },
}));
