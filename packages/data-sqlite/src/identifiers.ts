/** The pinned schema tool does not safely quote backticks or ASCII controls.
 * Keep this rule shared by emitted schemas and direct in-process preparation.
 */
export function sqliteNameProblem(name: string, kind: "table" | "column"): string | undefined {
  if (/[`\x00-\x1f\x7f]/.test(name)) {
    return `"${name}" cannot be used as a SQLite ${kind} name: it contains a character that the schema tools cannot quote safely (backtick or control character)`;
  }
  return undefined;
}

/** SQLite identifier equality folds ASCII letters only, not Unicode letters. */
export function sqliteNameKey(name: string): string {
  return name.replace(/[A-Z]/g, (letter) => letter.toLowerCase());
}
