// The Docs type-check their samples against apps/docs/samples/mesh-api.d.ts, which declares this package by hand. This
// test holds that block to the package: the same exported names, and the same types, readonly modifiers included. The
// check runs in a scratch folder beside the tests, so the block's `@meshfw/runtime` import resolves to the real runtime.
import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const repo = resolve(import.meta.dir, "../../..");
const tsc = join(repo, "node_modules/.bin/tsc");
const actual = join(repo, "packages/bus-local/src/index.ts");

function compile(files: string[], cwd: string) {
  const result = Bun.spawnSync([
    tsc, "--ignoreConfig", "--strict", "--noEmit", "--target", "es2022", "--module", "esnext", "--moduleResolution", "bundler",
    "--allowImportingTsExtensions", "--skipLibCheck", "--typeRoots", join(repo, "node_modules/@types"), "--types", "bun", ...files,
  ], { cwd });
  return { code: result.exitCode, output: result.stdout.toString() + result.stderr.toString() };
}

const probe = `import type * as Docs from "bus-local-reference";
import type * as Actual from ${JSON.stringify(actual)};
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
type Assert<T extends true> = T;
type OptionsParity = Assert<Equal<Docs.LocalBusOptions, Actual.LocalBusOptions>>;
type LocalBusParity = Assert<Equal<typeof Docs.localBus, typeof Actual.localBus>>;
`;

test("the Docs' declarations of @meshfw/bus-local match the package", async () => {
  const root = await mkdtemp(join(import.meta.dir, ".scratch-docs-"));
  try {
    const reference = await readFile(join(repo, "apps/docs/samples/mesh-api.d.ts"), "utf8");
    const start = reference.indexOf('declare module "@meshfw/bus-local" {');
    const end = reference.indexOf('declare module "@meshfw/jsonrpc" {', start);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const section = reference.slice(start, end).replace('"@meshfw/bus-local"', '"bus-local-reference"');
    const documented = [...section.matchAll(/^ {2}export (?:interface|class|type|function|const) (\w+)/gm)].map((match) => match[1]!);
    const index = await readFile(actual, "utf8");
    const exported = [...index.matchAll(/export (?:type )?\{([^}]*)\}/g)].flatMap((match) => match[1]!.split(",").map((name) => name.trim().replace(/^type /, "")));
    expect(documented.sort()).toEqual(exported.sort());

    await writeFile(join(root, "reference.d.ts"), section);
    await writeFile(join(root, "probe.ts"), probe);
    expect(compile(["reference.d.ts", "probe.ts"], root)).toEqual({ code: 0, output: "" });
    // Tripwire: the comparison must fail when the two sides differ.
    await writeFile(join(root, "probe.ts"), probe + 'type Broken = Assert<Equal<Docs.LocalBusOptions, Omit<Actual.LocalBusOptions, "maxQueue">>>;\n');
    const broken = compile(["reference.d.ts", "probe.ts"], root);
    expect(broken.code).not.toBe(0);
    expect(broken.output).toContain(`probe.ts(${probe.split("\n").length},`);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);
