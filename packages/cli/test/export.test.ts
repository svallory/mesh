import { afterEach, expect, test } from "bun:test";
import { mkdtemp, open, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exportGenerators } from "../src/export.ts";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

test("a creation that fails after an earlier write names the files already written", async () => {
  const root = await mkdtemp(join(tmpdir(), "mesh-export-"));
  roots.push(root);
  let calls = 0;
  const failSecond = ((...args: Parameters<typeof open>) => {
    calls += 1;
    if (calls === 2) return Promise.reject(Object.assign(new Error("disk full"), { code: "ENOSPC" }));
    return open(...args);
  }) as typeof open;
  const result = await exportGenerators(root, [], failSecond);
  expect(result.written).toEqual([".mesh-generators/types.ts.jig"]);
  expect(result.diagnostics.map((d) => [d.position.file, d.message])).toEqual([
    [".mesh-generators/validators.ts.jig", "Cannot create it (ENOSPC); already written: .mesh-generators/types.ts.jig"],
  ]);
  expect(await readdir(join(root, ".mesh-generators"))).toEqual(["types.ts.jig"]);
});

test("a first creation that fails says nothing was written", async () => {
  const root = await mkdtemp(join(tmpdir(), "mesh-export-"));
  roots.push(root);
  const failing = (() => Promise.reject(Object.assign(new Error("denied"), { code: "EACCES" }))) as unknown as typeof open;
  const result = await exportGenerators(root, [], failing);
  expect(result.written).toEqual([]);
  expect(result.diagnostics.map((d) => d.message)).toEqual(["Cannot create it (EACCES); nothing was written"]);
});
