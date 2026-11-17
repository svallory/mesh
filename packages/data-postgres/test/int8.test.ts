import { describe, expect, test } from "bun:test";
import { FrameworkError } from "@meshfw/runtime";
import { int8, int8OrNull } from "../src/int8.ts";
import { outboxChannel, outboxLockKey } from "../src/outbox.ts";

describe("int8, a raw bigint column as a number", () => {
  test.each([["9007199254740991", 9007199254740991], ["0", 0], ["-12", -12], [42, 42], [7n, 7]])("%p reads as %p", (value, expected) => {
    expect(int8(value, "c")).toBe(expected);
  });
  test.each(["9007199254740992", "1.5", "", "x", null, undefined, Number.NaN])("%p is refused, naming the column", (value) => {
    expect(() => int8(value, "mesh_outbox.position")).toThrow(FrameworkError);
    expect(() => int8(value, "mesh_outbox.position")).toThrow("mesh_outbox.position");
  });
  test("int8OrNull keeps SQL NULL", () => {
    expect(int8OrNull(null, "c")).toBeNull();
    expect(int8OrNull("3", "c")).toBe(3);
  });
});

describe("the outbox's channel and advisory-lock key", () => {
  test("the production channel is mesh_outbox; a test schema gets its own", () => {
    expect(outboxChannel(undefined)).toBe("mesh_outbox");
    expect(outboxChannel("c1")).toBe("mesh_outbox_c1");
  });
  test("the key is two non-negative int4s, fixed per channel and different between channels", () => {
    const key = outboxLockKey("mesh_outbox");
    expect(outboxLockKey("mesh_outbox")).toEqual(key);
    for (const part of key) expect(Number.isInteger(part) && part >= 0 && part <= 0x7fffffff).toBe(true);
    expect(outboxLockKey("mesh_outbox_c1")).not.toEqual(key);
  });
});
