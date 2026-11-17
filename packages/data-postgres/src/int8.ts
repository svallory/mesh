import { FrameworkError } from "@meshfw/runtime";

/**
 * A raw `int8` value as a number. Bun.SQL returns `bigint` columns of a raw query as strings (Drizzle's
 * `bigint({ mode: "number" })` columns convert on their own), so every raw position, generation and pid goes through
 * here; a value outside the safe integers is a `FrameworkError` rather than a rounded number.
 */
export function int8(value: unknown, column: string): number {
  const number = typeof value === "number" ? value : typeof value === "bigint" ? Number(value)
    : typeof value === "string" && /^-?[0-9]+$/.test(value) ? Number(value) : Number.NaN;
  if (!Number.isSafeInteger(number)) {
    throw new FrameworkError(`The column ${column} holds ${String(value)}, which is not an integer JavaScript can hold exactly (at most 2^53 - 1)`);
  }
  return number;
}

/** `int8`, with SQL `NULL` kept as null. */
export function int8OrNull(value: unknown, column: string): number | null {
  return value === null || value === undefined ? null : int8(value, column);
}
