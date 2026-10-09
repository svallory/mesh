import { readFileSync } from "node:fs";
import { parseData, type DataDiagnostic } from "@mxlang/data";
import contracts from "../src/contracts.ts";

export const fixtureDir = new URL("./fixtures/", import.meta.url).pathname;

export function fixture(name: string): { source: string; file: string } {
  const file = `${fixtureDir}${name}`;
  return { source: readFileSync(file, "utf8"), file };
}

/** Direct call: contracts passed as `customTags`, structural and unknown-tag rejection on. */
export function parse(source: string, file = "todo/todo.mesh.mx") {
  return parseData(source, file, {
    customTags: contracts,
    structural: "reject",
    unknownTags: "reject",
    imports: "pass",
  });
}

export function parseFixture(name: string) {
  const { source, file } = fixture(name);
  return parse(source, file);
}

export type Diag = Pick<DataDiagnostic, "severity" | "line" | "column">;
