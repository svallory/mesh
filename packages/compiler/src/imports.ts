// Parse only the TypeScript statements MX already split out, never .mx source.
import { parse } from "@babel/parser";
import type { DataImport } from "@mxlang/data/tree";
import type { SourceSpan } from "@mxlang/core";

export interface ParsedImport {
  names: string[];
  bindings: { local: string; imported: string; span: SourceSpan }[];
  from: string;
  span: SourceSpan;
}
export interface ImportProblem {
  message: string;
  span: SourceSpan;
}
export function readImports(imports: readonly DataImport[]): {
  imports: ParsedImport[];
  problems: ImportProblem[];
} {
  const result: ParsedImport[] = [];
  const problems: ImportProblem[] = [];
  for (const entry of imports) {
    try {
      const statements = parse(entry.code, {
        sourceType: "module",
        plugins: ["typescript"],
      }).program.body;
      const statement = statements[0];
      if (statements.length !== 1 || statement?.type !== "ImportDeclaration")
        throw new Error("Expected exactly one import declaration");
      const from = statement.source.value;
      if (!from.startsWith("./") && !from.startsWith("../"))
        throw new Error("An import must name a relative file");
      result.push({
        names: statement.specifiers.map((specifier) => specifier.local.name),
        bindings: statement.specifiers.map((specifier) => {
          const imported = specifier.type === "ImportSpecifier" ? specifier.imported : specifier.local;
          return { local: specifier.local.name, imported: imported.type === "Identifier" ? imported.name : imported.value, span: { sourceStart: entry.span.sourceStart + (imported.start ?? 0), sourceEnd: entry.span.sourceStart + (imported.end ?? 0) } };
        }),
        from,
        span: entry.span,
      });
    } catch (cause) {
      problems.push({
        message: cause instanceof Error ? cause.message : String(cause),
        span: entry.span,
      });
    }
  }
  return { imports: result, problems };
}
