// Named checks end to end. The fixture (`fixtures/named-checks/domain/billing`) declares its rules once in Invoice's
// `checks` section and uses them with `check &name` in several actions and in an `always` block. The project is built by
// the real `mesh` command on the SQLite adapter, type-checked by tsc under the strictest flags (each generated function
// is typed with its referring action's input), and run on SQLite in memory: a named check fails and passes in each
// action as an inline one would, with the declaration's label, code, message and source.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { cp, mkdir, mkdtemp, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const repo = resolve(import.meta.dir, "../../..");
const fixture = join(import.meta.dir, "fixtures/named-checks/domain");
const projects: string[] = [];

const CONFIG = `const adapter: string = "@meshfw/data-sqlite";
const { sqlite } = (await import(adapter)) as { sqlite(options: { file: string }): { readonly name: string } };
export default { domain: "domain", output: ".mesh", data: sqlite({ file: ":memory:" }) };
`;
const PACKAGE = {
  name: "named-checks", private: true, type: "module",
  imports: { "#mesh": "./.mesh/index.ts", "#mesh/domain": "./.mesh/domain/index.ts", "#mesh/domain/*": "./.mesh/domain/*/index.ts" },
};

/** A project outside the repo with the fixture's domain, the SQLite adapter and the packages linked in. */
async function project(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "named-checks-"));
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
  // The adapter's own dependencies (its query library and zod), as a project that installs it has them: the generated
  // schema and validators import them from the project.
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

let root: string;
beforeAll(async () => {
  root = await project();
  expect(mesh(root, "build")).toEqual({ code: 0, stdout: "", stderr: "0 errors, 0 warnings\n" });
}, 30_000);
afterAll(async () => {
  for (const dir of projects.splice(0)) await rm(dir, { recursive: true, force: true });
});

interface Row { id: string; issuedOn: Date; dueOn: Date; note: string | null; locked: boolean }
type Call = (input: Record<string, unknown>, context: object) => Promise<Row>;
interface Issue { label: string; code: string; message: string; source: { file: string; line: number }; details: unknown }

/** The issues an action's `InvalidInputError` carries; fails the test when the call resolves or fails otherwise. */
async function issuesOf(call: Promise<unknown>): Promise<Issue[]> {
  const error = await call.then(() => undefined, (e: unknown) => e);
  expect((error as { name?: string } | undefined)?.name).toBe("InvalidInputError");
  return (error as { issues: Issue[] }).issues;
}

describe("named checks", () => {
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

  test("on SQLite a named check runs in each action that uses it, as an inline check would", async () => {
    const app = await import(join(root, ".mesh/index.ts"));
    const domain = await import(join(root, ".mesh/domain/index.ts"));
    const { sqlite, createSchema } = await import(Bun.resolveSync("@meshfw/data-sqlite", root));
    const layer = sqlite({ file: ":memory:" });
    await createSchema(layer, app.tables);
    const binding = app.bind(layer);
    const anyone = {};
    const { Invoice, Customer, Line } = domain.billing as {
      Invoice: { issue: Call; reschedule: Call; annotate: Call; send: Call; pay: Call; explode: Call; lock: Call };
      Customer: { register: Call };
      Line: { add: Call };
    };
    const file = "domain/billing/invoice.mesh.mx";
    const dates = { label: "dueAfterIssue", code: "invalid_dates", message: "the due date cannot be before the issue date", source: { file, line: 17 }, details: null };
    try {
      await binding.run(async () => {
        const nameless = await Customer.register({ name: "" }, anyone);
        // A create and an update share `dueAfterIssue`: each fails with the declaration's issue, and passes with valid input.
        expect(await issuesOf(Invoice.issue({ issuedOn: new Date("2026-02-01"), dueOn: new Date("2026-01-01"), customer: nameless.id, note: null }, anyone))).toMatchObject([dates]);
        const invoice = await Invoice.issue({ issuedOn: new Date("2026-01-01"), dueOn: new Date("2026-02-01"), customer: nameless.id, note: null }, anyone);
        expect(await issuesOf(Invoice.reschedule({ id: invoice.id, dueOn: new Date("2025-12-01") }, anyone))).toMatchObject([dates]);
        expect(await Invoice.reschedule({ id: invoice.id, dueOn: new Date("2026-03-01") }, anyone)).toMatchObject({ id: invoice.id });
        // `when` skips the check: its `that` fails on a null note, which `when` rules out, so no issue comes of it, in the
        // create and in the update. A message function and `details` give their values when it fails.
        expect(invoice.note).toBeNull();
        expect(await Invoice.annotate({ id: invoice.id, note: null }, anyone)).toMatchObject({ note: null });
        expect(await issuesOf(Invoice.annotate({ id: invoice.id, note: "far too long a note" }, anyone))).toMatchObject([
          { label: "noteShort", code: "note_long", message: "the note has 19 characters", source: { file, line: 22 }, details: { length: 19 } },
        ]);
        expect(await Invoice.annotate({ id: invoice.id, note: "short" }, anyone)).toMatchObject({ note: "short" });
        // A rule over a relationship and a rollup loads them in each action that uses it; two failing checks give two
        // issues, in the order the action lists them.
        expect((await issuesOf(Invoice.send({ id: invoice.id }, anyone))).map((issue) => issue.label)).toEqual(["hasLines", "customerNamed"]);
        expect((await issuesOf(Invoice.pay({ id: invoice.id }, anyone))).map((issue) => issue.label)).toEqual(["customerNamed", "hasLines"]);
        const named = await Customer.register({ name: "Ada" }, anyone);
        const other = await Invoice.issue({ issuedOn: new Date("2026-01-01"), dueOn: new Date("2026-02-01"), customer: named.id, note: "ok" }, anyone);
        expect((await issuesOf(Invoice.send({ id: other.id }, anyone))).map((issue) => issue.label)).toEqual(["hasLines"]);
        await Line.add({ invoice: other.id }, anyone);
        expect(await Invoice.send({ id: other.id }, anyone)).toMatchObject({ id: other.id });
        expect(await Invoice.pay({ id: other.id }, anyone)).toMatchObject({ id: other.id });
        // A named check of an `always` block runs before the action's own.
        await Invoice.lock({ id: invoice.id }, anyone);
        expect((await issuesOf(Invoice.reschedule({ id: invoice.id, dueOn: new Date("2025-12-01") }, anyone))).map((issue) => issue.label)).toEqual(["notLocked", "dueAfterIssue"]);
        // A message function that throws names the check and its declaration's line.
        const thrown = await Invoice.explode({ id: other.id }, anyone).then(() => undefined, (e: unknown) => e as Error);
        expect(thrown?.name).toBe("FrameworkError");
        expect(thrown?.message).toContain(`the message of check :explodes of billing.Invoice (${file}:32) threw: nope`);
      });
    } finally {
      await layer.close();
    }
  }, 30_000);
});
