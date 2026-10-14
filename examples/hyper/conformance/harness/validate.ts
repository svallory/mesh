/** Validates engine responses against the protocol schemas (schemas/protocol.ts). */
import { FormatRegistry, type TSchema } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { Event, EventPayloads, type EventType, type MethodName, Methods } from "../schemas/protocol.ts";

if (!FormatRegistry.Has("date-time")) {
  FormatRegistry.Set("date-time", (v) => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/.test(v) && !Number.isNaN(Date.parse(v)));
}

export function schemaErrors(schema: TSchema, value: unknown, max = 5): string[] {
  return [...Value.Errors(schema, value)].slice(0, max).map((e) => `${e.path || "/"}: ${e.message}`);
}

/** Returns human-readable schema violations of a method result (including its events). */
export function checkResult(method: MethodName, result: unknown): string[] {
  const errs = schemaErrors(Methods[method].result, result).map((e) => `result ${e}`);
  const events = (result as { events?: unknown[] })?.events;
  if (Array.isArray(events)) for (const ev of events) errs.push(...checkEvent(ev));
  return errs;
}

export function checkEvent(ev: unknown): string[] {
  const errs = schemaErrors(Event, ev).map((e) => `event ${e}`);
  const t = (ev as { type?: string })?.type;
  const payloadSchema = t ? EventPayloads[t as EventType] : undefined;
  if (payloadSchema) errs.push(...schemaErrors(payloadSchema, (ev as { payload: unknown }).payload).map((e) => `${t} payload ${e}`));
  return errs;
}

export function checkParams(method: MethodName, params: unknown): string[] {
  return schemaErrors(Methods[method].params, params);
}
