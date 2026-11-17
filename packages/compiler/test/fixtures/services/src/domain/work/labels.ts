/** A helper module the service imports. */
export function label(title: string, at: Date): string {
  return `${title} (${at.toISOString()})`;
}
export type Label = string;
