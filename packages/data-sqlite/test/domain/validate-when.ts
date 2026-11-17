// A `when=condition` line inside `validate` (ADR-0053, ruling D27): the checks under it run only when the condition holds.
// The generated action evaluates the condition once per call, at its written position, as an `if` around the checks; a
// false or unknown result skips them. A domain is built, generated, pushed to the adapter's database and called; a helper records each
// evaluation of a condition, and the context says what each condition answers and which checks fail.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { ModelDocument } from "@meshfw/model";
import { buildModel, generateFiles, writeGeneratedFiles, type ResolvedConfig } from "@meshfw/compiler";
import { callsOf } from "../calls.ts";
import { InvalidInputError, type Issue } from "@meshfw/runtime";
import { SCRATCH, TSC, type DomainAdapter } from "./harness.ts";

const helpers = `// A condition: records that it ran and what it saw, then answers what the context says (true when it says nothing).
export function cond(context: any, tag: string, saw?: any): any {
  context.calls.push({ tag, ...(saw === undefined ? {} : { saw }) });
  if (context.throwIn === tag) throw new Error("boom " + tag);
  return tag in context.answers ? context.answers[tag] : true;
}
export async function condLater(context: any, tag: string): Promise<boolean> {
  await new Promise((done) => setTimeout(done, 1));
  return cond(context, tag);
}
// A check: passes unless the context lists it as failing.
export function pass(context: any, name: string): boolean {
  return !context.fail.includes(name);
}
// A condition over a number: records what it saw and holds when it is above zero.
export function above(context: any, tag: string, n: number): boolean {
  context.calls.push({ tag, saw: n });
  return n > 0;
}
// What a step saw: that it ran.
export function ran(context: any, name: string): void {
  context.calls.push({ tag: "step " + name });
}
`;

const person = `import { Invoice } from "./invoice.mesh.mx"
import { above, pass } from "./helpers"
entity :Person table="people"
  attributes
    uuid :id primary-key
    string :name min=1
  relationships
    has-many :invoices entity=Invoice
  computed
    count :invoiceCount of=&invoices
  actions auto=[:read]
    create :join
      input
        &name
    update :rename
      input
        &name
      validate
        when=({ context }) => above(context, "counted", &invoiceCount)
          check :countedCheck that=({ context }) => pass(context, "counted") code="counted" message="counted"
  policies
    policy :anyCaller
      authorize-if=() => true
`;

const invoice = `import { Person } from "./person.mesh.mx"
import { cond, condLater, pass, ran } from "./helpers"
entity :Invoice table="invoices"
  attributes
    uuid :id primary-key
    integer :amount
    enum :status values=[:draft, :sent] default=:draft
    string :note nullable
  relationships
    belongs-to :owner entity=Person
  computed
    boolean :big() { return self.amount > 100 }
  checks
    check :noted that=({ context }) => pass(context, "noted") code="noted" message="noted"
  actions auto=[:read, :update]
    always types=[:create, :destroy]
      validate
        when=({ context }) => cond(context, "always")
          check :alwaysCheck that=({ context }) => pass(context, "always") code="always" message="always"
    always actions=[&update]
      validate
        when=({ context }) => cond(context, "auto")
          check :autoCheck that=({ context }) => pass(context, "auto") code="auto" message="auto"
    always actions=[&setAmount, &setNote]
      validate
        when=({ context }) => cond(context, "disjoint")
          check :disjointCheck that=({ context }) => pass(context, "disjoint") code="disjoint" message="disjoint"
    always types=[:update]
      validate
        when=({ context }) => cond(context, "updates")
          check :updatesCheck that=({ context }) => pass(context, "updates") code="updates" message="updates"
    create :issue
      input
        &amount
        &owner
        &note
      validate
        when=({ self, input, context, ...rest }) => cond(context, "issue", { self: { amount: self.amount, status: self.status, note: self.note }, input: { ...input }, rest: Object.keys(rest).sort() })
          check :a that=({ context }) => pass(context, "a") code="a" message="a"
          check :b that=({ context }) => pass(context, "b") code="b" message="b"
          check :own that=({ context }) => pass(context, "own") when=({ context }) => cond(context, "ownWhen") code="own" message="own"
          when=({ context }) => cond(context, "inner")
            check :innerCheck that=({ context }) => pass(context, "inner") code="inner" message="inner"
        check :c that=({ context }) => pass(context, "c") code="c" message="c"
      do
        run({ context }) {
          ran(context, "issue");
        }
    update :send
      validate
        when=({ self, context }) => cond(context, "send", { amount: self.amount })
          check &noted
        when=async ({ context }) => await condLater(context, "later")
          check :laterCheck that=({ context }) => pass(context, "later") code="later" message="later"
        when=({ context }) => cond(context, "loaded", { owner: &owner.name, big: &big })
          check :loadedCheck that=({ context }) => pass(context, "loaded") code="loaded" message="loaded"
      do
        set
          &status=:sent
    update :setAmount
      input
        &amount
    update :setNote
      input
        &note
    destroy :drop
      validate
        when=({ self, context }) => cond(context, "drop", { amount: self.amount })
          check :dropCheck that=({ context }) => pass(context, "drop") code="drop" message="drop"
  policies
    policy :anyCaller
      authorize-if=() => true
    policy :notLocked types=[:update]
      forbid-if=() => &note === "locked"
`;

export function validateWhenSuite(adapter: DomainAdapter): void {
  const DATA = adapter.data(["aggregates", "integer-key-fill"]);

  let dir: string;
  let app: any;
  let domain: any;
  beforeAll(async () => {
    dir = await mkdtemp(join(SCRATCH, ".scratch-validate-when-"));
    const config: ResolvedConfig = { root: dir, configFile: join(dir, "mesh.config.ts"), entityFiles: [], domainRoot: join(dir, "src/domain"), output: join(dir, ".mesh"), data: DATA };
    await Bun.write(join(dir, "src/domain/helpers.ts"), helpers);
    const built = buildModel({ root: dir, domainRoot: join(dir, "src/domain"), files: Object.entries({ person, invoice }).map(([name, source]) => ({ file: `src/domain/${name}.mesh.mx`, source })) });
    expect(built.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    await writeGeneratedFiles(await generateFiles({ config, document: built.document as ModelDocument }, adapter.build), config);
    // `binding.ts` imports the project's config, which is not part of this fixture.
    await Bun.write(join(dir, "mesh.config.ts"), "export default { data: { name: 'sqlite', transaction: async () => undefined, close: async () => undefined } };\n");
    app = await import(join(dir, ".mesh/index.ts"));
    domain = await import(join(dir, ".mesh/domain/index.ts"));
  });
  afterAll(async () => { if (dir) await rm(dir, { recursive: true, force: true }); });

  type Call = { tag: string; saw?: any };
  async function fresh() {
    const db = await adapter.layer(app.tables);
    const ctx = { calls: [] as Call[], answers: {} as Record<string, unknown>, fail: [] as string[], throwIn: undefined as string | undefined };
    const mesh = callsOf(app.bind(db), domain);
    const ada = await mesh.joinPerson({ name: "Ada" }, ctx);
    return { db, mesh, ctx, ada };
  }
  type World = Awaited<ReturnType<typeof fresh>>;
  /** Run `body` with the context set as given, then reset it. */
  async function using<T>(world: World, setup: { answers?: Record<string, unknown>; fail?: string[]; throwIn?: string }, body: () => Promise<T>): Promise<T> {
    world.ctx.calls.length = 0;
    world.ctx.answers = setup.answers ?? {};
    world.ctx.fail = setup.fail ?? [];
    world.ctx.throwIn = setup.throwIn;
    try { return await body(); } finally { world.ctx.answers = {}; world.ctx.fail = []; world.ctx.throwIn = undefined; }
  }
  async function rejected(call: Promise<unknown>): Promise<unknown> {
    try { await call; } catch (error) { return error; }
    throw new Error("expected the call to reject");
  }
  const labels = (error: unknown) => {
    expect(error).toBeInstanceOf(InvalidInputError);
    return (error as InvalidInputError).issues.map((issue: Issue) => issue.label);
  };
  const tags = (world: World) => world.ctx.calls.map((call) => call.tag);
  const count = (world: World, tag: string) => world.ctx.calls.filter((call) => call.tag === tag).length;
  const issue = (world: World, extra: Record<string, unknown> = {}) => world.mesh.issueInvoice({ amount: 5, owner: world.ada.id, note: "n", ...extra }, world.ctx);
  const EVERY = ["always", "a", "b", "own", "inner", "c"];

  describe("the generated files", () => {
    test("type-check under the strictest flags, with `when` lines in `always` blocks over a create and a destroy, an auto update and disjoint inputs", async () => {
      const files = (await readdir(join(dir, ".mesh"), { recursive: true })).filter((name) => name.endsWith(".ts")).map((name) => join(".mesh", name));
      const child = Bun.spawnSync([
        TSC, "--ignoreConfig", "--noEmit", "--strict", "--noUncheckedIndexedAccess",
        "--module", "esnext", "--moduleResolution", "bundler", "--target", "es2022", "--skipLibCheck", "--noUnusedLocals", "--noUnusedParameters",
        "--exactOptionalPropertyTypes", "--verbatimModuleSyntax", "--isolatedModules", "--allowImportingTsExtensions", "mesh.config.ts", ...files,
      ], { cwd: dir });
      expect(child.stdout.toString() + child.stderr.toString()).toBe("");
    }, 30_000);
  });

  describe("a create", () => {
    test("condition true: every check under it runs, the `always` block's first, in written order", async () => {
      const world = await fresh();
      try {
        const error = await using(world, { fail: EVERY }, () => rejected(issue(world)));
        expect(labels(error)).toEqual(["alwaysCheck", "a", "b", "own", "innerCheck", "c"]);
        expect(await world.mesh.readInvoice({}, world.ctx)).toEqual([]);
        expect(tags(world)).not.toContain("step issue");
      } finally { await world.db.close(); }
    });

    test.each([["false", false], ["null", null], ["undefined", undefined]])("condition %s: the checks under it are skipped, the others run", async (_name, answer) => {
      const world = await fresh();
      try {
        const error = await using(world, { answers: { always: answer, issue: answer }, fail: EVERY }, () => rejected(issue(world)));
        expect(labels(error)).toEqual(["c"]);
        // Nothing under a skipped group is evaluated: neither a check's own `when=` nor an inner group's condition.
        expect(tags(world)).toEqual(["always", "issue"]);
      } finally { await world.db.close(); }
    });

    test("once: each condition is evaluated once per call, however many checks it guards", async () => {
      const world = await fresh();
      try {
        await using(world, {}, () => issue(world));
        expect(tags(world)).toEqual(["always", "issue", "ownWhen", "inner", "step issue"]);
        await using(world, {}, () => issue(world));
        expect(count(world, "issue")).toBe(1);
      } finally { await world.db.close(); }
    });

    test("nesting: the inner condition runs only when the outer holds; both true runs the inner checks", async () => {
      const world = await fresh();
      try {
        await using(world, { answers: { inner: false }, fail: ["inner"] }, () => issue(world));
        expect(tags(world)).toContain("inner");
        expect(labels(await using(world, { fail: ["inner"] }, () => rejected(issue(world))))).toEqual(["innerCheck"]);
        // The outer false: the inner condition is not evaluated at all.
        await using(world, { answers: { issue: false }, fail: ["inner"] }, () => issue(world));
        expect(tags(world)).not.toContain("inner");
      } finally { await world.db.close(); }
    });

    test("a check with its own `when=` under a group runs only when both hold", async () => {
      const world = await fresh();
      try {
        expect(labels(await using(world, { fail: ["own"] }, () => rejected(issue(world))))).toEqual(["own"]);
        await using(world, { answers: { ownWhen: false }, fail: ["own"] }, () => issue(world));
        await using(world, { answers: { issue: false }, fail: ["own"] }, () => issue(world));
        expect(tags(world)).not.toContain("ownWhen");
      } finally { await world.db.close(); }
    });

    test("what the condition sees: the new instance before the input, the caller's input, and no `before`", async () => {
      const world = await fresh();
      try {
        await using(world, {}, () => issue(world, { amount: 7, note: "x" }));
        const saw = world.ctx.calls.find((call) => call.tag === "issue")!.saw;
        expect(saw).toMatchObject({ self: { amount: null, status: "draft", note: null }, input: { amount: 7, owner: world.ada.id, note: "x" } });
        expect(saw.rest).not.toContain("before");
      } finally { await world.db.close(); }
    });

    test("every check passing stores the row and runs the step", async () => {
      const world = await fresh();
      try {
        const row: { id: string } = await using(world, {}, () => issue(world));
        expect(tags(world)).toContain("step issue");
        expect((await world.mesh.readInvoice({}, world.ctx)).map((r: { id: string }) => r.id)).toEqual([row.id]);
      } finally { await world.db.close(); }
    });

    test("a condition that throws rejects the call with that error and stores nothing", async () => {
      const world = await fresh();
      try {
        const error = await using(world, { throwIn: "issue" }, () => rejected(issue(world)));
        expect((error as Error).message).toContain("boom issue");
        expect(await world.mesh.readInvoice({}, world.ctx)).toEqual([]);
      } finally { await world.db.close(); }
    });
  });

  describe("an update", () => {
    test("self is the stored row; a `check &name` under a group runs only when the group holds", async () => {
      const world = await fresh();
      try {
        const row = await issue(world, { amount: 9 });
        const error = await using(world, { fail: ["noted"] }, () => rejected(world.mesh.sendInvoice({ id: row.id }, world.ctx)));
        expect(labels(error)).toEqual(["noted"]);
        expect(world.ctx.calls.find((call) => call.tag === "send")!.saw).toEqual({ amount: 9 });
        await using(world, { answers: { send: false }, fail: ["noted"] }, () => world.mesh.sendInvoice({ id: row.id }, world.ctx));
        expect((await world.mesh.readInvoice({}, world.ctx))[0].status).toBe("sent");
      } finally { await world.db.close(); }
    });

    test("an `async` condition is awaited: its false skips, its true runs the checks", async () => {
      const world = await fresh();
      try {
        const row = await issue(world);
        expect(labels(await using(world, { fail: ["later"] }, () => rejected(world.mesh.sendInvoice({ id: row.id }, world.ctx))))).toEqual(["laterCheck"]);
        await using(world, { answers: { later: false }, fail: ["later"] }, () => world.mesh.sendInvoice({ id: row.id }, world.ctx));
      } finally { await world.db.close(); }
    });

    test("a condition reading a relationship and a computed field sees their values", async () => {
      const world = await fresh();
      try {
        const row = await issue(world, { amount: 500 });
        await using(world, {}, () => world.mesh.sendInvoice({ id: row.id }, world.ctx));
        expect(world.ctx.calls.find((call) => call.tag === "loaded")!.saw).toEqual({ owner: "Ada", big: true });
      } finally { await world.db.close(); }
    });

    test("a record policy that denies the call rejects it before any condition is evaluated", async () => {
      const world = await fresh();
      try {
        const row = await issue(world, { note: "locked" });
        const error = await using(world, {}, () => rejected(world.mesh.sendInvoice({ id: row.id }, world.ctx)));
        expect((error as Error).name).toBe("ForbiddenError");
        expect(world.ctx.calls).toEqual([]);
      } finally { await world.db.close(); }
    });

    test("`always` blocks over an auto update and over two actions with disjoint inputs guard their checks", async () => {
      const world = await fresh();
      try {
        const row = await issue(world);
        expect(labels(await using(world, { fail: ["auto", "updates"] }, () => rejected(world.mesh.updateInvoice({ id: row.id }, world.ctx))))).toEqual(["autoCheck", "updatesCheck"]);
        expect(labels(await using(world, { fail: ["disjoint"] }, () => rejected(world.mesh.setAmountInvoice({ id: row.id, amount: 3 }, world.ctx))))).toEqual(["disjointCheck"]);
        await using(world, { answers: { disjoint: false }, fail: ["disjoint"] }, () => world.mesh.setNoteInvoice({ id: row.id, note: "y" }, world.ctx));
        expect(count(world, "disjoint")).toBe(1);
      } finally { await world.db.close(); }
    });
  });

  describe("a condition reading a rollup", () => {
    test("sees the counted value: at 0 the checks under it are skipped, at 1 they run", async () => {
      const world = await fresh();
      try {
        await using(world, { fail: ["counted"] }, () => world.mesh.renamePerson({ id: world.ada.id, name: "Ada L" }, world.ctx));
        expect(world.ctx.calls).toEqual([{ tag: "counted", saw: 0 }]);
        await issue(world);
        const error = await using(world, { fail: ["counted"] }, () => rejected(world.mesh.renamePerson({ id: world.ada.id, name: "Ada K" }, world.ctx)));
        expect(labels(error)).toEqual(["countedCheck"]);
        expect(world.ctx.calls).toEqual([{ tag: "counted", saw: 1 }]);
      } finally { await world.db.close(); }
    });
  });

  describe("a destroy", () => {
    test("the `always` block's group and the destroy's own run on the stored row; false skips and the row is deleted", async () => {
      const world = await fresh();
      try {
        const row = await issue(world, { amount: 4 });
        expect(labels(await using(world, { fail: ["always", "drop"] }, () => rejected(world.mesh.dropInvoice({ id: row.id }, world.ctx))))).toEqual(["alwaysCheck", "dropCheck"]);
        expect(world.ctx.calls.find((call) => call.tag === "drop")!.saw).toEqual({ amount: 4 });
        expect(await world.mesh.readInvoice({}, world.ctx)).toHaveLength(1);
        await using(world, { answers: { always: null, drop: false }, fail: ["always", "drop"] }, () => world.mesh.dropInvoice({ id: row.id }, world.ctx));
        expect(tags(world)).toEqual(["always", "drop"]);
        expect(await world.mesh.readInvoice({}, world.ctx)).toEqual([]);
      } finally { await world.db.close(); }
    });
  });
}
