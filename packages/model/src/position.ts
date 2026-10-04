/**
 * Where something sits in a source file. Matches what MX diagnostics report:
 * `line` is 1-based, `column` is 0-based, `offset` is the UTF-16 code-unit offset
 * from the start of the file.
 */
export interface SourcePosition {
  file: string;
  line: number;
  column: number;
  offset: number;
}
