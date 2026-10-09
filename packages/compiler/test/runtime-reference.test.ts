import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const repo = resolve(import.meta.dir, "../../..");
const tsc = join(repo, "node_modules/.bin/tsc");
function compile(args: string[], cwd: string) {
  const result = Bun.spawnSync([tsc, "--ignoreConfig", "--strict", "--target", "es2022", "--module", "esnext", "--moduleResolution", "bundler", "--allowImportingTsExtensions", "--skipLibCheck", ...args], { cwd });
  return { code: result.exitCode, output: result.stdout.toString() + result.stderr.toString() };
}

test("every documented runtime instance/type satisfies the emitted real declarations", async () => {
  const scratch = join(homedir(), "tmp/realignment-2");
  await mkdir(scratch, { recursive: true });
  const root = await mkdtemp(join(scratch, "runtime-reference-"));
  try {
    const reference = await readFile(join(repo, "apps/docs/samples/mesh-api.d.ts"), "utf8");
    const start = reference.indexOf('declare module "@meshfw/runtime" {');
    const end = reference.indexOf('declare module "@meshfw/data-sqlite" {', start);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    // A distinct module name prevents the sample's ambient declarations from
    // shadowing the real runtime. Compare actual emitted .d.ts, not a local copy.
    const section = reference.slice(start, end).replace('"@meshfw/runtime"', '"mesh-runtime-reference"');
    await writeFile(join(root, "reference.d.ts"), section);
    const emitted = compile(["--declaration", "--emitDeclarationOnly", "--outDir", join(root, "actual"), join(repo, "packages/runtime/src/index.ts")], root);
    expect(emitted).toEqual({ code: 0, output: "" });
    const names = [...section.matchAll(/export (?:interface|class) (\w+)/g)].map((match) => match[1]!);
    expect(names).toEqual(["ActionContext", "Issue", "PolicyCheck", "MeshError", "InvalidInputError", "NotFoundError", "ForbiddenError", "FrameworkError"]);
    // Check every documented member. Real errors additionally expose entity/key;
    // that extra API is not promised by the sample's deliberately smaller shape.
    const probe = `import type * as Docs from "mesh-runtime-reference";\nimport type * as Actual from "./actual/index";\n${names.map((name) => `declare const ${name}: Docs.${name};\n${name} satisfies Pick<Actual.${name}, keyof Docs.${name}>;`).join("\n")}\n`;
    await writeFile(join(root, "probe.ts"), probe);
    expect(compile(["--noEmit", "reference.d.ts", "probe.ts"], root)).toEqual({ code: 0, output: "" });
    // Tripwire: the comparator must not silently resolve both sides to Docs.
    await writeFile(join(root, "probe.ts"), probe + '\ndeclare const broken: Omit<Docs.Issue, "message">;\nbroken satisfies Actual.Issue;\n');
    const broken = compile(["--noEmit", "reference.d.ts", "probe.ts"], root);
    expect(broken.code).not.toBe(0);
    expect(broken.output).toContain("message");
  } finally { await rm(root, { recursive: true, force: true }); }
});
