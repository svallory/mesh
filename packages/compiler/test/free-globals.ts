// PRJ-20: generated code reaches every global it uses through `.mesh/$globals.ts`, under a `$` name, so an entity may
// take the name of any global (`Promise`, `Boolean`, `Date`) without hiding it. `freeGlobals` holds that to the
// TypeScript checker instead of a list of names: it resolves every identifier a generated file reads and reports the
// ones whose declaration is a global of the TypeScript library or of a global types package (`@types/bun`).
import { API } from "typescript/unstable/async";
import { SyntaxKind, type Identifier, type Node } from "typescript/unstable/ast";
import { dirname, relative } from "node:path";

/** One identifier of a generated file that reads a global by its own name. */
export interface FreeGlobal {
  /** The generated file, relative to the project's root. */
  file: string;
  line: number;
  column: number;
  name: string;
  /** The library file that declares it, by its base name (`lib.es5.d.ts`). */
  declaredIn: string;
}

/** Where an identifier names something rather than reads a variable: a member, a key, an import's or export's original name. */
function namesMember(node: Identifier): boolean {
  const parent = node.parent as Node & { name?: Node; right?: Node; propertyName?: Node };
  switch (parent.kind) {
    case SyntaxKind.PropertyAccessExpression:
    case SyntaxKind.PropertyAssignment:
    case SyntaxKind.PropertySignature:
    case SyntaxKind.PropertyDeclaration:
    case SyntaxKind.MethodSignature:
    case SyntaxKind.MethodDeclaration:
    case SyntaxKind.GetAccessor:
    case SyntaxKind.SetAccessor:
    case SyntaxKind.EnumMember:
    case SyntaxKind.ImportAttribute:
      return parent.name === node;
    case SyntaxKind.QualifiedName:
      return parent.right === node;
    case SyntaxKind.BindingElement:
    case SyntaxKind.ImportSpecifier:
    case SyntaxKind.ExportSpecifier:
      return parent.propertyName === node;
    default:
      return false;
  }
}

/** A declaration file of the TypeScript library (`lib.es5.d.ts`) or of a types package that declares globals (`@types/bun`). */
const GLOBAL_DECLARATIONS = /\/node_modules\/(?:.*\/)?(?:lib\.[\w.]+\.d\.ts|@types\/[^/]+\/.+\.d\.ts|bun-types\/.+\.d\.ts)$/;

/**
 * The identifiers of `files` (absolute paths in the program of `tsconfig`, except `$globals.ts`) that read a global by
 * its name: each resolves to a symbol declared only in a global declaration file. A reference to an import resolves to
 * the import in the file itself, and a member name (`$.now`, `x.length`, a key) is skipped, so what remains is a name
 * the generated code takes from the global scope, which an entity of that name would hide. No global is exempt:
 * `undefined`, which generated code names and no module can declare, is a symbol with no declaration, so it is never
 * reported. In the files of an entity named after a global the name resolves to the entity, not the global, so there a
 * misuse is a type error, which the strict tsc run of `packages/cli/test/generated-names.test.ts` reports.
 */
export async function freeGlobals(tsconfig: string, files: readonly string[]): Promise<FreeGlobal[]> {
  const root = dirname(tsconfig);
  const api = new API({ cwd: root });
  try {
    const snapshot = await api.updateSnapshot({ openProject: tsconfig });
    const project = snapshot.getProject(tsconfig);
    if (!project) throw new Error(`TypeScript did not open ${tsconfig}`);
    const found: FreeGlobal[] = [];
    for (const file of files) {
      if (file.endsWith("/$globals.ts")) continue;
      const source = await project.program.getSourceFile(file);
      if (!source) throw new Error(`${file} is not in the program of ${tsconfig}`);
      const identifiers: Identifier[] = [];
      const visit = (node: Node): void => {
        if (node.kind === SyntaxKind.Identifier && !namesMember(node as Identifier)) identifiers.push(node as Identifier);
        node.forEachChild(visit);
      };
      visit(source);
      const symbols = await project.checker.getSymbolAtLocation(identifiers);
      const lines = source.getLineStarts();
      identifiers.forEach((identifier, index) => {
        const declarations = symbols[index]?.declarations ?? [];
        if (declarations.length === 0 || !declarations.every((declaration) => GLOBAL_DECLARATIONS.test(declaration.path))) return;
        const start = identifier.getStart(source);
        const line = lines.findLastIndex((lineStart) => lineStart <= start);
        found.push({
          file: relative(root, file),
          line: line + 1,
          column: start - lines[line]! + 1,
          name: identifier.text,
          declaredIn: declarations[0]!.path.slice(declarations[0]!.path.lastIndexOf("/") + 1),
        });
      });
    }
    return found;
  } finally {
    await api.close();
  }
}
