// The Docs type-check their samples against apps/docs/samples/mesh-api.d.ts, which declares this package by hand.
// This test holds that block to the package: the same exported names, and the same types where a reader writes code
// against them. The one difference allowed is the `params` schema type, which the Docs spell structurally
// (`ParamsSchema`) because their `@meshfw/runtime` block does not declare `StandardSchemaV1`; every real Standard
// Schema validator must still fit it.
import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const repo = resolve(import.meta.dir, "../../..");
const tsc = join(repo, "node_modules/.bin/tsc");
const actual = join(repo, "packages/jsonrpc/src/index.ts");

function compile(files: string[], cwd: string) {
  const result = Bun.spawnSync([
    tsc, "--ignoreConfig", "--strict", "--noEmit", "--target", "es2022", "--module", "esnext", "--moduleResolution", "bundler",
    "--allowImportingTsExtensions", "--skipLibCheck", "--typeRoots", join(repo, "node_modules/@types"), "--types", "bun", ...files,
  ], { cwd });
  return { code: result.exitCode, output: result.stdout.toString() + result.stderr.toString() };
}

const probe = `import type * as Docs from "jsonrpc-reference";
import type * as Actual from ${JSON.stringify(actual)};
import type { StandardSchemaV1 } from ${JSON.stringify(join(repo, "packages/runtime/src/index.ts"))};
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
type Assert<T extends true> = T;
type C = { actor: string };
type P = { name: string };
type T = { a: P; b: unknown };
type Sent = Readonly<Record<string, unknown>>;
type ErrorObjectParity = Assert<Equal<Docs.ErrorObject, Actual.ErrorObject>>;
type ParamsIssueParity = Assert<Equal<Docs.ParamsIssue, Actual.ParamsIssue>>;
type ServerParity = Assert<Equal<Docs.Server, Actual.Server>>;
type ConnectionParity = Assert<Equal<Docs.Connection, Actual.Connection>>;
type CallParity = Assert<Equal<Docs.Call, Actual.Call>>;
type CodesParity = Assert<Equal<typeof Docs.codes, typeof Actual.codes>>;
type OptionsParity = Assert<Equal<Omit<Docs.ServeOptions<C, T>, "methods">, Omit<Actual.ServeOptions<C, T>, "methods">>>;
type OptionKeys = Assert<Equal<keyof Docs.ServeOptions<C, T>, keyof Actual.ServeOptions<C, T>>>;
type MethodsKeys = Assert<Equal<keyof Docs.ServeOptions<C, T>["methods"], keyof Actual.ServeOptions<C, T>["methods"]>>;
type MethodsTyped = Assert<Equal<Parameters<Docs.ServeOptions<C, T>["methods"]["a"]["run"]>, Parameters<Actual.ServeOptions<C, T>["methods"]["a"]["run"]>>>;
type MethodsUntyped = Assert<Equal<Parameters<Docs.ServeOptions<C, T>["methods"]["b"]["run"]>, Parameters<Actual.ServeOptions<C, T>["methods"]["b"]["run"]>>>;
type MethodParity = Assert<Equal<Omit<Docs.Method<C, P>, "params">, Omit<Actual.Method<C, P>, "params">>>;
type MethodKeys = Assert<Equal<keyof Docs.Method<C, P>, keyof Actual.Method<C, P>>>;
type MethodDefault = Assert<Equal<Parameters<Docs.Method<C>["run"]>, Parameters<Actual.Method<C>["run"]>>>;
type MethodDefaultSent = Assert<Equal<Parameters<Actual.Method<C>["run"]>[0], Sent>>;
type TableKeys = Assert<Equal<keyof Docs.MethodTable<C>, keyof Actual.MethodTable<C>>>;
type TableRun = Assert<Equal<Parameters<Docs.MethodTable<C>[string]["run"]>, Parameters<Actual.MethodTable<C>[string]["run"]>>>;
type TableRunSent = Assert<Equal<Parameters<Actual.MethodTable<C>[string]["run"]>[0], Sent>>;
type ServeParameters = Assert<Equal<Parameters<typeof Docs.serve<C, T>>[0]["context"], Parameters<typeof Actual.serve<C, T>>[0]["context"]>>;
type ServeResult = Assert<Equal<Awaited<ReturnType<typeof Docs.serve<C, T>>>, Awaited<ReturnType<typeof Actual.serve<C, T>>>>>;
type RpcErrorArguments = Assert<Equal<ConstructorParameters<typeof Docs.RpcError>, ConstructorParameters<typeof Actual.RpcError>>>;
type RpcErrorMembers = Assert<Equal<Pick<Docs.RpcError, "code" | "data" | "message">, Pick<Actual.RpcError, "code" | "data" | "message">>>;
declare const schema: StandardSchemaV1<unknown, P>;
schema satisfies NonNullable<Docs.Method<C, P>["params"]>;
// An inline table infers each entry's params type from its schema, on both sides.
declare const docsServe: typeof Docs.serve;
declare const actualServe: typeof Actual.serve;
const context = (): C => ({ actor: "ana" });
docsServe({ socket: "s", context, methods: { a: { params: schema, run: (params) => params satisfies P }, b: { run: (params) => params satisfies Sent } } });
actualServe({ socket: "s", context, methods: { a: { params: schema, run: (params) => params satisfies P }, b: { run: (params) => params satisfies Sent } } });
// @ts-expect-error a run written for another type than the schema outputs
docsServe({ socket: "s", context, methods: { a: { params: schema, run: (params: { name: number }) => params } } });
// @ts-expect-error a run written for another type than the schema outputs
actualServe({ socket: "s", context, methods: { a: { params: schema, run: (params: { name: number }) => params } } });
`;

test("the Docs' declarations of @meshfw/jsonrpc match the package", async () => {
  const root = await mkdtemp(join(tmpdir(), "jsonrpc-reference-"));
  try {
    const reference = await readFile(join(repo, "apps/docs/samples/mesh-api.d.ts"), "utf8");
    const start = reference.indexOf('declare module "@meshfw/jsonrpc" {');
    const end = reference.indexOf('declare module "meshfw" {', start);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const section = reference.slice(start, end).replace('"@meshfw/jsonrpc"', '"jsonrpc-reference"');
    const documented = [...section.matchAll(/^ {2}export (?:interface|class|type|function|const) (\w+)/gm)].map((match) => match[1]!);
    const index = await readFile(actual, "utf8");
    const exported = [...index.matchAll(/export (?:type )?\{([^}]*)\}/g)].flatMap((match) => match[1]!.split(",").map((name) => name.trim()));
    expect(documented.filter((name) => name !== "ParamsSchema").sort()).toEqual(exported.sort());

    await writeFile(join(root, "reference.d.ts"), section);
    await writeFile(join(root, "probe.ts"), probe);
    expect(compile(["reference.d.ts", "probe.ts"], root)).toEqual({ code: 0, output: "" });
    // Tripwire: the comparison must fail when the two sides differ.
    await writeFile(join(root, "probe.ts"), probe + 'type Broken = Assert<Equal<Docs.ErrorObject, Omit<Actual.ErrorObject, "data">>>;\n');
    const broken = compile(["reference.d.ts", "probe.ts"], root);
    expect(broken.code).not.toBe(0);
    expect(broken.output).toContain(`probe.ts(${probe.split("\n").length},`);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);
