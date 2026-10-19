import { afterAll, afterEach, expect, test } from "bun:test";
import { closeTypeServer } from "./type-server.ts";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { scope } from "@meshfw/runtime";
import { buildModel } from "../src/front-end/build.ts";
import { generateFiles, writeGeneratedFiles } from "../src/typescript/emit.ts";
import { checkTypes, configOf } from "./generated.ts";

afterAll(closeTypeServer);

// A plain function with one parameter, whatever its pattern, is called with the scope (`(s) => s.self.n`).
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

const entity = (actions: string, computed = "") => `entity :Task
  attributes
    uuid :id primary-key
    integer :n
    string :title nullable
${computed}  actions auto=[:read]
    update :go
      input
        &n
      validate
${actions}`;

async function generated(source: string) {
  const root = await mkdtemp(resolve(import.meta.dir, "../mesh-scope-"));
  roots.push(root);
  const built = buildModel({ root: "/p", files: [{ file: "task.mesh.mx", source }] });
  expect(built.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
  const config = configOf(root);
  await writeGeneratedFiles(await generateFiles({ document: built.document!, config }), config);
  await writeFile(resolve(root, "generated/schema.ts"), "export const tables = {};\n");
  await mkdir(resolve(root, "node_modules"), { recursive: true });
  const { $expressions: expressions } = await import(resolve(root, "generated/domain/task.expressions.ts"));
  return { root, built, expressions: expressions as Record<string, (s: unknown) => unknown> };
}
const types = async (root: string) => await checkTypes(root, ["generated/domain/task.expressions.ts", "generated/domain/task.types.ts"]);
const sc = (self: object, input: object = {}) => scope({ self, input } as never);

test.each([
  ["a plain name", "(s) => s.self.n > 1"],
  ["an annotated name", "(s: any) => s.self.n > 1"],
  ["a name beside &members", "(s) => s.self.n > 1 && &n > 1"],
  ["an empty pattern", "({}) => true"],
  ["a rest pattern", "({ ...rest }) => rest.self.n > 1"],
  ["a renamed member", "({ self: s }) => s.n > 1"],
])("a check's that, when and details take the scope: %s", async (_, fn) => {
  const holds = fn.includes("true");
  const { root, built, expressions } = await generated(entity(`        check :c [
          that=${fn}
          when=${fn}
          details=(s) => ({ n: s.self.n })
          code="c"
          message="m"
        ]
`));
  expect(await types(root)).toEqual({ code: 0, output: "" });
  const that = expressions["go.check.c.that"]!, when = expressions["go.check.c.when"]!;
  expect(that(sc({ n: 2 }))).toBe(true);
  expect(that(sc({ n: 0 }))).toBe(holds);
  expect(when(sc({ n: 2 }))).toBe(true);
  expect(expressions["go.check.c.details"]!(sc({ n: 2 }))).toEqual({ n: 2 });
});

test("a computed field and a run body with a plain parameter get the scope", async () => {
  const { root, expressions } = await generated(entity("", "").replace("      validate\n", "      do\n        run(s) { if (s.self.n < 0) throw new Error(\"negative\") }\n")
    .replace("  actions auto", "  computed\n    boolean :big(s) { return s.self.n > 1 }\n  actions auto"));
  expect(await types(root)).toEqual({ code: 0, output: "" });
  expect(expressions["computed.big"]!(sc({ n: 2 }))).toBe(true);
  expect(expressions["computed.big"]!(sc({ n: 0 }))).toBe(false);
  const run = Object.entries(expressions).find(([id]) => id.startsWith("go.") && id.includes("run"))![1];
  await expect(Promise.resolve(run(sc({ n: 1 })))).resolves.toBeUndefined();
  await expect(Promise.resolve().then(() => run(sc({ n: -1 })))).rejects.toThrow("negative");
});

test("the parameter has the scope type: a member the scope lacks fails the type check", async () => {
  const { root } = await generated(entity(`        check :c [
          that=(s) => s.self.nope > 0
          code="c"
          message="m"
        ]
`));
  const result = await types(root);
  expect(result.code).toBe(1);
  expect(result.output).toContain("nope");
});

test("`before` read through a plain parameter, and `Mesh.privileged` or an entity call in a computed field with one, are still refused", () => {
  const built = (src: string) => buildModel({ root: "/p", files: [{ file: "task.mesh.mx", source: src }] }).diagnostics.map((d) => d.code);
  expect(built(entity(`        check :c [\n          that=(s) => s.before.n > 0\n          code="c"\n          message="m"\n        ]\n`))).toContain("MESH_VALIDATE_BEFORE");
  expect(built('import { Mesh } from "meshfw"\n' + entity("", "  computed\n    boolean :x(s) { return s.self !== undefined && Mesh.privileged(Task) !== undefined }\n"))).toContain("MESH_COMPUTED_COMPOSES");
  expect(built(entity("", "  computed\n    boolean :x(s) { return s.self !== undefined && Task.read({}) !== undefined }\n"))).toContain("MESH_COMPUTED_COMPOSES");
  // `tx` is no scope name any more: through a plain parameter it is an unknown member, which TypeScript refuses.
  expect(built(entity("", "  computed\n    boolean :x(s) { return s.tx !== undefined }\n"))).not.toContain("MESH_COMPUTED_COMPOSES");
});
