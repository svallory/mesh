/**
 * Helpers named like what the generated files declare or import (`z`, the service's own name, `HandOverWorkInput`): the
 * service file imports them under these names, so the generated service file must declare none of them at module level.
 */
export const z = (text: string): string => text.trim();
export const Billing = "billing";
export type CloseBillingInput = { note: string };
