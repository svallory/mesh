/** Application code an entity file imports as a namespace (`import * as money from "./money"`, SYN-21). */
export function isPositive(amount: number): boolean {
  return amount > 0;
}

export function format(amount: number): string {
  return `$${(amount / 100).toFixed(2)}`;
}

/** A type the entity file names through the namespace, `money.Cents`. */
export type Cents = number;
