// Checks that every `.mx` sample on the Docs pages is an entity file in syntax v2
// (the operator's ruling of 2026-10-05) and that it parses.
//
// The parse itself lives in `packages/compiler/test/repository-checks.ts`, the only
// file under `packages/` allowed to import MX (ADR-0043): it needs MX's `parseData`,
// and no other package may import it. This file is the caller, so the check runs in
// `bun run verify` with the rest of the Docs checks.
//
// It is deliberately stricter than the compiler's own Docs check: a fence whose
// root is not `entity #Name` is a finding here, so a page cannot drift back to
// another syntax without failing the build.
import { expect, test } from "bun:test";
import { join } from "node:path";
import { checkDocsSyntaxV2 } from "../../../packages/compiler/test/repository-checks.ts";

const docs = new URL("../docs/docs/", import.meta.url).pathname;

test("every MX sample on the Docs pages is a syntax v2 entity file that parses", () => {
  const checked = checkDocsSyntaxV2(join(docs));
  console.log(`Docs MX fences: ${checked.checked} syntax v2 entity files, ${checked.errors.length} findings`);
  expect(checked.errors).toEqual([]);
  expect(checked.checked).toBeGreaterThan(10);
});
