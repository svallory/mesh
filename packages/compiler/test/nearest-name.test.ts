// nearestName gives advice only when one candidate is closest and within two edits; a tie at the closest distance gives none.
import { expect, test } from "bun:test";
import { nearestName } from "../src/front-end/nearest-name.ts";

test("one candidate one edit away is the suggestion", () => {
  expect(nearestName("titel", ["title"])).toBe("title");
});

test("two candidates at the same closest distance give no suggestion, in either order", () => {
  expect(nearestName("ab", ["ax", "ay"])).toBeUndefined();
  expect(nearestName("ab", ["ay", "ax"])).toBeUndefined();
});

test("a tie farther than the closest candidate does not hide it, before or after it", () => {
  expect(nearestName("abcd", ["abxy", "abyx", "abcx"])).toBe("abcx");
  expect(nearestName("abcd", ["abcx", "abxy", "abyx"])).toBe("abcx");
});

test("a candidate three edits away is no suggestion", () => {
  expect(nearestName("abc", ["xyz"])).toBeUndefined();
});
