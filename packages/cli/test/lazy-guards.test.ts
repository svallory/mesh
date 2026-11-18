// Lazy guards, end to end. The fixture (`fixtures/lazy-guards/domain/gate`) calls an imported
// helper behind `&&`, `||`, `??` and `?:` in translated `set` expressions. The helper counts its calls and throws when it
// should have been kept from running. The project is built by the real `mesh` command, type-checked by tsc under the
// strictest flags, and run on SQLite in memory.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { mesh, project as sharedProject, repo, removeProjects } from "./project.ts";

const fixture = join(import.meta.dir, "fixtures/lazy-guards/domain");

const project = () => sharedProject({ prefix: "lazy-guards-", name: "lazy-guards", domain: fixture });

let root: string;
beforeAll(async () => {
  root = await project();
  expect(mesh(root, "build")).toEqual({ code: 0, stdout: "", stderr: "0 errors, 0 warnings\n" });
}, 30_000);
afterAll(removeProjects);

type Row = Record<string, unknown>;
type Call = (input: Record<string, unknown>, context: object) => Promise<Row>;

describe("a helper behind a guard runs only when the guard lets it", () => {
  test("the generated expressions print the right side as a thunk", async () => {
    // The generated file is formatted, so compare with the whitespace folded.
    const text = (await readFile(join(root, ".mesh/domain/gate/gate.expressions.ts"), "utf8")).replace(/\s+/g, " ");
    expect(text).toContain('$.and($.eq($s.input?.flag, true), () => $.asBool($.pure(hit("and", true, true), "hit")))');
    expect(text).toContain('$.coalesce($s.input?.n, () => $.pure(hit("coalesce", true, 1), "hit"))');
    expect(text).toContain('$.cond( $s.input?.flag, () => $.pure(hit("cond-then", true, 1), "hit"), () => 2, )');
    // The guard is not a thunk, and a thunk nests inside a thunk.
    expect(text).toContain('$.and($.eq($s.input?.flag, true), () => $.or($.gt($s.input?.n, 1), () => $.asBool($.pure(hit("nested", true, true), "hit"))), )');
  });

  test("tsc type-checks the generated tree under the strictest flags", async () => {
    const files = (await readdir(join(root, ".mesh"), { recursive: true })).filter((name) => name.endsWith(".ts")).map((name) => join(".mesh", name));
    const child = Bun.spawnSync([
      join(repo, "node_modules/.bin/tsc"), "--ignoreConfig", "--noEmit", "--strict", "--noUncheckedIndexedAccess",
      "--module", "esnext", "--moduleResolution", "bundler", "--target", "es2022", "--skipLibCheck", "--noUnusedLocals", "--noUnusedParameters",
      "--exactOptionalPropertyTypes", "--verbatimModuleSyntax", "--isolatedModules", "--allowImportingTsExtensions", "--types", "bun",
      "mesh.config.ts", ...files,
    ], { cwd: root });
    expect(child.stdout.toString() + child.stderr.toString()).toBe("");
    expect(child.exitCode).toBe(0);
  }, 30_000);

  test("on SQLite: a false &&, a true ||, a non-null ??, the branch not taken and a nested guard never run the helper; a null guard does", async () => {
    const app = await import(join(root, ".mesh/index.ts"));
    const domain = await import(join(root, ".mesh/domain/index.ts"));
    const { calls } = await import(join(root, "domain/gate/probe.ts")) as { calls: string[] };
    const { sqlite, createSchema } = await import(Bun.resolveSync("@meshfw/data-sqlite", root));
    const layer = sqlite({ file: ":memory:" });
    await createSchema(layer, app.tables);
    const binding = app.bind(layer);
    const anyone = { actor: { id: "someone" } };
    const Gate = domain.gate.Gate as { blocked: Call; unknown: Call };
    try {
      await binding.run(async () => {
        // flag false, n = 5: every throwing helper is behind a guard that rules it out. `isBig(5)` is the one call, the
        // guard of `helperGuardOut`, which is itself a helper.
        const blocked = await Gate.blocked({ n: 5, flag: false }, anyone);
        expect(calls.splice(0)).toEqual(["isBig"]);
        expect(blocked).toMatchObject({ andOut: false, orOut: true, coalesceOut: 5, condOut: 2, nestedOut: false, nestedCondOut: 5, helperGuardOut: false });

        // n not sent: an unknown guard runs the right side (as SQL would), and the results are the three-valued ones.
        const unknown = await Gate.unknown({ flag: false }, anyone);
        expect(calls.splice(0)).toEqual(["and-null", "or-null", "coalesce-null", "cond-null"]);
        expect(unknown).toMatchObject({ andOut: null, orOut: null, coalesceOut: 9, condOut: 2 });
      });
    } finally {
      await layer.close();
    }
  }, 30_000);
});
