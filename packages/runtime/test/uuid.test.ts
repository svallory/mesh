import { expect, test } from "bun:test";
import { uuidv7 } from "@meshfw/runtime";

const V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const millis = (id: string) => parseInt(id.replaceAll("-", "").slice(0, 12), 16);

// First: later tests push the module's clock ahead of the wall clock on purpose.
test("the default clock is the current time", () => {
  const before = Date.now();
  const id = uuidv7();
  expect(millis(id)).toBeGreaterThanOrEqual(before);
  expect(millis(id)).toBeLessThanOrEqual(Date.now() + 1);
});

test("has the version 7 and RFC variant bits and carries the time", () => {
  const id = uuidv7(1_800_000_000_000);
  expect(id).toMatch(V7);
  expect(millis(id)).toBe(1_800_000_000_000);
});

test("ids made in the same millisecond sort in creation order", () => {
  const ids = Array.from({ length: 3000 }, () => uuidv7(1_900_000_000_000));
  expect(new Set(ids).size).toBe(ids.length);
  expect([...ids].sort()).toEqual(ids);
});

test("the counter overflowing moves the timestamp forward and keeps the order", () => {
  const ids = Array.from({ length: 10_000 }, () => uuidv7(1_950_000_000_000));
  expect([...ids].sort()).toEqual(ids);
  expect(millis(ids.at(-1)!)).toBeGreaterThan(1_950_000_000_000);
  // Later wall-clock time still sorts after everything issued ahead of the clock.
  const next = uuidv7(1_950_000_000_000 + 60_000);
  expect(next > ids.at(-1)!).toBe(true);
});

test("a clock that steps back never produces a smaller id", () => {
  const first = uuidv7(2_000_000_000_000);
  const second = uuidv7(1_000_000_000_000);
  expect(second > first).toBe(true);
  expect(second).toMatch(V7);
});

test("ids from different milliseconds sort by time", () => {
  const early = uuidv7(2_100_000_000_000);
  const late = uuidv7(2_100_000_000_001);
  expect(early < late).toBe(true);
});
