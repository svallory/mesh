import { expect, test } from "bun:test";
import * as runtime from "../src/index.ts";
import { expr, FrameworkError, Mesh } from "../src/index.ts";
import { privileged } from "../src/entity.ts";

// PRJ-22: Mesh's own functions are members of one frozen object, so no name an application chooses can collide with them.
// SYN-29: the instant is not one of them; an entity file reads the current transaction's as `%.now` and `%.today`.
test("Mesh is a frozen object holding privileged and isSystem, and nothing else", () => {
  expect(Object.isFrozen(Mesh)).toBe(true);
  expect(Object.keys(Mesh).sort()).toEqual(["isSystem", "privileged"]);
  expect(Mesh.privileged).toBe(privileged);
  expect(Mesh.isSystem).toBe(expr.isSystem);
  expect(() => { (Mesh as { isSystem: unknown }).isSystem = () => true; }).toThrow(TypeError);
});

test("Mesh has no now or today, at run time or in its type: application code takes the instant as a parameter", () => {
  for (const name of ["now", "today"]) expect(name in Mesh).toBe(false);
  // The type check of this file (strict tsc, `bun run typecheck`) fails if `Mesh` has either member again.
  // @ts-expect-error `Mesh.now` is gone (SYN-29): an entity file reads `%.now` and passes it to the helper.
  expect(Mesh.now).toBeUndefined();
  // @ts-expect-error `Mesh.today` is gone (SYN-29): an entity file reads `%.today`.
  expect(Mesh.today).toBeUndefined();
});

test("the runtime exports none of Mesh's functions bare, and no meshIn", () => {
  for (const name of ["privileged", "now", "today", "isSystem", "meshIn"]) expect(Object.hasOwn(runtime, name)).toBe(false);
});

test("Mesh.isSystem is true only for a context whose system key is true", () => {
  expect(Mesh.isSystem({ system: true })).toBe(true);
  for (const value of [{ system: false }, { system: "true" }, {}, null, undefined, true, "system"]) expect(Mesh.isSystem(value)).toBe(false);
});

test("Mesh.privileged of a value that is not an entity names Mesh.privileged in its error", () => {
  expect(() => Mesh.privileged({} as never)).toThrow(new FrameworkError("Mesh.privileged() takes an entity value, such as Mesh.privileged(Task), and was given an object that is not one"));
});
