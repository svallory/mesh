import { afterEach, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as crypto from "node:crypto";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EmitError, writeGeneratedFiles, type GeneratedFile } from "../src/typescript/emit.ts";
import type { ResolvedConfig } from "../src/config.ts";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }); });
async function project(): Promise<ResolvedConfig> {
  const root = await fs.mkdtemp(join(tmpdir(), "mesh-writer-"));
  roots.push(root);
  await fs.mkdir(join(root, "generated"));
  return { root, output: join(root, "generated"), configFile: join(root, "mesh.config.ts"), entityFiles: [], domainRoot: root, data: { kind: "data-adapter", name: "sqlite", build: "@meshfw/data-sqlite/build", capabilities: { adapter: "sqlite", capabilities: [] }, options: { file: ":memory:" } } };
}
const files: GeneratedFile[] = [
  { path: "generated/a.txt", contents: "new A" },
  { path: "generated/nested/z.txt", contents: "new Z" },
];

async function expectRefusal(config: ResolvedConfig, path: string, expected: string, found: string) {
  let error: unknown;
  try { await writeGeneratedFiles(files, config); } catch (cause) { error = cause; }
  expect(error).toBeInstanceOf(EmitError);
  expect((error as EmitError).diagnostic).toEqual({ severity: "error", code: "MESH_WRITE_PATH", fix: null,
    position: { file: path, line: 1, column: 0, offset: 0 },
    message: `Cannot write generated path "${path}": expected ${expected}, found ${found}; delete or move it and rebuild` });
}

test("round 2 M2: writer preflight rejects a regular file at the output root", async () => {
  const config = await project();
  await fs.rm(config.output, { recursive: true });
  await fs.writeFile(config.output, "keep output file");
  await expectRefusal(config, "generated", "a directory", "a regular file");
  expect(await fs.readFile(config.output, "utf8")).toBe("keep output file");
});

test("round 2 M2: writer preflight rejects a regular file at an intermediate directory", async () => {
  const config = await project();
  await fs.writeFile(join(config.output, "a.txt"), "old A");
  await fs.writeFile(join(config.output, "nested"), "keep obstruction");
  await expectRefusal(config, "generated/nested", "a directory", "a regular file");
  expect(await fs.readFile(join(config.output, "a.txt"), "utf8")).toBe("old A");
  expect(await fs.readFile(join(config.output, "nested"), "utf8")).toBe("keep obstruction");
});

test("round 2 M2: writer preflight rejects a socket without opening it or changing an earlier file", async () => {
  const config = await project();
  await fs.writeFile(join(config.output, "a.txt"), "old A");
  await fs.mkdir(join(config.output, "nested"));
  const server = createServer();
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(join(config.output, "nested/z.txt"), resolve); });
  try {
    await expectRefusal(config, "generated/nested/z.txt", "a regular file", "a socket");
    expect(await fs.readFile(join(config.output, "a.txt"), "utf8")).toBe("old A");
  } finally { await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); }
});

test("round 2 M1: exclusive replacement restores mode 0644 even under a restrictive umask", async () => {
  const config = await project();
  const target = join(config.output, "a.txt");
  await fs.writeFile(target, "old A");
  await fs.chmod(target, 0o200);
  const before = await fs.lstat(target);
  const umask = process.umask(0o777);
  try { await writeGeneratedFiles([files[0]!], config); }
  finally { process.umask(umask); }
  const after = await fs.lstat(target);
  expect(after.ino).not.toBe(before.ino);
  expect(after.mode & 0o777).toBe(0o644);
  expect(after.nlink).toBe(1);
  expect(await fs.readFile(target, "utf8")).toBe("new A");
  expect(await fs.readdir(config.output)).toEqual(["a.txt"]);
});

test.each(["write", "rename"])("round 2 M1: a failed %s cleans up its temporary file and preserves the target", async (phase) => {
  const config = await project();
  const target = join(config.output, "a.txt");
  await fs.writeFile(target, "old A");
  const failure = Object.assign(new Error("injected I/O failure"), { code: "EIO" });
  const realOpen = fs.open;
  const renameSpy = spyOn(fs, "rename");
  const openSpy = spyOn(fs, "open");
  if (phase === "rename") renameSpy.mockRejectedValueOnce(failure);
  else openSpy.mockImplementationOnce(async (...args) => {
    const handle = await realOpen(...args);
    spyOn(handle, "writeFile").mockRejectedValueOnce(failure);
    return handle;
  });
  try {
    await expect(writeGeneratedFiles([files[0]!], config)).rejects.toThrow(
      'Cannot replace generated file "generated/a.txt" (EIO); fix the output path or permissions and rebuild');
    expect(openSpy).toHaveBeenCalledWith(expect.any(String), "wx", 0o644);
    expect(await fs.readFile(target, "utf8")).toBe("old A");
    expect(await fs.readdir(config.output)).toEqual(["a.txt"]);
  } finally { openSpy.mockRestore(); renameSpy.mockRestore(); }
});

test("round 2 M1: temporary names skip produced paths and never overwrite an existing collision", async () => {
  const config = await project();
  const first = "00000000-0000-4000-8000-000000000001";
  const second = "00000000-0000-4000-8000-000000000002";
  const reserved = `generated/.mesh-${first}.tmp`;
  const uuid = spyOn(crypto, "randomUUID").mockReturnValueOnce(first).mockReturnValue(second);
  try {
    await writeGeneratedFiles([files[0]!, { path: reserved, contents: "produced temp-like name" }], config);
    expect(await fs.readFile(join(config.root, reserved), "utf8")).toBe("produced temp-like name");
    expect(await fs.readFile(join(config.output, "a.txt"), "utf8")).toBe("new A");
    await fs.writeFile(join(config.output, `.mesh-${second}.tmp`), "unrelated collision");
    await expect(writeGeneratedFiles([files[0]!], config)).rejects.toThrow(
      'Cannot replace generated file "generated/a.txt" (EEXIST); fix the output path or permissions and rebuild');
    expect(await fs.readFile(join(config.output, `.mesh-${second}.tmp`), "utf8")).toBe("unrelated collision");
  } finally { uuid.mockRestore(); }
});
