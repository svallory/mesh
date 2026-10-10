import { readFileSync } from "node:fs";
import type { IrDiagnostic } from "@mxlang/core";
import { parseEntitySource } from "../src/front-end/build.ts";

export const fixtureDir = new URL("./fixtures/", import.meta.url).pathname;

export function fixture(name: string): { source: string; file: string } {
  const file = `${fixtureDir}${name}`;
  return { source: readFileSync(file, "utf8"), file };
}

/** The compiler's own parse: contracts, `MESH_DIALECT`, structural and unknown-tag rejection on. */
export function parse(source: string, file = "todo/todo.mesh.mx") {
  return parseEntitySource(source, file);
}

export function parseFixture(name: string) {
  const { source, file } = fixture(name);
  return parse(source, file);
}

export type Diag = Pick<IrDiagnostic, "severity" | "line" | "column">;
