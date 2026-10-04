import { FrameworkError, InvalidInputError } from "./errors.ts";
import type { StandardSchemaV1 } from "./standard-schema.ts";

/** Validate through Standard Schema, preserving thrown exceptions unchanged. */
export async function parseInput<T>(schema: StandardSchemaV1<unknown, T>, input: unknown): Promise<T> {
  const result = await schema["~standard"].validate(input);
  if (typeof result !== "object" || result === null || !("value" in result || "issues" in result)) {
    throw new FrameworkError("Malformed Standard Schema result: expected an object containing value or issues");
  }
  if (result.issues !== undefined) {
    if (!Array.isArray(result.issues)) {
      throw new FrameworkError("Malformed Standard Schema result: issues must be an array");
    }
    throw new InvalidInputError(result.issues.map((issue: StandardSchemaV1.Issue) => ({
      message: issue.message,
      path: issue.path?.map((segment) => String(typeof segment === "object" ? segment.key : segment)) ?? [],
    })));
  }
  if (!("value" in result)) {
    throw new FrameworkError("Malformed Standard Schema result: expected value when issues is undefined");
  }
  return result.value;
}
