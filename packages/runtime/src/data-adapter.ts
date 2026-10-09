/** Build-time adapter selection. Connections and data operations belong to M2. */
export interface DataAdapter {
  readonly kind: "data-adapter";
  readonly name: string;
  readonly options: Readonly<Record<string, unknown>>;
}
