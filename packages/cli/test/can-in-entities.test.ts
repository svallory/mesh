// CMP-21 in an entity file, end to end: `Mesh.checkPolicies` and `Mesh.can` called by a function of an entity file, the
// docs' example (entities.md, "decide before you call"). The fixture (`fixtures/can-in-entities/domain/billing`) is an
// `Invoice` whose steps ask `Receipt.record`'s policies (system only, no more than 100, never ahead of the transaction's
// instant, and only for a paid invoice, read with `Mesh.privileged`) before they call it. `Ledger` hides the call in a
// helper (`probe.ts`), where the build cannot see it, from a computed field, a read policy and a write policy. The
// project is built by the real `mesh` command on the SQLite adapter, type-checked by tsc under the strictest flags, and
// run on SQLite in memory with a clock that advances on every read.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { cp, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ForbiddenError, FrameworkError, type Decision } from "@meshfw/runtime";

const repo = resolve(import.meta.dir, "../../..");
const fixture = join(import.meta.dir, "fixtures/can-in-entities/domain");
const projects: string[] = [];

// The adapter is imported by a computed specifier so that tsc does not type-check its sources under the project's
// stricter flags; the generated code reads only `data` and its `name`.
const CONFIG = `const adapter: string = "@meshfw/data-sqlite";
const { sqlite } = (await import(adapter)) as { sqlite(options: { file: string }): { readonly name: string } };
export default { domain: "domain", output: ".mesh", data: sqlite({ file: ":memory:" }) };
`;
const PACKAGE = {
  name: "can-in-entities", private: true, type: "module",
  imports: { "#mesh": "./.mesh/index.ts", "#mesh/domain": "./.mesh/domain/index.ts", "#mesh/domain/*": "./.mesh/domain/*/index.ts" },
};

/** A project outside the repo with the fixture's domain, the SQLite adapter and the packages linked in. */
async function project(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "can-in-entities-"));
  projects.push(root);
  await cp(fixture, join(root, "domain"), { recursive: true });
  await writeFile(join(root, "mesh.config.ts"), CONFIG);
  await writeFile(join(root, "package.json"), `${JSON.stringify(PACKAGE, null, 2)}\n`);
  // Bun's isolated linker keeps workspace dependencies at each package, so the project links what it imports.
  await mkdir(join(root, "node_modules/@meshfw"), { recursive: true });
  await mkdir(join(root, "node_modules/@types"), { recursive: true });
  await symlink(join(repo, "packages/cli"), join(root, "node_modules/meshfw"));
  for (const name of ["compiler", "model", "runtime", "data-sqlite"]) {
    await symlink(join(repo, "packages", name), join(root, "node_modules/@meshfw", name));
  }
  // The adapter's own dependencies (its query library and zod), as a project that installs it has them.
  const adapterModules = join(repo, "packages/data-sqlite/node_modules");
  for (const name of await readdir(adapterModules)) {
    if (name.startsWith(".") || name.startsWith("@")) continue;
    await symlink(await realpath(join(adapterModules, name)), join(root, "node_modules", name));
  }
  await symlink(await realpath(join(repo, "node_modules/@types/bun")), join(root, "node_modules/@types/bun"));
  return root;
}

function mesh(root: string, ...args: string[]) {
  const child = Bun.spawnSync([process.execPath, join(repo, "packages/cli/src/bin.ts"), ...args], { cwd: root });
  return { code: child.exitCode, stdout: child.stdout.toString(), stderr: child.stderr.toString() };
}

async function rejection<E>(call: Promise<unknown>, type: new (...args: never[]) => E): Promise<E> {
  const error = await call.then(() => undefined, (cause: unknown) => cause);
  expect(error).toBeInstanceOf(type);
  return error as E;
}

let root: string;
beforeAll(async () => {
  root = await project();
  expect(mesh(root, "build")).toEqual({ code: 0, stdout: "", stderr: "0 errors, 0 warnings\n" });
}, 30_000);
afterAll(async () => {
  for (const dir of projects.splice(0)) await rm(dir, { recursive: true, force: true });
});

const generated = (path: string) => readFile(join(root, ".mesh", path), "utf8");

describe("Mesh.checkPolicies and Mesh.can in an entity file (CMP-21)", () => {
  test("the expressions file binds the entity it names, imports Mesh and calls the question as written", async () => {
    const invoice = await generated("domain/billing/invoice.expressions.ts");
    expect(invoice).toContain("const Receipt: $billing$Receipt$ReadOnly = $billing$Receipt$value;");
    expect(invoice).toContain("await Mesh.can(Receipt.record, receipt, { ...context, system: true })");
    expect(invoice).toContain("await Mesh.checkPolicies(Receipt.record,");
    expect(invoice).toMatch(/import \{[^}]*\bMesh,[^}]*\} from "@meshfw\/runtime";/);
    // Nothing is wrapped: the value the function sees is the entity value the actions file exports.
    expect(invoice).not.toMatch(/Receipt\.record\.bind|new Proxy|\$entityValue/);
  });

  test("tsc type-checks the generated tree and the helper under the strictest flags", async () => {
    const files = (await readdir(join(root, ".mesh"), { recursive: true })).filter((name) => name.endsWith(".ts")).map((name) => join(".mesh", name));
    const child = Bun.spawnSync([
      join(repo, "node_modules/.bin/tsc"), "--ignoreConfig", "--noEmit", "--strict", "--noUncheckedIndexedAccess",
      "--module", "esnext", "--moduleResolution", "bundler", "--target", "es2022", "--skipLibCheck", "--noUnusedLocals", "--noUnusedParameters",
      "--exactOptionalPropertyTypes", "--verbatimModuleSyntax", "--isolatedModules", "--allowImportingTsExtensions", "--types", "bun",
      "mesh.config.ts", "domain/billing/probe.ts", ...files,
    ], { cwd: root });
    expect(child.stdout.toString() + child.stderr.toString()).toBe("");
    expect(child.exitCode).toBe(0);
  }, 60_000);

  test("on SQLite: asked before the call, a denied receipt is skipped and the outer action commits; unasked, the denied call fails the outer action even when caught", async () => {
    const app = await import(join(root, ".mesh/index.ts"));
    const { billing } = await import(join(root, ".mesh/domain/index.ts"));
    const { seen, hidden } = await import(join(root, "domain/billing/probe.ts")) as { seen: Record<string, unknown>[]; hidden: Promise<boolean>[] };
    const { sqlite, createSchema } = await import(Bun.resolveSync("@meshfw/data-sqlite", root));
    const layer = sqlite({ file: ":memory:" });
    await createSchema(layer, app.tables);
    const DAY = 86_400_000;
    let reads = 0;
    // Every read of the clock is a second later than the last: a call that read its own instant would never agree with the action's.
    const clock = () => new Date(DAY * 400 + 1_000 * ++reads);
    const anyone = {};
    const system = { system: true };
    const sure = <T>(value: T | undefined): T => { expect(value).toBeDefined(); return value as T; };
    try {
      await app.bind(layer, { clock }).run(async () => {
        const receipts = () => billing.Receipt.read({}, anyone) as Promise<{ invoiceId: string; amount: number }[]>;
        const statusOf = async (id: string) => sure((await billing.Invoice.read({}, anyone) as { id: string; status: string }[]).find((row) => row.id === id)).status;

        // Allowed: the step asks before it writes (the invoice is still open, so the receipt's `paid` policy says no) and
        // after (the action's own write is visible inside its transaction, so it says yes), and calls only the second.
        const small = await billing.Invoice.open({ amount: 50 }, anyone);
        await billing.Invoice.pay({ id: small.id }, anyone);
        expect(seen.splice(0)).toEqual([{ step: "before", allowed: false }]);
        expect(await receipts()).toMatchObject([{ invoiceId: small.id, amount: 50 }]);
        expect(await statusOf(small.id)).toBe("paid");

        // Denied (more than 100): the step skips the call, and the invoice still commits as paid.
        const large = await billing.Invoice.open({ amount: 500 }, anyone);
        await billing.Invoice.pay({ id: large.id }, anyone);
        expect(await receipts()).toHaveLength(1);
        expect(await statusOf(large.id)).toBe("paid");
        seen.splice(0);

        // Without the question the denied call fails the outer action, though the step catches it: why the docs say to decide first.
        const unchecked = await billing.Invoice.open({ amount: 500 }, anyone);
        const failure = await rejection(billing.Invoice.payUnchecked({ id: unchecked.id }, anyone), FrameworkError);
        expect(failure.cause).toBeInstanceOf(ForbiddenError);
        expect((failure.cause as ForbiddenError).entity).toBe("billing.Receipt");
        expect(seen.splice(0)).toEqual([{ step: "caught" }]);
        expect(await statusOf(unchecked.id)).toBe("open");
        expect(await receipts()).toHaveLength(1);
        // The same action succeeds where the call is allowed.
        const cheap = await billing.Invoice.open({ amount: 5 }, anyone);
        await billing.Invoice.payUnchecked({ id: cheap.id }, anyone);
        expect(await receipts()).toHaveLength(2);

        // `Mesh.checkPolicies` in a step: its breakdown is the one the call's ForbiddenError carries.
        const explained = await billing.Invoice.open({ amount: 500 }, anyone);
        await billing.Invoice.explain({ id: explained.id }, anyone);
        const [step] = seen.splice(0) as { step: string; decision: Decision }[];
        expect(step).toMatchObject({ step: "explain", decision: { allowed: false } });
        const called = await rejection(billing.Receipt.record({ invoiceId: explained.id, amount: 500, at: new Date(0) }, system), ForbiddenError);
        expect(step!.decision.breakdown).toEqual(called.breakdown);
        expect(called.breakdown.find((check) => check.decisive)).toMatchObject({ policy: "small", kind: "forbid-if", result: true });
        expect(await receipts()).toHaveLength(2);

        // Inside the step it reads the transaction's one instant: an input one millisecond ahead of `%.now` is ahead of the
        // transaction's instant (the clock moves a second at every read, so a fresh read would not say so), one at it is not.
        const stamped = await billing.Invoice.open({ amount: 1 }, anyone);
        await billing.Invoice.stamp({ id: stamped.id }, anyone);
        const [stamp] = seen.splice(0) as { now: Date; level: boolean; ahead: Decision }[];
        expect(stamp).toMatchObject({ level: true, ahead: { allowed: false } });
        expect(stamp!.now).toBeInstanceOf(Date);
        expect(stamp!.ahead.breakdown.find((check) => check.decisive)).toMatchObject({ policy: "notAhead", kind: "forbid-if", result: true });
        expect(hidden).toHaveLength(0);
      });
    } finally {
      await layer.close();
    }
  }, 30_000);

  test("a call hidden in a helper: refused while a computed field or a read policy is evaluated, and run in a write policy", async () => {
    const app = await import(join(root, ".mesh/index.ts"));
    const { billing } = await import(join(root, ".mesh/domain/index.ts"));
    const { hidden, seen, asker } = await import(join(root, "domain/billing/probe.ts")) as {
      hidden: Promise<boolean>[]; seen: unknown[]; asker: { current: ((context: { system?: boolean }, invoiceId: string) => Promise<boolean>) | undefined };
    };
    const { Mesh } = await import(Bun.resolveSync("meshfw", root));
    const { sqlite, createSchema } = await import(Bun.resolveSync("@meshfw/data-sqlite", root));
    const layer = sqlite({ file: ":memory:" });
    await createSchema(layer, app.tables);
    // What the helpers ask: the receipt of the invoice, for the system, as the call's context otherwise.
    asker.current = (context, invoiceId) => Mesh.can(billing.Receipt.record, { invoiceId, amount: 1, at: new Date(0) }, { ...context, system: true });
    const anyone = {};
    try {
      await app.bind(layer).run(async () => {
        const paid = await billing.Invoice.open({ amount: 1 }, anyone);
        await billing.Invoice.pay({ id: paid.id }, anyone);
        const open = await billing.Invoice.open({ amount: 1 }, anyone);
        const covered = await billing.Ledger.add({ name: "covered", invoiceId: paid.id }, anyone);
        const uncovered = await billing.Ledger.add({ name: "uncovered", invoiceId: open.id }, anyone);
        hidden.splice(0);

        // The read policy asks first (one question), then each row's computed field loads (two rows, two questions).
        const rows = await billing.Ledger.read({ load: ["covered"] }, anyone) as { covered: boolean }[];
        expect(rows.map((row) => row.covered)).toEqual([true, true]);
        const refusals = await Promise.all(hidden.map((asked) => asked.then(() => undefined, (error: unknown) => error)));
        expect(refusals).toHaveLength(3);
        for (const error of refusals) expect(error).toBeInstanceOf(FrameworkError);
        expect((refusals[0] as Error).message).toStartWith("Mesh.checkPolicies(billing.Receipt#record) was called while policy :looking of billing.Ledger is evaluated");
        for (const error of refusals.slice(1)) expect((error as Error).message).toStartWith("Mesh.checkPolicies(billing.Receipt#record) was called while computed :covered of billing.Ledger is evaluated");

        // A write policy is not marked (as a hidden `Mesh.privileged` read is not): the hidden call runs, and answers. The
        // receipt's `paid` policy says yes for the paid invoice and no for the open one.
        expect(await billing.Ledger.rename({ id: covered.id, name: "renamed" }, anyone)).toMatchObject({ name: "renamed" });
        await rejection(billing.Ledger.rename({ id: uncovered.id, name: "renamed" }, anyone), ForbiddenError);

        // An alias of Mesh (`M.can`) in another entity's step is the same function.
        seen.splice(0);
        await billing.Ledger.audit({ id: covered.id }, anyone);
        await billing.Ledger.audit({ id: uncovered.id }, anyone);
        expect(seen.splice(0)).toEqual([{ step: "audit", allowed: true }, { step: "audit", allowed: false }]);
      });
    } finally {
      await layer.close();
    }
  }, 30_000);
});
