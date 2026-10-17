/**
 * The name of the class an event or a command makes (`notes/spec/names.md`): each `_` is dropped and the letter after it
 * is upper case, and so is the first letter, so `invoicePaid`, `InvoicePaid` and `invoice_paid` all make `InvoicePaid`.
 * The result is no identifier when the name has no letter to start it (`_1` makes `1`): `isClassName` says so.
 */
export const classNameOf = (name: string): string =>
  name
    .split("_")
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join("");

/** Whether `classNameOf` made an identifier. */
export const isClassName = (className: string): boolean => /^[A-Za-z][A-Za-z0-9]*$/.test(className);
