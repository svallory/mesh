/** A helper named like the scope root `input`: inside an expression the root shadows it, as a parameter would. */
export function input(): string {
  return "the helper";
}
/** A helper Boolean imports under an alias (`shout as loudly`): the expressions file imports it under the same one. */
export function shout(text: string): string {
  return text.toUpperCase();
}
