/** What the handler bodies record, which the tests read, and the switch that makes the archive handler call its action. */
export const seen: string[] = [];
export const control = { archive: false };
export function record(line: string): void {
  seen.push(line);
}
