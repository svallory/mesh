/**
 * What the handler bodies record, which the tests read; the switches that make the archive handler call its actions;
 * and where each body runs (`places`: inside or outside a transaction of the layer the test hands as `control.layer`).
 */
export const seen: string[] = [];
export const places: string[] = [];
export const control: { archive: boolean; invalid: boolean; layer: { refuseIfFailed(): boolean } | undefined } = { archive: false, invalid: false, layer: undefined };
export function record(line: string): void {
  seen.push(line);
}
export function where(handler: string): void {
  if (control.layer) places.push(`${handler} ${control.layer.refuseIfFailed() ? "inside" : "outside"}`);
}
