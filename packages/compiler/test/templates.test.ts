import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GENERATORS } from "../src/typescript/emit.ts";
import { EmitError } from "../src/typescript/emit-error.ts";
import { MESH_TEMPLATES_DIR, loadTemplates } from "../src/typescript/templates.ts";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) {
    await chmod(join(root, ".mesh-generators/types.ts.jig"), 0o644).catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
});
async function projectRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "mesh-templates-"));
  roots.push(root);
  return root;
}
async function readError(root: string): Promise<EmitError> {
  try { await loadTemplates(GENERATORS, root); }
  catch (cause) { if (cause instanceof EmitError) return cause; throw cause; }
  throw new Error("expected MESH_TEMPLATE_READ");
}
const at = (file: string) => ({ file, line: 1, column: 0, offset: 0 });

describe("template lookup", () => {
  test("no .mesh-generators/: every template is Mesh's own, named by its absolute path", async () => {
    const templates = await loadTemplates(GENERATORS, await projectRoot());
    expect([...templates].map(([name, t]) => [name, t.path])).toEqual([
      ["types.ts.jig", join(MESH_TEMPLATES_DIR, "types.ts.jig")],
      ["validators.ts.jig", join(MESH_TEMPLATES_DIR, "validators.ts.jig")],
      ["expressions.ts.jig", join(MESH_TEMPLATES_DIR, "expressions.ts.jig")],
      ["actions.ts.jig", join(MESH_TEMPLATES_DIR, "actions.ts.jig")],
      ["index.ts.jig", join(MESH_TEMPLATES_DIR, "index.ts.jig")],
    ]);
  });

  test("a project template that is a regular file replaces Mesh's for that template only", async () => {
    const root = await projectRoot();
    await mkdir(join(root, ".mesh-generators"));
    await writeFile(join(root, ".mesh-generators/validators.ts.jig"), "// mine\n");
    const templates = await loadTemplates(GENERATORS, root);
    expect(templates.get("validators.ts.jig")).toEqual({ path: ".mesh-generators/validators.ts.jig", contents: "// mine\n" });
    expect(templates.get("types.ts.jig")!.path).toBe(join(MESH_TEMPLATES_DIR, "types.ts.jig"));
  });

  test("a file Mesh has no generator for is ignored", async () => {
    const root = await projectRoot();
    await mkdir(join(root, ".mesh-generators"));
    await writeFile(join(root, ".mesh-generators/action.ts.jig"), "x");
    expect([...(await loadTemplates(GENERATORS, root)).values()].every((t) => t.path.startsWith(MESH_TEMPLATES_DIR))).toBe(true);
  });
});

describe("MESH_TEMPLATE_READ", () => {
  test("a directory at the template's path", async () => {
    const root = await projectRoot();
    await mkdir(join(root, ".mesh-generators/types.ts.jig"), { recursive: true });
    const error = await readError(root);
    expect(error.diagnostic.code).toBe("MESH_TEMPLATE_READ");
    expect(error.diagnostic.position).toEqual(at(".mesh-generators/types.ts.jig"));
    expect(error.diagnostic.message).toBe('The template ".mesh-generators/types.ts.jig" is not a regular file; delete or move it');
  });

  test("a symlinked template is refused, whatever it points at", async () => {
    const root = await projectRoot();
    await mkdir(join(root, ".mesh-generators"));
    await writeFile(join(root, "real.jig"), "x");
    await symlink(join(root, "real.jig"), join(root, ".mesh-generators/validators.ts.jig"));
    const error = await readError(root);
    expect(error.diagnostic.position).toEqual(at(".mesh-generators/validators.ts.jig"));
    expect(error.diagnostic.message).toContain("is a symlink");
  });

  test("a FIFO at the template's path is refused without blocking", async () => {
    const root = await projectRoot();
    await mkdir(join(root, ".mesh-generators"));
    expect(Bun.spawnSync(["mkfifo", join(root, ".mesh-generators/types.ts.jig")]).exitCode).toBe(0);
    const error = await readError(root);
    expect(error.diagnostic.position).toEqual(at(".mesh-generators/types.ts.jig"));
    expect(error.diagnostic.message).toBe('The template ".mesh-generators/types.ts.jig" is not a regular file; delete or move it');
  });

  test("a symlinked .mesh-generators/ is refused", async () => {
    const root = await projectRoot();
    await mkdir(join(root, "elsewhere"));
    await symlink(join(root, "elsewhere"), join(root, ".mesh-generators"));
    const error = await readError(root);
    expect(error.diagnostic.position).toEqual(at(".mesh-generators"));
    expect(error.diagnostic.message).toBe('".mesh-generators" is a symlink; make it a real directory');
  });

  test("a file named .mesh-generators is refused", async () => {
    const root = await projectRoot();
    await writeFile(join(root, ".mesh-generators"), "");
    expect((await readError(root)).diagnostic.position).toEqual(at(".mesh-generators"));
  });

  test.skipIf(process.getuid?.() === 0)("an unreadable template names its path and the error code", async () => {
    const root = await projectRoot();
    await mkdir(join(root, ".mesh-generators"));
    await writeFile(join(root, ".mesh-generators/types.ts.jig"), "x");
    await chmod(join(root, ".mesh-generators/types.ts.jig"), 0o000);
    const error = await readError(root);
    expect(error.diagnostic.position).toEqual(at(".mesh-generators/types.ts.jig"));
    expect(error.diagnostic.message).toBe('Cannot read the template ".mesh-generators/types.ts.jig" (EACCES); fix its permissions');
  });

  test("negative: a readable regular file is no diagnostic", async () => {
    const root = await projectRoot();
    await mkdir(join(root, ".mesh-generators"));
    await writeFile(join(root, ".mesh-generators/types.ts.jig"), "x");
    expect((await loadTemplates(GENERATORS, root)).get("types.ts.jig")!.path).toBe(".mesh-generators/types.ts.jig");
  });
});
