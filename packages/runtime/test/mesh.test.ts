import { expect, test } from "bun:test";
import * as runtime from "../src/index.ts";
import { expr, FrameworkError, Mesh } from "../src/index.ts";
import { can, checkPolicies, entity, privileged } from "../src/entity.ts";

// Mesh's own functions are members of one frozen object, so no name an application chooses can collide with them.
// the instant is not one of them; an entity file reads the current transaction's as `%.now` and `%.today`.
// asking whether a call would be allowed is `Mesh.checkPolicies`, and `Mesh.can` for the yes or no.
test("Mesh is a frozen object holding privileged, isSystem, checkPolicies and can, and nothing else", () => {
  expect(Object.isFrozen(Mesh)).toBe(true);
  expect(Object.keys(Mesh).sort()).toEqual(["can", "checkPolicies", "isSystem", "privileged"]);
  expect(Mesh.privileged).toBe(privileged);
  expect(Mesh.isSystem).toBe(expr.isSystem);
  expect(Mesh.checkPolicies).toBe(checkPolicies);
  expect(Mesh.can).toBe(can);
  expect(() => { (Mesh as { isSystem: unknown }).isSystem = () => true; }).toThrow(TypeError);
});

test("Mesh has no now or today, at run time or in its type: application code takes the instant as a parameter", () => {
  for (const name of ["now", "today"]) expect(name in Mesh).toBe(false);
  // The type check of this file (strict tsc, `bun run typecheck`) fails if `Mesh` has either member again.
  // @ts-expect-error `Mesh.now` is gone: an entity file reads `%.now` and passes it to the helper.
  expect(Mesh.now).toBeUndefined();
  // @ts-expect-error `Mesh.today` is gone: an entity file reads `%.today`.
  expect(Mesh.today).toBeUndefined();
});

test("the runtime exports none of Mesh's functions bare, and no meshIn", () => {
  for (const name of ["privileged", "now", "today", "isSystem", "meshIn", "checkPolicies", "can"]) expect(Object.hasOwn(runtime, name)).toBe(false);
});

test("Mesh.isSystem is true only for a context whose system key is true", () => {
  expect(Mesh.isSystem({ system: true })).toBe(true);
  for (const value of [{ system: false }, { system: "true" }, {}, null, undefined, true, "system"]) expect(Mesh.isSystem(value)).toBe(false);
});

test("Mesh.privileged of a value that is not an entity names Mesh.privileged in its error", () => {
  expect(() => Mesh.privileged({} as never)).toThrow(new FrameworkError("Mesh.privileged() takes an entity value, such as Mesh.privileged(Task), and was given an object that is not one"));
});

const NOT_ONE = "a function that is not one (a plain function, a Mesh.privileged read, a copy made with .bind, or an action of an entity value made by a "
  + "second copy of @meshfw/runtime in the install, which meshfw avoids by taking @meshfw/runtime as a peer dependency)";

test("Mesh.checkPolicies and Mesh.can of anything but an action function of an entity value throw, naming what they take", async () => {
  const plain = async (_input: unknown, _context: unknown) => undefined;
  const message = (given: string, member = "checkPolicies") => new FrameworkError(`Mesh.${member}() takes an action function of an entity value, such as Mesh.${member}(Todo.complete, input, context), and was given ${given}`);
  const notOne = NOT_ONE;
  for (const [value, given] of [[plain, notOne], [null, "null"], [undefined, "undefined"], [{}, "an object"], ["create", "string"]] as const) {
    await expect(Mesh.checkPolicies(value as typeof plain, {}, {})).rejects.toThrow(message(given));
    await expect(Mesh.can(value as typeof plain, {}, {})).rejects.toThrow(message(given, "can"));
  }
});

test("an action of an entity value made by a second copy of the runtime is not one this Mesh knows: it throws, naming that case", async () => {
  // A second copy of the module, as a second copy of @meshfw/runtime in an install would load: its WeakMaps are its own.
  const specifier = "../src/entity.ts?second-copy";
  const copy = (await import(specifier)) as typeof import("../src/entity.ts");
  expect(copy.entity).not.toBe(entity);
  const bind = () => ({ act: async () => undefined });
  const value = copy.entity("work.Task", bind, null, (call) => ({ act: (input: unknown, context: unknown) => call("act", input, [context]) }));
  const message = new FrameworkError(`Mesh.checkPolicies() takes an action function of an entity value, such as Mesh.checkPolicies(Todo.complete, input, context), and was given ${NOT_ONE}`);
  await expect(Mesh.checkPolicies(value.act, {}, {})).rejects.toThrow(message);
  await expect(Mesh.can(value.act, {}, {})).rejects.toThrow(new FrameworkError(message.message.replaceAll("checkPolicies", "can")));
  // The copy's own Mesh knows it, and asks the binding it would run on: none is connected.
  await expect(copy.checkPolicies(value.act, {}, {})).rejects.toThrow("Mesh.checkPolicies(work.Task#act) was called while not connected");
});
