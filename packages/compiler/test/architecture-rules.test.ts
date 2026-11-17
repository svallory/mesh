// The architecture rules' checks (`notes/architecture/architecture-file-design.md`, PR 2; rules R9 to R11, R16 and R17,
// ruling D40): `checkArchitecture` runs each catalogue rule that has a check at the level the architecture file resolves.
// The settings themselves (the file's lines, presets, unknown rules) are `architecture-file.test.ts`; the one-entity
// service warning's cases are `services.test.ts`.
import { describe, expect, test } from "bun:test";
import type { Diagnostic, ModelDocument, SourcePosition } from "@meshfw/model";
import { ARCHITECTURE_RULES, checkArchitecture, DEFAULT_SETTINGS, type ArchitectureRule, type RuleSetting } from "../src/model/architecture-rules.ts";

const AT: SourcePosition = { file: "a.mesh.mx", line: 1, column: 0, offset: 0 };
const EMPTY = { entities: [] } as unknown as ModelDocument;

describe("checkArchitecture", () => {
  const found: ArchitectureRule = { name: "stub", code: "MESH_STUB", defaultLevel: "warning", check: (_, report) => report({ message: "found", position: AT, fix: "fix it" }) };
  const silent: ArchitectureRule = { name: "inert", code: "MESH_INERT", defaultLevel: "error" };
  const run = (settings: Record<string, RuleSetting>) => {
    const diagnostics: Diagnostic[] = [];
    checkArchitecture(new Map(Object.entries(settings)), { document: EMPTY }, diagnostics, [found, silent]);
    return diagnostics.map((d) => [d.severity, d.code, d.message, d.fix]);
  };
  test("a finding is reported under the rule's code at the resolved level; `off` reports nothing", () => {
    expect(run({ stub: "warning" })).toEqual([["warning", "MESH_STUB", "found", "fix it"]]);
    expect(run({ stub: "error" })).toEqual([["error", "MESH_STUB", "found", "fix it"]]);
    expect(run({ stub: "off" })).toEqual([]);
  });
  test("a rule the settings do not name runs at its default level", () => {
    expect(run({})).toEqual([["warning", "MESH_STUB", "found", "fix it"]]);
  });
  test("a rule with no check reports nothing at any level", () => {
    for (const level of ["error", "warning", "off"] as const) expect(run({ stub: "off", inert: level })).toEqual([]);
  });
  test("the catalogue: both rules have a check, at the default level `warning`", () => {
    expect(ARCHITECTURE_RULES.map((rule) => [rule.name, rule.code, rule.defaultLevel])).toEqual([
      ["action-calls-other-aggregate", "MESH_ACTION_CALLS_OTHER_AGGREGATE", "warning"],
      ["service-touches-one-entity", "MESH_SERVICE_ONE_ENTITY", "warning"],
    ]);
    expect(ARCHITECTURE_RULES.find((rule) => rule.name === "service-touches-one-entity")!.check).toBeFunction();
    const diagnostics: Diagnostic[] = [];
    checkArchitecture(DEFAULT_SETTINGS, { document: EMPTY }, diagnostics);
    expect(diagnostics).toEqual([]);
  });
});
