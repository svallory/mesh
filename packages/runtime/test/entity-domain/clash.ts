/** A domain with two `Order` values, in two folders: binding it binds both, each running its own actions. */
export { Order } from "./sales.ts";
export * as billing from "./billing.ts";
