// MX's diagnostic codes reach Mesh's output as MX gives them (MX alpha.23: every error and warning has a stable code).
// A Mesh hook's `MESH_*` code is unchanged; `MESH_SYNTAX` is only the fallback for a diagnostic that arrives with none.
import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { fixture, fixtureDir } from "./helpers.ts";
import { buildModel, meshDiagnostic, parseEntitySource, type MxDiagnostic } from "../src/front-end/build.ts";
import { build, keyed } from "./v4.ts";

describe("MX codes pass through", () => {
  test("an unknown tag in an entity file is MX_UNKNOWN_TAG, positioned at the tag", () => {
    const result = buildModel({ root: "/project", files: [{ file: "todo.mesh.mx", source: "entity :Todo\n  mystery :x\n" }] });
    expect(result.document).toBeNull();
    expect(result.diagnostics).toEqual([
      expect.objectContaining({ severity: "error", code: "MX_UNKNOWN_TAG", position: expect.objectContaining({ file: "todo.mesh.mx", line: 2, column: 2 }) }),
    ]);
  });

  test.each([
    ["an unknown attribute", keyed + "    boolean :ok min=0\n", "MX_UNKNOWN_ATTRIBUTE"],
  ])("%s keeps MX's code", (_, source, code) => {
    const found = build(source).diagnostics;
    expect(found.length).toBeGreaterThan(0);
    expect(found[0]!.code).toBe(code);
  });

  test("no diagnostic MX reports for a Mesh source reaches the MESH_SYNTAX fallback", () => {
    for (const source of ["entity :T\n  mystery\n", "let x\n", "entity :T\n  attributes\n    string :a min=\n", "entity\n"]) {
      for (const d of parseEntitySource(source, "t.mesh.mx").diagnostics) expect(d.code, d.message).toBeString();
    }
  });
});

describe("a Mesh hook's own code is unchanged", () => {
  test("MESH_UNSPACED_NAME from the dialect hook", () => {
    const result = buildModel({ root: "/project", files: [{ file: "todo.mesh.mx", source: "entity:Todo\n" }] });
    expect(result.diagnostics.map((d) => d.code)).toEqual(["MESH_UNSPACED_NAME"]);
  });
});

describe("meshDiagnostic", () => {
  const base = { severity: "error", message: "m", line: 3, column: 4, offset: 20 } as const;
  test("a diagnostic with no code is MESH_SYNTAX", () => {
    expect(meshDiagnostic(base as MxDiagnostic, "a.mesh.mx")).toEqual({
      severity: "error", code: "MESH_SYNTAX", message: "m", position: { file: "a.mesh.mx", line: 3, column: 4, offset: 20 }, fix: null,
    });
  });
  test.each(["MX_UNKNOWN_TAG", "MX_DIALECT_HOOK_ERROR", "MESH_UNSPACED_NAME", "MESH_ANYTHING"])("%s is kept as it is", (code) => {
    expect(meshDiagnostic({ ...base, code } as MxDiagnostic, "a.mesh.mx").code).toBe(code);
  });
  test("a warning keeps its severity and code", () => {
    const d = meshDiagnostic({ ...base, severity: "warning", code: "MX_DUPLICATE_ATTRIBUTE" } as MxDiagnostic, "a.mesh.mx");
    expect([d.severity, d.code]).toEqual(["warning", "MX_DUPLICATE_ATTRIBUTE"]);
  });
});

// `MX_DIALECT_ERROR` is MX's code for a Mesh hook that fails without naming a code, `MX_DIALECT_HOOK_ERROR` for one that throws.
// Both would present a Mesh error as MX's, so no Mesh fixture may produce either.
describe("no Mesh hook error is reported as MX's", () => {
  const forbidden = /MX_DIALECT_ERROR|MX_DIALECT_HOOK_ERROR/;
  test.each([
    "fixtures/atom-contracts.json",
    "fixtures/mesh-corpus/__golden__/golden.json",
  ])("%s records neither code", (rel) => {
    const text = readFileSync(new URL(rel, import.meta.url), "utf8");
    expect(text).toContain('"code"');
    expect(forbidden.test(text)).toBe(false);
  });
  test("no negative fixture produces either code", () => {
    const files = readdirSync(`${fixtureDir}negative`).filter((f) => f.endsWith(".mesh.mx"));
    expect(files.length).toBeGreaterThan(20);
    for (const f of files) {
      for (const d of build(fixture(`negative/${f}`).source).diagnostics) expect(d.code, f).not.toMatch(forbidden);
    }
  });
});
