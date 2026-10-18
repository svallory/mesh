import { IR_VERSION } from "@mxlang/core";
import { expect, test } from "bun:test";

// Mesh reads one IR shape (`src/front-end/tree.ts`). A new `IR_VERSION` means a new shape: read the MX changelog and
// update `tree.ts` before changing this number.
test("the installed @mxlang/core speaks the IR version Mesh reads", () => {
  expect(IR_VERSION).toBe(6);
});
