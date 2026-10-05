// Checks that every `.mx` sample on the Docs pages is an entity file in syntax v3
// (the operator's ruling of 2026-10-05 evening, ADR-0066) and that it parses.
//
// The parse itself lives in `packages/compiler/test/repository-checks.ts`, the only
// file under `packages/` allowed to import MX (ADR-0043): it needs MX's `parseData`,
// and no other package may import it. This file is the caller, so the check runs in
// `bun run verify` with the rest of the Docs checks.
//
// It is deliberately stricter than the compiler's own Docs check: a fence whose
// root is not `entity :Name` is a finding here, and so is a fence that writes a
// name as a string in any option, in the old `#name` spelling, or with a read's
// `sort=` option instead of a `sort` section (`quotedNameInV3`, next door), so a
// page cannot drift back to the old syntax without failing the build.
import { expect, test } from "bun:test";
import { join } from "node:path";
import { checkDocsSyntaxV3 } from "../../../packages/compiler/test/repository-checks.ts";

const docs = new URL("../docs/docs/", import.meta.url).pathname;

test("every MX sample on the Docs pages is a syntax v3 entity file that parses", () => {
  const checked = checkDocsSyntaxV3(join(docs));
  console.log(`Docs MX fences: ${checked.checked} syntax v3 entity files, ${checked.errors.length} findings`);
  expect(checked.errors).toEqual([]);
  expect(checked.checked).toBeGreaterThan(10);
});