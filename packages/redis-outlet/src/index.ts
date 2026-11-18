// `@meshfw/redis-outlet`: `redisOutlet(binding, options)`, an outlet that copies the events a surface publishes to a
// Redis stream for other applications to read (handlers design, `notes/architecture/handlers-design.md`, rules O1 to
// O7). It reads the outbox only through core's `subscribe`, as any reader does, and checks its event names with
// `declaredEvents`, the one addition it needed in core (ADR-0099).
export { redisOutlet, type RedisOutlet, type RedisOutletOptions } from "./outlet.ts";
