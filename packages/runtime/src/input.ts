import { FrameworkError, InvalidInputError, type Issue, type IssueSource } from "./errors.ts";
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
    throw new InvalidInputError(result.issues.map((issue: StandardSchemaV1.Issue) => issueOf(issue)));
  }
  if (!("value" in result)) {
    throw new FrameworkError("Malformed Standard Schema result: expected value when issues is undefined");
  }
  return result.value;
}

/**
 * One Standard Schema issue as Mesh's `Issue`, `suffix` appended to its message. A validator Mesh generated marks a
 * broken line rule (`min`, `max`, `match`) with `meshRule: { code, source }` on the issue (`$ruled` in
 * `validators.ts.jig`): its code and position are kept. Any other issue (a wrong type, a missing field, or one from a
 * schema that is not Mesh's) has no code and no source.
 */
export function issueOf(issue: StandardSchemaV1.Issue, suffix = ""): Issue {
  const rule = ruleOf((issue as { meshRule?: unknown }).meshRule);
  return {
    message: issue.message + suffix,
    path: issue.path?.map((segment) => {
      const key = typeof segment === "object" ? segment.key : segment;
      return typeof key === "number" ? key : String(key);
    }) ?? [],
    label: null,
    code: rule?.code ?? null,
    source: rule?.source ?? null,
    details: null,
  };
}

/** `meshRule` when it is exactly `{ code: non-empty text, source: { file, line, column } }`, copied; anything else is no rule. */
function ruleOf(value: unknown): { code: string; source: IssueSource } | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const { code, source } = value as { code?: unknown; source?: unknown };
  if (typeof code !== "string" || code === "" || typeof source !== "object" || source === null) return undefined;
  const { file, line, column } = source as { file?: unknown; line?: unknown; column?: unknown };
  if (typeof file !== "string" || typeof line !== "number" || typeof column !== "number") return undefined;
  return { code, source: { file, line, column } };
}
