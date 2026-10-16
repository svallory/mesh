/**
 * Application code an entity file calls takes the instant as a parameter: the entity file passes the current
 * transaction's `%.now` or `%.today`, since application code has no transaction of its own to read it from.
 */
export function stampOf(at: Date, label: string): string {
  return `${label}@${at.toISOString()}`;
}

/** The date `days` after `today`; the entity file passes `%.today`. */
export function dueIn(today: Date, days: number): Date {
  return new Date(today.getTime() + days * 86_400_000);
}
