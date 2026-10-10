import { expect, test } from "bun:test";
import { CAPABILITIES, FrameworkError, defineCapabilities, validateCapabilityManifest } from "@meshfw/runtime";

test("the closed set names the optional capabilities", () => {
  expect([...CAPABILITIES]).toEqual(["aggregates", "integer-key-fill", "joins", "upserts", "atomic-expressions"]);
});

test("defineCapabilities returns a frozen manifest and keeps the literal names", () => {
  const manifest = defineCapabilities("fake", ["aggregates"]);
  expect(manifest).toEqual({ adapter: "fake", capabilities: ["aggregates"] });
  expect(Object.isFrozen(manifest)).toBe(true);
  expect(Object.isFrozen(manifest.capabilities)).toBe(true);
  expect(defineCapabilities("none", []).capabilities).toEqual([]);
});

test("a manifest is a copy: later changes to the input do not reach it", () => {
  const names = ["joins"] as string[];
  const manifest = validateCapabilityManifest({ adapter: "x", capabilities: names });
  names.push("upserts");
  expect(manifest.capabilities).toEqual(["joins"]);
});

test.each([
  [undefined, "must be an object"],
  [null, "must be an object"],
  ["sqlite", "must be an object"],
  [{ capabilities: [] }, "adapter must be a non-empty string"],
  [{ adapter: " ", capabilities: [] }, "adapter must be a non-empty string"],
  [{ adapter: "x" }, "capabilities must be an array"],
  [{ adapter: "x", capabilities: "aggregates" }, "capabilities must be an array"],
  [{ adapter: "x", capabilities: ["teleport"] }, 'unknown capability "teleport"'],
  [{ adapter: "x", capabilities: [1] }, "unknown capability 1"],
  [{ adapter: "x", capabilities: ["Aggregates"] }, 'unknown capability "Aggregates"'],
  [{ adapter: "x", capabilities: ["joins", "joins"] }, 'capability "joins" is listed twice'],
  [{ adapter: "x", capabilities: ["constructor"] }, 'unknown capability "constructor"'],
])("validateCapabilityManifest(%j) fails: %s", (value, message) => {
  expect(() => validateCapabilityManifest(value)).toThrow(FrameworkError);
  expect(() => validateCapabilityManifest(value)).toThrow(message);
});

test("every problem is reported in one error", () => {
  expect(() => validateCapabilityManifest({ adapter: "", capabilities: ["a", "b"] })).toThrow(/adapter.*unknown capability "a".*unknown capability "b"/);
});

test("defineCapabilities checks at run time even when types are bypassed", () => {
  expect(() => defineCapabilities("x", ["teleport"] as never)).toThrow('unknown capability "teleport"');
});
