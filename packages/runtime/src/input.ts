import { InvalidInputError } from "./errors.ts";
import type { StandardSchemaV1 } from "./standard-schema.ts";

/** Validate through Standard Schema, preserving thrown exceptions unchanged. */
export async function parseInput<T>(schema: StandardSchemaV1<unknown, T>, input: unknown): Promise<T> {
  const result = await schema["~standard"].validate(input);
  if (result.issues) {
    throw new InvalidInputError(result.issues.map((issue) => ({
      message: issue.message,
      path: issue.path?.map((segment) => String(typeof segment === "object" ? segment.key : segment)) ?? [],
    })));
  }
  return result.value;
}
