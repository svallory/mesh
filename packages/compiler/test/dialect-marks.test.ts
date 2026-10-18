import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildModel } from "../src/front-end/build.ts";

// MX 0.1.0-alpha.34 (#648) compares the `dialect` option's marks with those of every dialect the file's project
// installs, when the file name is absolute and its nearest `package.json` is found. `mesh build` passes Mesh's dialect as
// that option and the entity file's absolute path, so a project that also installs a dialect marking `&`, `:` or `%.`
// fails to build, as it fails in the editor. A mark that only shares a prefix with Mesh's is no clash (#650).

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "mesh-dialect-marks-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** Writes a project at `root` that installs one dialect package whose expression row is marked `match`. */
function installDialect(chars: string, match: string): void {
  const dir = join(root, "node_modules", "other-dialect");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({ name: "other-dialect", mx: { dialect: { id: "other", name: "Other", extensions: [".other"], module: "./index.mjs" } } }),
  );
  const row = { id: "other-row", chars, match, standIn: "identifier", node: { type: "M", dialect: "other" } };
  writeFileSync(
    join(dir, "index.mjs"),
    `export default { table: { expressionTriggers: [${JSON.stringify(row)}] }, nodeTypes: { M: { keys: [], schema: { fields: { name: "data" }, slot: ["expression"] }, parse: (t) => ({ name: t.slice(1) }), print: (n) => ${JSON.stringify(chars[0])} + n.name, lower: (n, ctx) => ctx.expression({ type: "StringLiteral", value: n.name, extra: { raw: JSON.stringify(n.name), rawValue: n.name } }) } } };\n`,
  );
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "app", devDependencies: { "other-dialect": "0.0.0" } }));
}

const ENTITY = "entity :Todo\n  attributes\n    uuid :id primary-key\n    string :title\n  computed\n    string :label({ self }) { return &title }\n";
const build = () => buildModel({ root, files: [{ file: "todo/todo.mesh.mx", source: ENTITY }] });

describe("a project's other installed dialect", () => {
  test("whose mark is Mesh's `&` fails the build, at the start of the project-relative file", () => {
    installDialect("&", "&[a-z]+");
    const { diagnostics } = build();
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toMatchObject({
      severity: "error",
      code: "MX_INVALID_DIALECT_MODULE",
      position: { file: "todo/todo.mesh.mx", line: 1, column: 0 },
    });
    expect(diagnostics[0]!.message).toContain("the installed dialect `other` (Other) both mark \"&\"");
    expect(diagnostics[0]!.message).toContain("remove the dependency on `other`");
    expect(diagnostics[0]!.message).not.toContain(root);
  });

  test("whose mark is Mesh's `:` fails the build", () => {
    installDialect(":", ":[a-z]+");
    const { diagnostics } = build();
    expect(diagnostics.map((d) => d.code)).toEqual(["MX_INVALID_DIALECT_MODULE"]);
    expect(diagnostics[0]!.message).toContain('both mark ":"');
  });

  test("whose mark only shares a prefix with Mesh's (`&.` against `&`) builds", () => {
    installDialect("&", "&\\.[a-z]+");
    expect(build().diagnostics).toEqual([]);
  });

  test("whose mark is disjoint from Mesh's builds", () => {
    installDialect("~", "~[a-z]+");
    expect(build().diagnostics).toEqual([]);
  });

  test("with no package.json above the file, nothing is compared", () => {
    expect(build().diagnostics).toEqual([]);
  });
});
