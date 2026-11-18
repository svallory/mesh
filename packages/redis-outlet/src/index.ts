// `@meshfw/redis-outlet`: `redisOutlet(binding, options)`, an outlet that copies the events a surface publishes to a
// Redis stream for other applications to read (handlers design, `notes/architecture/handlers-design.md`, rules O1 to
// O7). It is a subscription over core's `subscribe`, so it needs nothing from core that any reader does not have.
export { redisOutlet, type RedisOutlet, type RedisOutletOptions } from "./outlet.ts";
