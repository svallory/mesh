import { expect, test } from "bun:test";
import * as runtime from "../src/index.ts";
import { expr, FrameworkError, Mesh, meshIn, pinClock, scope } from "../src/index.ts";
import { privileged } from "../src/entity.ts";

// PRJ-22: Mesh's own functions are members of one frozen object, so no name an application chooses can collide with them.
test("Mesh is a frozen object holding privileged, now, today and isSystem, and nothing else", () => {
  expect(Object.isFrozen(Mesh)).toBe(true);
  expect(Object.keys(Mesh).sort()).toEqual(["isSystem", "now", "privileged", "today"]);
  expect(Mesh.privileged).toBe(privileged);
  expect(Mesh.isSystem).toBe(expr.isSystem);
  expect(() => { (Mesh as { now: unknown }).now = () => new Date(0); }).toThrow(TypeError);
});

test("the runtime exports none of Mesh's functions bare", () => {
  for (const name of ["privileged", "now", "today", "isSystem"]) expect(Object.hasOwn(runtime, name)).toBe(false);
});

test("Mesh.isSystem is true only for a context whose system key is true", () => {
  expect(Mesh.isSystem({ system: true })).toBe(true);
  for (const value of [{ system: false }, { system: "true" }, {}, null, undefined, true, "system"]) expect(Mesh.isSystem(value)).toBe(false);
});

test("Mesh.now() and Mesh.today() outside an entity file's expression throw FrameworkError, saying what to do instead", () => {
  for (const name of ["now", "today"] as const) {
    let thrown: unknown;
    try { Mesh[name](); } catch (error) { thrown = error; }
    expect(thrown).toBeInstanceOf(FrameworkError);
    expect((thrown as Error).message).toBe(`Mesh.${name}() was called outside an entity file's expression: application code cannot find the running action's instant yet. Call Mesh.${name}() in a function of the entity file (a step, a run body or a check) and pass the instant on, or take the time from the application's own clock`);
  }
});

test("meshIn(scope) is Mesh with now and today reading the scope's one instant", () => {
  let reads = 0;
  const at = Date.UTC(2026, 9, 12, 15, 30);
  const s = scope({}, { clock: pinClock(() => { reads++; return new Date(at); }) });
  const bound = meshIn(s);
  expect(Object.isFrozen(bound)).toBe(true);
  expect(Object.keys(bound).sort()).toEqual(["isSystem", "now", "privileged", "today"]);
  expect(bound.now().getTime()).toBe(at);
  expect(bound.now().getTime()).toBe(expr.now(s).getTime());
  expect(bound.today().getTime()).toBe(Date.UTC(2026, 9, 12));
  expect(reads).toBe(1);
  // Each call hands back a fresh Date, so a caller that changes one changes no other read.
  const first = bound.now();
  first.setTime(0);
  expect(bound.now().getTime()).toBe(at);
  expect(bound.privileged).toBe(Mesh.privileged);
  expect(bound.isSystem).toBe(Mesh.isSystem);
  // Mesh itself is untouched.
  expect(() => Mesh.now()).toThrow(FrameworkError);
});

test("Mesh.privileged of a value that is not an entity names Mesh.privileged in its error", () => {
  expect(() => Mesh.privileged({} as never)).toThrow(new FrameworkError("Mesh.privileged() takes an entity value, such as Mesh.privileged(Task), and was given an object that is not one"));
});
