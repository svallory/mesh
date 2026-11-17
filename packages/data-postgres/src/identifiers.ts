/** How many bytes of a name Postgres keeps (`NAMEDATALEN - 1`); a longer name is cut silently. */
export const POSTGRES_NAME_BYTES = 63;

const encoder = new TextEncoder();

/** The name's length in UTF-8 bytes, which is what Postgres counts. */
export function nameBytes(name: string): number {
  return encoder.encode(name).length;
}

/** The name as Postgres would store it: the first 63 bytes, never splitting a character (as `pg_mbcliplen` does). */
export function truncatedName(name: string): string {
  let bytes = 0;
  let kept = "";
  for (const character of name) {
    bytes += nameBytes(character);
    if (bytes > POSTGRES_NAME_BYTES) break;
    kept += character;
  }
  return kept;
}

/**
 * Why `name` cannot be a Postgres table or column name, or undefined. drizzle-kit 0.31.11 writes Postgres DDL as
 * `"${name}"` without escaping a double quote, and Postgres keeps only the first 63 bytes of a name, so two long names
 * would share one column and Drizzle's full name would no longer match the table's. Shared by the emitted schema and
 * by direct schema preparation.
 */
export function postgresNameProblem(name: string, kind: "table" | "column"): string | undefined {
  if (/["\x00-\x1f\x7f]/.test(name)) {
    return `"${name}" cannot be used as a Postgres ${kind} name: it contains a character that the schema tools cannot quote safely (double quote or control character)`;
  }
  if (nameBytes(name) > POSTGRES_NAME_BYTES) {
    return `"${name}" cannot be used as a Postgres ${kind} name: Postgres keeps the first ${POSTGRES_NAME_BYTES} bytes of a name and would store it as "${truncatedName(name)}"`;
  }
  return undefined;
}
