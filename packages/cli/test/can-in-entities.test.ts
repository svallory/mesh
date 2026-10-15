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
import { ForbiddenError, FrameworkError, InvalidInputError, NotFoundError, type Decision } from "@meshfw/runtime";

const repo = resolve(import.meta.dir, "../../..");
const fixture = join(import.meta.dir, "fixtures/can-in-entities/domain");
const projects: string[] = [];
// How many times the catching helper asks while a cyclic ledger is ground, with the error that sticks to the outermost question.
const GRIND_ACTION = 130;
const GRIND_OUTSIDE = 64;

// The adapter is imported by a computed specifier so that tsc does not type-check its sources under the project's
// stricter flags; the generated code reads only `data` and its `name`.
const CONFIG = `const adapter: string = "@meshfw/data-sqlite";
const { sqlite } = (await import(adapter)) as { sqlite(options: { file: string }): { readonly name: string } };
export default { domain: "domain", output: ".mesh", data: sqlite({ file: ":memory:" }) };
`;
/** The project's `src/context.ts` (PRJ-12): `context` and `actor` are typed by it, so a function reads only what it declares. */
const CONTEXT = `import "@meshfw/runtime";

declare module "@meshfw/runtime" {
  interface ActionContext {
    actor: { id: string };
    probe?: string;
  }
}
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
  await writeFile(join(root, "context.ts"), CONTEXT);
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
      "mesh.config.ts", "context.ts", "domain/billing/probe.ts", ...files,
    ], { cwd: root });
    expect(child.stdout.toString() + child.stderr.toString()).toBe("");
    expect(child.exitCode).toBe(0);
  }, 60_000);

  test("on SQLite: asked before the call, a denied receipt is skipped and the outer action commits; unasked, the denied call fails the outer action even when caught", async () => {
    const app = await import(join(root, ".mesh/index.ts"));
    const { billing } = await import(join(root, ".mesh/domain/index.ts"));
    const { seen } = await import(join(root, "domain/billing/probe.ts")) as { seen: Record<string, unknown>[] };
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
      });
    } finally {
      await layer.close();
    }
  }, 30_000);

  test("outside a computed field or a read policy, an action, Mesh.can and Mesh.checkPolicies report every failure as a rejected promise, never a synchronous throw", async () => {
    const app = await import(join(root, ".mesh/index.ts"));
    const { billing } = await import(join(root, ".mesh/domain/index.ts"));
    const { Mesh } = await import(Bun.resolveSync("meshfw", root));
    const { sqlite, createSchema } = await import(Bun.resolveSync("@meshfw/data-sqlite", root));
    const layer = sqlite({ file: ":memory:" });
    await createSchema(layer, app.tables);
    const system = { system: true };
    const missing = "00000000-0000-4000-8000-0000000000aa";
    const calls: Record<string, [string, () => Promise<unknown>][]> = {
      "an input error": [
        ["action", () => billing.Receipt.record({}, system)],
        ["can", () => Mesh.can(billing.Receipt.record, {}, system)],
        ["checkPolicies", () => Mesh.checkPolicies(billing.Receipt.record, {}, system)],
      ],
      "a missing row": [
        ["action", () => billing.Ledger.settle({ id: missing, name: "x" }, system)],
        ["can", () => Mesh.can(billing.Ledger.settle, { id: missing, name: "x" }, system)],
        ["checkPolicies", () => Mesh.checkPolicies(billing.Ledger.settle, { id: missing, name: "x" }, system)],
      ],
    };
    const expected: Record<string, new (...args: never[]) => Error> = { "an input error": InvalidInputError, "a missing row": NotFoundError };
    try {
      await app.bind(layer).run(async () => {
        for (const [what, list] of Object.entries(calls))
          for (const [which, call] of list) {
            expect(() => { call().catch(() => undefined); }, `${which}: ${what}`).not.toThrow();
            await rejection(call(), expected[what]!);
          }
        // A non-action argument: the two questions only.
        for (const ask of [Mesh.can, Mesh.checkPolicies]) {
          expect(() => { ask(42, {}, {}).catch(() => undefined); }).not.toThrow();
          await rejection(ask(42, {}, {}), FrameworkError);
        }
      });
    } finally {
      await layer.close();
    }
    // A missing binding: nothing is connected, and none is in scope.
    for (const [which, call] of [
      ["action", () => billing.Receipt.record({}, system)],
      ["can", () => Mesh.can(billing.Receipt.record, {}, system)],
      ["checkPolicies", () => Mesh.checkPolicies(billing.Receipt.record, {}, system)],
    ] as const) {
      expect(() => { call().catch(() => undefined); }, which).not.toThrow();
      expect((await rejection(call(), FrameworkError)).message, which).toContain("not connected");
    }
  }, 30_000);

  test("a call hidden in a helper: refused, by throwing, while a computed field or a read policy is evaluated, and run in a write policy", async () => {
    const app = await import(join(root, ".mesh/index.ts"));
    const { billing } = await import(join(root, ".mesh/domain/index.ts"));
    const { seen, asker, catching } = await import(join(root, "domain/billing/probe.ts")) as {
      seen: unknown[]; catching: { count: number }; asker: { current: ((kind: string, context: { system?: boolean }, id: string) => Promise<unknown>) | undefined };
    };
    const { Mesh } = await import(Bun.resolveSync("meshfw", root));
    const { sqlite, createSchema } = await import(Bun.resolveSync("@meshfw/data-sqlite", root));
    const layer = sqlite({ file: ":memory:" });
    await createSchema(layer, app.tables);
    // What the helpers ask: the receipt of an invoice, for the system, as the call's context otherwise; or a ledger's `settle`.
    const receipt = (id: string) => ({ invoiceId: id, amount: 1, at: new Date(0) });
    asker.current = (kind, context, id) => {
      const system = { ...context, system: true };
      if (kind === "can") return Mesh.can(billing.Receipt.record, receipt(id), system);
      if (kind === "checkPolicies") return Mesh.checkPolicies(billing.Receipt.record, receipt(id), system);
      if (kind === "settle") return Mesh.can(billing.Ledger.settle, { id, name: "settled" }, context);
      if (kind === "grind") return Mesh.can(billing.Ledger.grind, { id, name: "ground" }, context);
      return billing.Receipt.record(receipt(id), system);
    };
    const anyone = {};
    const message = (what: string, where: string) => `${what} was called while ${where} is evaluated: a computed field and a read policy read the record and what it loads, and call no action, make no privileged read and ask no action's policies. Load what it needs instead, or do it in a step or a check`;
    try {
      await app.bind(layer).run(async () => {
        const paid = await billing.Invoice.open({ amount: 1 }, anyone);
        await billing.Invoice.pay({ id: paid.id }, anyone);
        const open = await billing.Invoice.open({ amount: 1 }, anyone);
        const covered = await billing.Ledger.add({ name: "covered", invoiceId: paid.id }, anyone);
        const uncovered = await billing.Ledger.add({ name: "uncovered", invoiceId: open.id }, anyone);

        // The read policy asks: the call throws (it does not reject), so the policy fails with the reason.
        const byPolicy = await rejection(billing.Ledger.read({}, { probe: "policy" }), FrameworkError);
        expect(byPolicy.message).toBe(message("Mesh.can(billing.Receipt#record)", "policy :looking of billing.Ledger"));
        // A computed field whose helper calls each of the three gets the precise error, and each names its own call.
        const names = [["covered", "Mesh.can(billing.Receipt#record)"], ["viaCheck", "Mesh.checkPolicies(billing.Receipt#record)"], ["viaAction", "billing.Receipt#record"]] as const;
        for (const [field, what] of names) {
          const error = await rejection(billing.Ledger.read({ load: [field] }, anyone), FrameworkError);
          expect(error.message).toBe(message(what, "computed :" + field + " of billing.Ledger"));
        }
        // Without the field or the policy asking, the read goes on.
        expect(await billing.Ledger.read({}, anyone)).toHaveLength(2);

        // A write policy is not marked (as a hidden `Mesh.privileged` read is not): the hidden call runs, and answers. The
        // receipt's `paid` policy says yes for the paid invoice and no for the open one.
        expect(await billing.Ledger.rename({ id: covered.id, name: "renamed" }, anyone)).toMatchObject({ name: "renamed" });
        await rejection(billing.Ledger.rename({ id: uncovered.id, name: "renamed" }, anyone), ForbiddenError);

        // An alias of Mesh (`M.can`) in another entity's step is the same function.
        seen.splice(0);
        await billing.Ledger.audit({ id: covered.id }, anyone);
        await billing.Ledger.audit({ id: uncovered.id }, anyone);
        expect(seen.splice(0)).toEqual([{ step: "audit", allowed: true }, { step: "audit", allowed: false }]);

        // A recursion that ends answers: a ledger's policy asks about its parent's, up to the root, which has none.
        const root1 = await billing.Ledger.add({ name: "root", invoiceId: paid.id, parentId: null }, anyone);
        let parent = root1;
        for (let level = 0; level < 5; level++) parent = await billing.Ledger.add({ name: `level ${level}`, invoiceId: paid.id, parentId: parent.id }, anyone);
        expect(await billing.Ledger.settle({ id: parent.id, name: "settled" }, anyone)).toMatchObject({ name: "settled" });
        expect(await Mesh.can(billing.Ledger.settle, { id: parent.id, name: "x" }, anyone)).toBe(true);

        // A recursion that does not end (a ledger that is its own parent) stops at the cap, quickly, naming the action,
        // and nothing is written.
        const loop = await billing.Ledger.add({ name: "loop", invoiceId: paid.id }, anyone);
        await billing.Ledger.reparent({ id: loop.id, parentId: loop.id }, anyone);
        const began = performance.now();
        const deep = await rejection(billing.Ledger.settle({ id: loop.id, name: "never" }, anyone), FrameworkError);
        expect(deep.message).toContain("billing.Ledger#settle");
        expect(deep.message).toContain("ask other actions' policies too deeply, probably in a cycle");
        expect(performance.now() - began).toBeLessThan(5_000);
        const rows = await billing.Ledger.read({}, anyone) as { id: string; name: string }[];
        expect(rows.find((row) => row.id === loop.id)?.name).toBe("loop");
        // Asked from outside, the same cap.
        await rejection(Mesh.can(billing.Ledger.settle, { id: loop.id, name: "never" }, anyone), FrameworkError);

        // The boundary: a chain of 32 questions answers, the 33rd throws.
        const chain = async (ancestors: number) => {
          let last = await billing.Ledger.add({ name: "top", invoiceId: paid.id }, anyone);
          for (let level = 0; level < ancestors; level++) last = await billing.Ledger.add({ name: `a${level}`, invoiceId: paid.id, parentId: last.id }, anyone);
          return last;
        };
        expect(await billing.Ledger.settle({ id: (await chain(32)).id, name: "ok" }, anyone)).toMatchObject({ name: "ok" });
        const tooDeep = await rejection(billing.Ledger.settle({ id: (await chain(33)).id, name: "no" }, anyone), FrameworkError);
        expect(tooDeep.message).toContain("32 questions deep");

        // A fail-closed helper that catches the cap's error does not keep a cycle going: the error sticks to the outermost
        // question, which throws it whatever was decided. Two checks that both ask a cyclic row (each question asks twice, so
        // 2^33 questions without the stick) end at once, write nothing, and leave the event loop free.
        const grind = await billing.Ledger.add({ name: "grind", invoiceId: paid.id }, anyone);
        let ticked = false;
        const timer = new Promise<void>((done) => setTimeout(() => { ticked = true; done(); }, 20));
        const grindBegan = performance.now();
        catching.count = 0;
        // The action itself is denied (its own helper catches what the outermost question throws too, and answers false: fail
        // closed); it is not a question, so the cap's error does not reach it.
        await rejection(billing.Ledger.grind({ id: grind.id, name: "never" }, anyone), ForbiddenError);
        await timer;
        expect(performance.now() - grindBegan).toBeLessThan(5_000);
        expect(ticked).toBe(true);
        // The count, not the time: two checks ask at every level, 32 levels deep, and the sticky error ends the rest.
        expect(catching.count).toBe(GRIND_ACTION);
        const grindRows = await billing.Ledger.read({}, anyone) as { id: string; name: string }[];
        expect(grindRows.find((row) => row.id === grind.id)?.name).toBe("grind");
        // The same asked from outside, with a timer beside it: the outermost question throws the cap's error whatever its helpers caught.
        catching.count = 0;
        let outside = false;
        const beside = new Promise<void>((done) => setTimeout(() => { outside = true; done(); }, 20));
        const outsideError = await rejection(Mesh.can(billing.Ledger.grind, { id: grind.id, name: "never" }, anyone), FrameworkError);
        expect(outsideError.message).toContain("ask other actions' policies too deeply, probably in a cycle");
        await beside;
        expect(outside).toBe(true);
        expect(catching.count).toBe(GRIND_OUTSIDE);
      });
    } finally {
      await layer.close();
    }
  }, 30_000);
});
