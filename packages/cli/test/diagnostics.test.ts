import { expect, test } from "bun:test";
import { diagnostic, printDiagnostics, sortDiagnostics } from "../src/diagnostics.ts";

test("diagnostics sort by file, line, column, then message without mutating the input", () => {
  const at = (file: string, line: number, column: number, message: string) => ({
    ...diagnostic(file, message), position: { file, line, column, offset: 0 },
  });
  const input = [at("z.mx", 1, 0, "a"), at("a.mx", 2, 1, "a"), at("a.mx", 1, 2, "a"),
    at("a.mx", 1, 0, "z"), at("a.mx", 1, 0, "a")];
  expect(sortDiagnostics(input)).toEqual([input[4]!, input[3]!, input[2]!, input[1]!, input[0]!]);
  expect(input[0]!.position.file).toBe("z.mx");
  const output: string[] = [];
  printDiagnostics(input, (text) => { output.push(text); });
  expect(output.join("")).toBe("a.mx:1:1 error a\na.mx:1:1 error z\na.mx:1:3 error a\na.mx:2:2 error a\nz.mx:1:1 error a\n5 errors, 0 warnings\n");
});

test("summary counts both severities after all diagnostics", () => {
  const output: string[] = [];
  printDiagnostics([diagnostic("a.mx", "bad"), { ...diagnostic("b.mx", "notice"), severity: "warning" }],
    (text) => { output.push(text); });
  expect(output.join("")).toBe("a.mx:1:1 error bad\nb.mx:1:1 warning notice\n1 error, 1 warning\n");
});
