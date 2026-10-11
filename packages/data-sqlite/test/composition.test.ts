// M5, part 2: action composition (ADR-0068). A domain whose functions call other actions through `actions`, read through
// `tx`, run after the row is written (`run [after=:write]`) and open an application transaction, built, generated, pushed
// to SQLite and called through the generated functions.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { ModelDocument } from "@meshfw/model";
import { buildModel, generateFiles, writeGeneratedFiles, type ResolvedConfig } from "@meshfw/compiler";
import { FrameworkError, InvalidInputError, NotFoundError } from "@meshfw/runtime";
import build from "../src/build.ts";
import { createSchema, sqlite } from "../src/index.ts";

const account = `import { Entry } from "./entry.mesh.mx"
import { auditInTransaction, directDeposit } from "./helpers"
entity :Account table="accounts"
  attributes
    integer :id primary-key
    string :name min=1
    integer :balance default=0
    boolean :closed default=false
    json :meta nullable
  relationships
    has-many :entries entity=Entry via=:account
  actions auto=[:read]
    create :open
      input
        &name
        &balance
        &meta
      do
        run({ self, context }) {
          context.log.push(\`before the write: id \${self.id}\`);
        }
        run [after=:write] ({ self, context, actions }) {
          context.log.push(\`after the write: id \${self.id}\`);
          await actions.logAudit({ what: \`opened \${self.id}\` });
        }
    create :openFull
      input
        &name
        boolean :failLast
      do
        run [after=:write] ({ self, actions }) {
          await actions.postEntry({ account: self.id, amount: 10, note: "opening" });
        }
        run [after=:write] ({ self, actions }) {
          await actions.logAudit({ what: \`opened \${self.name} in full\` });
        }
        run [after=:write] ({ input }) {
          if (input.failLast) throw new Error("the last step failed");
        }
    create :openFor
      input
        &name
        string :auditor
      do
        run [after=:write] ({ self, input, actions, context }) {
          await actions.logAudit({ what: \`opened \${self.name}\` });
          await actions.logAudit({ what: \`opened \${self.name} for \${input.auditor}\` }, { actor: { id: input.auditor }, log: context.log });
        }
    create :openNested
      input
        &name
        boolean :thenFail
      do
        run [after=:write] ({ self, input, context }) {
          const seen = await auditInTransaction(\`nested for \${self.name}\`);
          context.log.push(\`the nested transaction saw \${seen} audit\`);
          if (input.thenFail) throw new Error("failed after the nested transaction");
        }
    create :attempt
      input
        &name
        string :phase
        integer :target nullable
      do
        run({ input, actions, tx, context }) {
          try {
            if (input.phase === "cast") await actions.depositAccount({ id: input.target ?? 0, amount: "ten" as unknown as number });
            if (input.phase === "validate") await actions.depositAccount({ id: input.target ?? 0, amount: -1 });
            if (input.phase === "run") await actions.failAudit({ what: "refused" });
            if (input.phase === "missing") await actions.depositAccount({ id: 987654, amount: 1 });
            if (input.phase === "read") await tx.readAccount({ limit: -1 });
            if (input.phase === "deep") await actions.relayAudit({ what: "deep" });
          } catch (error) {
            context.log.push(\`caught \${(error as Error).constructor.name}\`);
          }
        }
    update :deposit
      input
        integer :amount
      validate
        check :positive that=({ input }) => input.amount > 0 code="amount.positive" message="deposit a positive amount"
      do
        set
          &balance=({ input }) => &balance + input.amount
    update :transfer
      input
        integer :to
        integer :amount
      validate
        check :covered that=({ input }) => &balance >= input.amount code="amount.covered" message="not enough money"
      do
        set
          &balance=({ input }) => &balance - input.amount
        run [after=:write] ({ input, actions }) {
          await actions.depositAccount({ id: input.to, amount: input.amount });
        }
    update :adjust
      input
        integer :by
      do
        set
          &balance=({ input }) => &balance + input.by
        when=({ input }) => input.by > 100
          set
            &closed=true
          run [after=:write] ({ self, context }) {
            context.log.push(\`big: stored balance \${self.balance}, closed \${self.closed}\`);
          }
        when=({ input }) => input.by < 0
          run [after=:write] ({ self, before, context }) {
            context.log.push(\`down from \${before.balance} to \${self.balance}\`);
          }
    update :tag
      input
        string :label
      do
        set
          &meta=({ self, input }) => { const copy: any = structuredClone(self.meta) ?? {}; copy.label = input.label; if (Array.isArray(copy.list)) copy.list.push(input.label); return copy; }
        run({ self, before, context }) {
          const record = structuredClone(self);
          record.name = "changed in a copy";
          const stored: any = structuredClone(before.meta);
          if (stored) stored.label = "changed in a copy";
          context.log.push(\`copied \${record.name}; before still has \${JSON.stringify(before.meta)}\`);
        }
    update :meddle
      input
        string :how
      do
        run({ input, actions, tx }) {
          if (input.how === "tx") { const [row] = await tx.readAccount({}); (row as any).name = "changed through tx"; }
          if (input.how === "result") { const audit = await actions.logAudit({ what: "meddled" }); (audit as any).what = "changed"; }
          if (input.how === "other") { const [row] = await tx.readAudit({}); (row as any).what = "changed through tx"; }
        }
    update :stash
      do
        run({ actions, context }) {
          context.stash = actions;
        }
    create :openDirect
      input
        &name
        integer :target
      do
        run({ input, context }) {
          try { await directDeposit(input.target, "ten"); } catch (error) { context.log.push(\`caught \${(error as Error).constructor.name}\`); }
        }
    create :openRenamed
      input
        &name
      do
        run [after=:write] ({ self, actions }) {
          await actions.renameAccount({ id: self.id, name: \`\${self.name} (renamed)\` });
        }
    update :rename
      input
        &name
    update :renameAfter
      input
        string :newName
      do
        run [after=:write] ({ self, input, actions }) {
          await actions.renameAccount({ id: self.id, name: input.newName });
        }
    update :renameBefore
      input
        string :newName
        integer :other nullable
      do
        set
          &balance=({}) => &balance + 1
        run({ self, input, actions }) {
          await actions.renameAccount({ id: input.other ?? self.id, name: input.newName });
        }
    update :depositTwice
      do
        run [after=:write] ({ self, actions }) {
          await Promise.all([actions.depositAccount({ id: self.id, amount: 1 }), actions.depositAccount({ id: self.id, amount: 1 })]);
        }
    create :failThenTally
      input
        &name
      do
        run({ actions, context }) {
          try { await actions.failAudit({ what: "first" }); } catch { context.log.push("caught the failure"); }
          for (const call of [{ what: "after" }, { what: 5 as unknown as string }]) {
            try { await actions.tallyAudit(call); context.log.push("not refused"); }
            catch (error) { context.log.push(\`refused: \${(error as Error).constructor.name}, cause \${((error as Error).cause as Error | undefined)?.message}\`); }
          }
        }
    destroy :close
      do
        run [after=:write] ({ self, tx, actions }) {
          const left = await tx.readAccount({ filter: { id: { eq: self.id } } });
          await actions.logAudit({ what: \`closed \${self.name} with \${self.balance}, \${left.length} left\` });
        }
`;

const entry = `import { Account } from "./account.mesh.mx"
entity :Entry table="entries"
  attributes
    uuid :id primary-key
    integer :amount
    string :note nullable
  relationships
    belongs-to :account entity=Account
  actions auto=[:read]
    create :post
      input
        &account
        &amount
        &note
      do
        run [after=:write] ({ self, actions }) {
          await actions.logAudit({ what: \`posted \${self.amount}\` });
        }
`;

const audit = `entity :Audit table="audits"
  attributes
    integer :id primary-key
    string :what
    string :by nullable
  actions auto=[:read]
    create :log
      input
        &what
      do
        set
          &by=({ actor }) => actor?.id ?? null
        run [after=:write] ({ self, tx, context }) {
          const rows = await tx.readAudit({ filter: { id: { eq: self.id } } });
          context.log?.push(\`audit "\${self.what}" by \${self.by ?? "nobody"}; tx sees \${rows.length}\`);
        }
    create :fail
      input
        &what
      do
        run() {
          throw new Error("audit refused");
        }
    create :relay
      input
        &what
      do
        run({ actions, context }) {
          try { await actions.failAudit({ what: "inner" }); } catch { context.log.push("relay caught the inner failure"); }
        }
    create :tally
      input
        &what
      do
        run({ context }) {
          context.log.push("tally ran");
        }
`;

/** Every column type, and an `always` step that writes on every update: the S3 re-read must find each row unchanged. */
const doc = `entity :Doc table="docs"
  attributes
    integer :id primary-key
    uuid :ref nullable
    string :title
    integer :count default=0
    float :ratio nullable
    decimal :price nullable
    boolean :flag default=false
    enum :state values=[:draft, :live] nullable
    date :day nullable
    datetime :at nullable
    timestamp :seen nullable
    json :meta nullable
  actions auto=[:read]
    always types=[:update]
      do
        run({ self, actions }) {
          await actions.logAudit({ what: \`touching doc \${self.id}\` });
        }
    create :make
      input
        &title
        &ref
        &ratio
        &price
        &flag
        &state
        &day
        &at
        &seen
        &meta
    update :bump
      do
        set
          &count=({}) => &count + 1
    update :touch
    update :poke
      input
        integer :other
      do
        run({ input, actions }) {
          await actions.bumpDoc({ id: input.other });
        }
`;

/** A helper module the entity file imports: it opens an application transaction from inside a \`run\`. */
const helpers = `type Composition = { readonly actions: { logAudit(input: { what: string }): Promise<unknown> }; readonly tx: { readAudit(input: object): Promise<readonly unknown[]> } };
type Binding = {
  transaction<T>(fn: (composition: Composition) => Promise<T>): Promise<T>;
  depositAccount(input: { id: number; amount: number }): Promise<unknown>;
};
let binding: Binding | undefined;
export function use(given: Binding): void { binding = given; }
/** A generated function called directly, as an application imports it from \`#mesh\`, not through \`actions\`. */
export async function directDeposit(id: number, amount: unknown): Promise<void> {
  if (!binding) throw new Error("no binding");
  await binding.depositAccount({ id, amount: amount as number });
}
export async function auditInTransaction(what: string): Promise<number> {
  if (!binding) throw new Error("no binding");
  return binding.transaction(async ({ actions, tx }) => {
    await actions.logAudit({ what });
    return (await tx.readAudit({})).length;
  });
}
`;

const SQLITE: ResolvedConfig["data"] = {
  kind: "data-adapter", name: "sqlite", build: "@meshfw/data-sqlite/build",
  capabilities: { adapter: "sqlite", capabilities: ["aggregates", "integer-key-fill"] }, options: { file: ":memory:" },
};

/** Build the domain into a temporary project folder and write its generated files. */
async function generate(prefix: string, sources: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(import.meta.dir, prefix));
  const config: ResolvedConfig = { root: dir, configFile: join(dir, "mesh.config.ts"), entityFiles: [], domainRoot: join(dir, "src/domain"), output: join(dir, ".mesh"), data: SQLITE };
  await Bun.write(join(dir, "src/domain/helpers.ts"), helpers);
  const built = buildModel({ root: dir, domainRoot: join(dir, "src/domain"), files: Object.entries(sources).map(([name, source]) => ({ file: `src/domain/${name}.mesh.mx`, source })) });
  expect(built.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
  await writeGeneratedFiles(await generateFiles({ config, document: built.document as ModelDocument }, build), config);
  // `index.ts` imports the project's config, which is not part of this fixture.
  await Bun.write(join(dir, "mesh.config.ts"), "export default { data: { name: 'sqlite', transaction: async () => undefined, close: async () => undefined } };\n");
  return dir;
}

/** Type-check the generated files, and `extra`, under the strictest flags a consuming project might use. */
async function typeCheck(dir: string, extra: string[] = []): Promise<string> {
  const files = (await readdir(join(dir, ".mesh"), { recursive: true })).filter((name) => name.endsWith(".ts")).map((name) => join(".mesh", name));
  const child = Bun.spawnSync([
    resolve(import.meta.dir, "../../../node_modules/.bin/tsc"), "--ignoreConfig", "--noEmit", "--strict", "--noUncheckedIndexedAccess",
    "--module", "esnext", "--moduleResolution", "bundler", "--target", "es2022", "--skipLibCheck", "--noUnusedLocals", "--noUnusedParameters",
    "--exactOptionalPropertyTypes", "--verbatimModuleSyntax", "--isolatedModules", "--allowImportingTsExtensions", "mesh.config.ts", ...extra, ...files,
  ], { cwd: dir });
  return child.stdout.toString() + child.stderr.toString();
}

let dir: string;
let app: any;
let helperModule: { use(binding: unknown): void };
beforeAll(async () => {
  dir = await generate(".composition-", { account, entry, audit });
  app = await import(join(dir, ".mesh/index.ts"));
  helperModule = await import(join(dir, "src/domain/helpers.ts"));
});
afterAll(async () => { if (dir) await rm(dir, { recursive: true, force: true }); });

const alice = { id: "alice" };

async function fresh() {
  const db = sqlite({ file: ":memory:" });
  await createSchema(db, app.tables);
  const log: string[] = [];
  const ctx: { actor: { id: string }; log: string[]; stash?: any } = { actor: alice, log };
  const mesh = app.bind(db);
  helperModule.use(mesh);
  return { db, mesh, ctx, log };
}
type World = Awaited<ReturnType<typeof fresh>>;

async function failure(call: Promise<unknown>): Promise<unknown> {
  try { await call; } catch (error) { return error; }
  throw new Error("expected the call to reject");
}
/** Every row of the three tables, read in a transaction of their own. */
async function rows(world: World) {
  return {
    accounts: await world.mesh.readAccount({}, world.ctx),
    entries: await world.mesh.readEntry({}, world.ctx),
    audits: await world.mesh.readAudit({}, world.ctx),
  };
}

describe("the generated files", () => {
  test("type-check under the strictest flags, with `actions`, `tx` and the composition types", async () => {
    expect(await typeCheck(dir)).toBe("");
  });

  test("type-check when the project's context has a required key: a nested call may still leave it out and carry the caller's", async () => {
    await Bun.write(join(dir, "context.ts"), 'import "@meshfw/runtime";\ndeclare module "@meshfw/runtime" {\n  interface ActionContext {\n    actor: { id: string };\n    log: string[];\n    stash?: unknown;\n  }\n}\nexport {};\n');
    await Bun.write(join(dir, "check-context.ts"), [
      'import { bind } from "./.mesh/index.ts";',
      "const mesh = bind(null as never);",
      "export async function calls(): Promise<void> {",
      "  // @ts-expect-error a top-level call needs the context",
      '  await mesh.openAccount({ name: "x" });',
      '  await mesh.transaction(async ({ actions }) => { await actions.openAccount({ name: "x" }); }, { actor: { id: "a" }, log: [] });',
      "}",
      "",
    ].join("\n"));
    try {
      expect(await typeCheck(dir, ["context.ts", "check-context.ts"])).toBe("");
    } finally {
      await rm(join(dir, "context.ts"));
      await rm(join(dir, "check-context.ts"));
    }
  });

  test("`input`, related records, `before` and what `actions` and `tx` return are deep read-only; inputs are checked", async () => {
    await Bun.write(join(dir, "check-types.ts"), [
      'import { cloneValue } from "@meshfw/runtime";',
      'import type { AccountStoredScope } from "./.mesh/account.expressions.ts";',
      'import type { DepositAccountInput } from "./.mesh/account.types.ts";',
      'import type { EntryScope } from "./.mesh/entry.expressions.ts";',
      'import type { PostEntryInput } from "./.mesh/entry.types.ts";',
      'import { bind, type Actions, type Reads } from "./.mesh/index.ts";',
      "declare const s: AccountStoredScope<DepositAccountInput>;",
      "declare const e: EntryScope<PostEntryInput>;",
      "export async function checks(): Promise<void> {",
      "  // @ts-expect-error input is deep read-only",
      "  s.input.amount = 1;",
      "  // @ts-expect-error a related record is deep read-only",
      '  e.self.account.name = "x";',
      "  // @ts-expect-error a related list is read-only",
      "  s.self.entries.push(e.self);",
      "  // @ts-expect-error a record in a related list is read-only",
      "  s.self.entries[0]!.amount = 1;",
      "  // @ts-expect-error a record two relationships away is read-only",
      '  e.self.account.entries[0]!.note = "x";',
      "  // @ts-expect-error before is read-only",
      "  s.before.balance = 1;",
      "  // @ts-expect-error a wrong input to a nested action is a type error",
      '  await s.actions.depositAccount({ id: 1, amount: "ten" });',
      "  // @ts-expect-error so is a missing required field",
      "  await s.actions.postEntry({ amount: 1 });",
      "  // @ts-expect-error the record a nested action returns is read-only",
      '  (await s.actions.openAccount({ name: "a" })).name = "b";',
      "  // @ts-expect-error a row read through tx is read-only",
      '  (await s.tx.readAccount({}))[0]!.name = "b";',
      "  // @ts-expect-error tx holds the reads only",
      '  await s.tx.openAccount({ name: "a" });',
      "  // @ts-expect-error a tx read takes the read's input",
      '  await s.tx.readAccount({ limit: "all" });',
      "  // A copy is the function's own: cloneValue (structuredClone in an entity file) drops read-only.",
      "  const copy = cloneValue(s.self);",
      '  copy.name = "mine";',
      "  copy.entries[0]!.amount = 2;",
      "  // The application's transaction hands out plain records, typed as the top-level functions return them.",
      "  const mesh = bind(null as never);",
      "  const count: number = await mesh.transaction(async ({ actions, tx }) => {",
      '    const opened = await actions.openAccount({ name: "x" });',
      '    opened.name = "plain";',
      "    return (await tx.readAccount({})).length;",
      "  });",
      "  // @ts-expect-error the application's actions are typed too",
      "  await mesh.transaction(async ({ actions }) => actions.openAccount({ name: 1 }));",
      "  const typed: { readonly actions: Actions; readonly tx: Reads } | undefined = undefined;",
      "  void count; void typed;",
      "}",
      "",
    ].join("\n"));
    expect(await typeCheck(dir, ["check-types.ts"])).toBe("");
  });

  test("a call to `actions` with a wrong input in an entity file is a type error in its generated output", async () => {
    const wrong = await generate(".composition-wrong-", {
      account: account.replace("await actions.logAudit({ what: `opened ${self.id}` });", "await actions.logAudit({ what: self.id });"),
      entry, audit,
    });
    try {
      const output = await typeCheck(wrong);
      expect(output).toContain(".mesh/account.expressions.ts");
      expect(output).toMatch(/Type 'number' is not assignable to type 'string'/);
    } finally { await rm(wrong, { recursive: true, force: true }); }
  });
});

describe("after=:write", () => {
  test("a step after the write sees the stored row, with the key the data layer filled; a step before it does not", async () => {
    const world = await fresh();
    try {
      const opened = await world.mesh.openAccount({ name: "Ada" }, world.ctx);
      expect(opened.id).toBe(1);
      expect(world.log.slice(0, 2)).toEqual(["before the write: id undefined", "after the write: id 1"]);
      // The step's nested call wrote in the same transaction: the audit carries the key, and its own after-write `tx` read sees itself.
      expect(world.log[2]).toBe('audit "opened 1" by alice; tx sees 1');
      expect((await rows(world)).audits).toMatchObject([{ what: "opened 1", by: "alice" }]);
    } finally { await world.db.close(); }
  });

  test("a step under a `when` runs after the write only when its condition held before the write, and sees the stored values", async () => {
    const world = await fresh();
    try {
      const opened = await world.mesh.openAccount({ name: "Ada", balance: 10 }, world.ctx);
      world.log.length = 0;
      await world.mesh.adjustAccount({ id: opened.id, by: 500 }, world.ctx);
      expect(world.log).toEqual(["big: stored balance 510, closed true"]);
      world.log.length = 0;
      await world.mesh.adjustAccount({ id: opened.id, by: -10 }, world.ctx);
      expect(world.log).toEqual(["down from 510 to 500"]);
      world.log.length = 0;
      await world.mesh.adjustAccount({ id: opened.id, by: 1 }, world.ctx);
      expect(world.log).toEqual([]);
    } finally { await world.db.close(); }
  });

  test("on a destroy, self after the write is the deleted row as it was, and a read through tx no longer finds it", async () => {
    const world = await fresh();
    try {
      const opened = await world.mesh.openAccount({ name: "Ada", balance: 7 }, world.ctx);
      await world.mesh.closeAccount({ id: opened.id }, world.ctx);
      const { accounts, audits } = await rows(world);
      expect(accounts).toEqual([]);
      expect(audits.map((row: { what: string }) => row.what)).toEqual(["opened 1", "closed Ada with 7, 0 left"]);
    } finally { await world.db.close(); }
  });
});

describe("a cascade", () => {
  test("writes two other entities, two calls deep, and commits every row together with the caller's", async () => {
    const world = await fresh();
    try {
      const opened = await world.mesh.openFullAccount({ name: "Ada", failLast: false }, world.ctx);
      const { accounts, entries, audits } = await rows(world);
      expect(accounts).toMatchObject([{ id: opened.id, name: "Ada" }]);
      expect(entries).toMatchObject([{ accountId: opened.id, amount: 10, note: "opening" }]);
      // Entry.post's own after-write step logged the first audit: Account.openFull, then Entry.post, then Audit.log, with alice's context throughout.
      expect(audits.map((row: { what: string; by: string }) => [row.what, row.by])).toEqual([["posted 10", "alice"], ["opened Ada in full", "alice"]]);
    } finally { await world.db.close(); }
  });

  test("a throw in its last step leaves none of the rows", async () => {
    const world = await fresh();
    try {
      const error = await failure(world.mesh.openFullAccount({ name: "Ada", failLast: true }, world.ctx));
      expect((error as Error).message).toBe("the last step failed");
      expect(await rows(world)).toEqual({ accounts: [], entries: [], audits: [] });
    } finally { await world.db.close(); }
  });

  test("a nested call into the same entity changes another row of it in the same transaction", async () => {
    const world = await fresh();
    try {
      const from = await world.mesh.openAccount({ name: "Ada", balance: 100 }, world.ctx);
      const to = await world.mesh.openAccount({ name: "Bo" }, world.ctx);
      await world.mesh.transferAccount({ id: from.id, to: to.id, amount: 40 }, world.ctx);
      expect((await rows(world)).accounts.map((row: { balance: number }) => row.balance)).toEqual([60, 40]);
    } finally { await world.db.close(); }
  });

  test("a nested failure the caller does not catch rejects the caller with that error, and nothing is stored", async () => {
    const world = await fresh();
    try {
      const from = await world.mesh.openAccount({ name: "Ada", balance: 100 }, world.ctx);
      const error = await failure(world.mesh.transferAccount({ id: from.id, to: 987654, amount: 40 }, world.ctx));
      expect(error).toBeInstanceOf(NotFoundError);
      expect((await rows(world)).accounts.map((row: { balance: number }) => row.balance)).toEqual([100]);
    } finally { await world.db.close(); }
  });
});

describe("a caught failed call fails the whole transaction", () => {
  // Each phase of the nested action: its cast, its checks, its steps, the data layer, a read's cast, and a failure two calls down.
  const cases: [phase: string, cause: new (...args: never[]) => Error, caught: string | null][] = [
    ["cast", InvalidInputError, "caught InvalidInputError"],
    ["validate", InvalidInputError, "caught InvalidInputError"],
    ["run", Error, "caught Error"],
    ["missing", NotFoundError, "caught NotFoundError"],
    ["read", InvalidInputError, "caught InvalidInputError"],
    ["deep", Error, null],
  ];
  for (const [phase, cause, caught] of cases)
    test(`${phase}: the caller catches it, and its action still rejects with a FrameworkError carrying it; nothing is stored`, async () => {
      const world = await fresh();
      try {
        const target = await world.mesh.openAccount({ name: "Ada", balance: 5 }, world.ctx);
        const before = await rows(world);
        world.log.length = 0;
        const error = await failure(world.mesh.attemptAccount({ name: "Bo", phase, target: target.id }, world.ctx));
        expect(error).toBeInstanceOf(FrameworkError);
        expect((error as Error).message).toContain("the transaction is rolled back even though its callback caught the error");
        expect((error as Error).cause).toBeInstanceOf(cause);
        if (phase === "run" || phase === "deep") expect(((error as Error).cause as Error).message).toBe("audit refused");
        expect(world.log).toEqual(phase === "deep" ? ["relay caught the inner failure"] : [caught!]);
        expect(await rows(world)).toEqual(before);
      } finally { await world.db.close(); }
    });
});

describe("context", () => {
  test("a nested call carries the caller's context, and one that passes its own gets that one", async () => {
    const world = await fresh();
    try {
      await world.mesh.openForAccount({ name: "Ada", auditor: "carol" }, world.ctx);
      expect((await rows(world)).audits.map((row: { what: string; by: string }) => [row.what, row.by]))
        .toEqual([["opened Ada", "alice"], ["opened Ada for carol", "carol"]]);
    } finally { await world.db.close(); }
  });
});

describe("the application transaction", () => {
  test("returns what its function returns, which need not be a record, and commits every call together", async () => {
    const world = await fresh();
    try {
      const result = await world.mesh.transaction(async ({ actions, tx }: any) => {
        const a = await actions.openAccount({ name: "Ada", balance: 10 });
        await actions.depositAccount({ id: a.id, amount: 5 });
        // Records handed to the application are plain: changing one changes nothing stored.
        a.name = "changed";
        return { count: (await tx.readAccount({})).length, label: "done" };
      }, world.ctx);
      expect(result).toEqual({ count: 1, label: "done" });
      expect((await rows(world)).accounts).toMatchObject([{ name: "Ada", balance: 15 }]);
    } finally { await world.db.close(); }
  });

  test("nested transaction calls join one transaction: the inner sees the outer's writes, and a later throw rolls back both", async () => {
    const world = await fresh();
    try {
      const error = await failure(world.mesh.transaction(async ({ actions }: any) => {
        await actions.openAccount({ name: "Ada" });
        const seen = await world.mesh.transaction(async ({ actions: inner, tx }: any) => {
          await inner.openAccount({ name: "Bo" });
          return (await tx.readAccount({})).length;
        }, world.ctx);
        expect(seen).toBe(2);
        throw new Error("after both");
      }, world.ctx));
      expect((error as Error).message).toBe("after both");
      expect(await rows(world)).toEqual({ accounts: [], entries: [], audits: [] });
    } finally { await world.db.close(); }
  });

  test("a failed call it catches fails it all the same", async () => {
    const world = await fresh();
    try {
      const error = await failure(world.mesh.transaction(async ({ actions }: any) => {
        const a = await actions.openAccount({ name: "Ada" });
        try { await actions.depositAccount({ id: a.id, amount: -1 }); } catch { /* caught on purpose */ }
        return "ignored";
      }, world.ctx));
      expect(error).toBeInstanceOf(FrameworkError);
      expect((error as Error).cause).toBeInstanceOf(InvalidInputError);
      expect(await rows(world)).toEqual({ accounts: [], entries: [], audits: [] });
    } finally { await world.db.close(); }
  });

  test("it carries its context to every call, unless a call passes its own", async () => {
    const world = await fresh();
    try {
      await world.mesh.transaction(async ({ actions }: any) => {
        await actions.logAudit({ what: "app" });
        await actions.logAudit({ what: "own" }, { actor: { id: "dave" } });
      }, { actor: { id: "carol" }, log: world.log });
      expect((await rows(world)).audits.map((row: { what: string; by: string }) => [row.what, row.by])).toEqual([["app", "carol"], ["own", "dave"]]);
    } finally { await world.db.close(); }
  });

  test("called inside a `run`, it joins the action's transaction", async () => {
    const world = await fresh();
    try {
      await world.mesh.openNestedAccount({ name: "Ada", thenFail: false }, world.ctx);
      expect(world.log).toContain("the nested transaction saw 1 audit");
      // No context was given to the nested transaction, so its call carries none.
      expect((await rows(world)).audits).toMatchObject([{ what: "nested for Ada", by: null }]);
      const error = await failure(world.mesh.openNestedAccount({ name: "Bo", thenFail: true }, world.ctx));
      expect((error as Error).message).toBe("failed after the nested transaction");
      const after = await rows(world);
      expect(after.accounts.map((row: { name: string }) => row.name)).toEqual(["Ada"]);
      expect(after.audits).toHaveLength(1);
    } finally { await world.db.close(); }
  });

  test("`actions` used after their transaction ended are refused, and write nothing", async () => {
    const world = await fresh();
    try {
      let kept: any;
      await world.mesh.transaction(async (composition: any) => { kept = composition; });
      const late = await failure(kept.actions.openAccount({ name: "late" }));
      expect(late).toBeInstanceOf(FrameworkError);
      expect((late as Error).message).toMatch(/bound to the transaction that handed them out, and it has ended/);
      const opened = await world.mesh.openAccount({ name: "Ada" }, world.ctx);
      await world.mesh.stashAccount({ id: opened.id }, world.ctx);
      const fromRun = await failure(world.ctx.stash.logAudit({ what: "late" }));
      expect(fromRun).toBeInstanceOf(FrameworkError);
      expect((await rows(world)).audits.map((row: { what: string }) => row.what)).toEqual(["opened 1"]);
    } finally { await world.db.close(); }
  });
});

describe("changes made in place are never persisted, through composition too (decisions log, 2026-10-11 00:20)", () => {
  for (const how of ["tx", "other", "result"])
    test(`a record ${how === "result" ? "a nested action returns" : how === "other" ? "of another entity read through tx" : "read through tx"} cannot be changed, and the action stores nothing`, async () => {
      const world = await fresh();
      try {
        const opened = await world.mesh.openAccount({ name: "Ada" }, world.ctx);
        const before = await rows(world);
        const error = await failure(world.mesh.meddleAccount({ id: opened.id, how }, world.ctx));
        expect(error).toBeInstanceOf(FrameworkError);
        expect((error as Error).message).toMatch(/^Account\.meddle: a function cannot change the record/);
        expect(await rows(world)).toEqual(before);
      } finally { await world.db.close(); }
    });

  test("structuredClone in a function gives a plain copy the function may change; the stored values change only through set", async () => {
    const world = await fresh();
    try {
      const opened = await world.mesh.openAccount({ name: "Ada", meta: { list: ["a"], nested: { deep: true } } }, world.ctx);
      world.log.length = 0;
      const tagged = await world.mesh.tagAccount({ id: opened.id, label: "b" }, world.ctx);
      expect(tagged.meta).toEqual({ list: ["a", "b"], nested: { deep: true }, label: "b" });
      expect(tagged.name).toBe("Ada");
      expect(world.log).toEqual(['copied changed in a copy; before still has {"list":["a"],"nested":{"deep":true}}']);
    } finally { await world.db.close(); }
  });
});

describe("an entity bound alone", () => {
  test("runs the actions that never compose, and refuses `actions` in one that does, storing nothing", async () => {
    const world = await fresh();
    try {
      const { bindAccount } = await import(join(dir, ".mesh/account.actions.ts"));
      const alone = bindAccount(world.db);
      const from = await world.mesh.openAccount({ name: "Ada", balance: 100 }, world.ctx);
      const to = await world.mesh.openAccount({ name: "Bo" }, world.ctx);
      expect((await alone.deposit({ id: to.id, amount: 1 }, world.ctx)).balance).toBe(1);
      const error = await failure(alone.transfer({ id: from.id, to: to.id, amount: 10 }, world.ctx));
      expect(error).toBeInstanceOf(FrameworkError);
      expect((error as Error).message).toBe("Account.transfer reads `actions.depositAccount`, which only a binding of the whole project has: bind with bind(layer) from #mesh, not with one entity's bind function");
      expect((await rows(world)).accounts.map((row: { balance: number }) => row.balance)).toEqual([100, 1]);
    } finally { await world.db.close(); }
  });
});

describe("a generated function called directly inside a transaction fails it as an `actions` call does (decisions log, 2026-10-11 02:45, B1)", () => {
  test("inside the application transaction: a caught cast failure of a direct call rolls everything back", async () => {
    const world = await fresh();
    try {
      const opened = await world.mesh.openAccount({ name: "Ada", balance: 5 }, world.ctx);
      const before = await rows(world);
      const error = await failure(world.mesh.transaction(async () => {
        await world.mesh.openAccount({ name: "kept?" }, world.ctx);
        try { await world.mesh.depositAccount({ id: opened.id, amount: "nope" }, world.ctx); } catch { /* caught on purpose */ }
        return "ignored";
      }, world.ctx));
      expect(error).toBeInstanceOf(FrameworkError);
      expect((error as Error).cause).toBeInstanceOf(InvalidInputError);
      expect(await rows(world)).toEqual(before);
    } finally { await world.db.close(); }
  });

  test("inside the application transaction: a caught cast failure of a direct read rolls everything back too", async () => {
    const world = await fresh();
    try {
      const error = await failure(world.mesh.transaction(async () => {
        await world.mesh.openAccount({ name: "kept?" }, world.ctx);
        try { await world.mesh.readAccount({ limit: -1 }, world.ctx); } catch { /* caught on purpose */ }
      }, world.ctx));
      expect(error).toBeInstanceOf(FrameworkError);
      expect((error as Error).cause).toBeInstanceOf(InvalidInputError);
      expect(await rows(world)).toEqual({ accounts: [], entries: [], audits: [] });
    } finally { await world.db.close(); }
  });

  test("in a helper called from a `run`: a caught cast failure of a direct call rejects the action, and nothing is stored", async () => {
    const world = await fresh();
    try {
      const opened = await world.mesh.openAccount({ name: "Ada", balance: 5 }, world.ctx);
      const before = await rows(world);
      world.log.length = 0;
      const error = await failure(world.mesh.openDirectAccount({ name: "Bo", target: opened.id }, world.ctx));
      expect(world.log).toContain("caught InvalidInputError");
      expect(error).toBeInstanceOf(FrameworkError);
      expect((error as Error).cause).toBeInstanceOf(InvalidInputError);
      expect(await rows(world)).toEqual(before);
    } finally { await world.db.close(); }
  });

  test("at top level, outside any transaction, a failed cast rejects with the same error as before, and the next call works", async () => {
    const world = await fresh();
    try {
      const opened = await world.mesh.openAccount({ name: "Ada" }, world.ctx);
      const error = await failure(world.mesh.depositAccount({ id: opened.id, amount: "nope" }, world.ctx));
      expect(error).toBeInstanceOf(InvalidInputError);
      expect((error as InvalidInputError).issues[0]!.path).toEqual(["amount"]);
      expect(await failure(world.mesh.readAccount({ limit: -1 }, world.ctx))).toBeInstanceOf(InvalidInputError);
      expect((await world.mesh.depositAccount({ id: opened.id, amount: 2 }, world.ctx)).balance).toBe(2);
    } finally { await world.db.close(); }
  });

  test("at top level, a bad input is rejected at once while another request's failed transaction holds the write lock, and takes no lock (review r2, N7 and F1)", async () => {
    const world = await fresh();
    try {
      const opened = await world.mesh.openAccount({ name: "Ada" }, world.ctx);
      const before = await rows(world);
      let open!: () => void;
      const gate = new Promise<void>((resolve) => { open = resolve; });
      let marked!: () => void;
      const failed = new Promise<void>((resolve) => { marked = resolve; });
      // Another request: its transaction fails on a caught call, then stays open, holding the lock.
      const other = failure(world.mesh.transaction(async ({ actions }: any) => {
        await actions.failAudit({ what: "the other request's failure" }).catch(() => undefined);
        marked();
        await gate;
      }, world.ctx));
      await failed;
      // A bad input outside that transaction gets its own InvalidInputError, without waiting for the lock.
      const outcome = await Promise.race([
        world.mesh.depositAccount({ id: opened.id, amount: "nope" }, world.ctx).then(() => "resolved", (error: unknown) => error),
        Bun.sleep(500).then(() => "waited for the lock"),
      ]);
      // A good call made meanwhile waits its turn and commits once the failed transaction rolled back.
      const good = world.mesh.depositAccount({ id: opened.id, amount: 2 }, world.ctx);
      open();
      const otherError = await other;
      expect(outcome).toBeInstanceOf(InvalidInputError);
      expect((outcome as InvalidInputError).issues[0]!.path).toEqual(["amount"]);
      expect(otherError).toBeInstanceOf(FrameworkError);
      expect(((otherError as Error).cause as Error).message).toBe("audit refused");
      expect((await good).balance).toBe(2);
      expect((await rows(world)).audits).toEqual(before.audits);
    } finally { await world.db.close(); }
  });
});

describe("calls joined to one transaction run one at a time (decisions log, 2026-10-11 02:45, S1)", () => {
  test("two parallel deposits through `actions` in one transaction add 2", async () => {
    const world = await fresh();
    try {
      const opened = await world.mesh.openAccount({ name: "Ada" }, world.ctx);
      await world.mesh.transaction(async ({ actions }: any) => {
        await Promise.all([actions.depositAccount({ id: opened.id, amount: 1 }), actions.depositAccount({ id: opened.id, amount: 1 })]);
      }, world.ctx);
      // The same, from an action's own step after its write.
      const twice = await world.mesh.depositTwiceAccount({ id: opened.id }, world.ctx);
      expect(twice.balance).toBe(4);
      expect((await rows(world)).accounts).toMatchObject([{ id: opened.id, balance: 4 }]);
    } finally { await world.db.close(); }
  });

  test("Promise.all over calls that call `actions` two levels down completes, without a deadlock", async () => {
    const world = await fresh();
    try {
      const opened = await world.mesh.transaction(async ({ actions }: any) =>
        Promise.all(["Ada", "Bo", "Cy"].map((name) => actions.openFullAccount({ name, failLast: false }))), world.ctx);
      expect(opened.map((row: { name: string }) => row.name)).toEqual(["Ada", "Bo", "Cy"]);
      const { accounts, entries, audits } = await rows(world);
      expect(accounts).toHaveLength(3);
      expect(entries.map((row: { accountId: number }) => row.accountId)).toEqual([1, 2, 3]);
      // Each account's cascade ran whole before the next began.
      expect(audits.map((row: { what: string }) => row.what)).toEqual(["posted 10", "opened Ada in full", "posted 10", "opened Bo in full", "posted 10", "opened Cy in full"]);
    } finally { await world.db.close(); }
  });

  test("a `tx` read in parallel with a write sees the row as the calls made before it left it", async () => {
    const world = await fresh();
    try {
      const opened = await world.mesh.openAccount({ name: "Ada", balance: 10 }, world.ctx);
      const seen = await world.mesh.transaction(async ({ actions, tx }: any) => {
        const [first, , second] = await Promise.all([
          tx.readAccount({}),
          actions.depositAccount({ id: opened.id, amount: 5 }),
          tx.readAccount({}),
        ]);
        return [first[0].balance, second[0].balance];
      }, world.ctx);
      expect(seen).toEqual([10, 15]);
      expect((await rows(world)).accounts).toMatchObject([{ balance: 15 }]);
    } finally { await world.db.close(); }
  });
});

describe("an action with a step after its write returns the row as the steps left it (decisions log, 2026-10-11 02:45, S2)", () => {
  test("an update whose after-write step renames its own row returns the new name", async () => {
    const world = await fresh();
    try {
      const opened = await world.mesh.openAccount({ name: "Ada" }, world.ctx);
      const renamed = await world.mesh.renameAfterAccount({ id: opened.id, newName: "Ada Lovelace" }, world.ctx);
      expect(renamed).toMatchObject({ id: opened.id, name: "Ada Lovelace" });
      expect((await rows(world)).accounts).toMatchObject([{ id: opened.id, name: "Ada Lovelace" }]);
    } finally { await world.db.close(); }
  });

  test("a create whose after-write step renames the row it made returns the new name, with the key the data layer filled", async () => {
    const world = await fresh();
    try {
      const opened = await world.mesh.openRenamedAccount({ name: "Ada" }, world.ctx);
      expect(opened).toMatchObject({ id: 1, name: "Ada (renamed)" });
    } finally { await world.db.close(); }
  });
});

describe("a nested write to the caller's own row before the caller's write is a loud error (decisions log, 2026-10-11 02:45, S3)", () => {
  test("an update whose step renames its own row before the write rejects with a FrameworkError naming after=:write, and stores nothing", async () => {
    const world = await fresh();
    try {
      const opened = await world.mesh.openAccount({ name: "Ada", balance: 3 }, world.ctx);
      const before = await rows(world);
      const error = await failure(world.mesh.renameBeforeAccount({ id: opened.id, newName: "lost?" }, world.ctx));
      expect(error).toBeInstanceOf(FrameworkError);
      expect((error as Error).message).toMatch(/^Account\.renameBefore: a call made before this action's write changed the row this action is updating \(\{"id":1\}\), so this action's checks and steps decided on a stale row\. /);
      expect((error as Error).message).toMatch(/run \[after=:write\]$/);
      expect(await rows(world)).toEqual(before);
    } finally { await world.db.close(); }
  });

  test("a step that renames another row of the same entity before the write passes, and both writes are stored", async () => {
    const world = await fresh();
    try {
      const ada = await world.mesh.openAccount({ name: "Ada", balance: 3 }, world.ctx);
      const bo = await world.mesh.openAccount({ name: "Bo" }, world.ctx);
      const result = await world.mesh.renameBeforeAccount({ id: ada.id, newName: "Bo Diddley", other: bo.id }, world.ctx);
      expect(result).toMatchObject({ name: "Ada", balance: 4 });
      expect((await rows(world)).accounts).toMatchObject([{ name: "Ada", balance: 4 }, { name: "Bo Diddley", balance: 0 }]);
    } finally { await world.db.close(); }
  });
});

describe("a call that joins a failed transaction is refused before it does anything (decisions log, N6 ruling)", () => {
  const refusedBy = (refusal: unknown): string | undefined =>
    refusal instanceof FrameworkError ? ((refusal as Error).cause as Error | undefined)?.message : `not refused: ${String(refusal)}`;

  test("through `actions`: after a caught failure, the next calls are refused before their cast and their `run`, and nothing is stored", async () => {
    const world = await fresh();
    try {
      const before = await rows(world);
      world.log.length = 0;
      const error = await failure(world.mesh.failThenTallyAccount({ name: "Ada" }, world.ctx));
      // The second call's input does not cast: it is refused all the same, so the refusal comes before the cast.
      expect(world.log).toEqual(["caught the failure", "refused: FrameworkError, cause audit refused", "refused: FrameworkError, cause audit refused"]);
      expect(world.log).not.toContain("tally ran");
      expect(error).toBeInstanceOf(FrameworkError);
      expect(((error as Error).cause as Error).message).toBe("audit refused");
      expect(await rows(world)).toEqual(before);
    } finally { await world.db.close(); }
  });

  test("a direct call inside the application transaction: refused before its cast and its `run`, and nothing is stored", async () => {
    const world = await fresh();
    try {
      const before = await rows(world);
      world.log.length = 0;
      const refusals: unknown[] = [];
      const error = await failure(world.mesh.transaction(async () => {
        await world.mesh.openAccount({ name: "kept?" }, world.ctx);
        try { await world.mesh.failAudit({ what: "first" }, world.ctx); } catch { /* caught on purpose */ }
        refusals.push(await world.mesh.tallyAudit({ what: "after" }, world.ctx).catch((cause: unknown) => cause));
        refusals.push(await world.mesh.tallyAudit({ what: 5 } as never, world.ctx).catch((cause: unknown) => cause));
        refusals.push(await world.mesh.openAccount({ name: "never" }, world.ctx).catch((cause: unknown) => cause));
        refusals.push(await world.mesh.readAccount({}, world.ctx).catch((cause: unknown) => cause));
      }, world.ctx));
      expect(refusals.map(refusedBy)).toEqual(["audit refused", "audit refused", "audit refused", "audit refused"]);
      expect(world.log).not.toContain("tally ran");
      expect(error).toBeInstanceOf(FrameworkError);
      expect(((error as Error).cause as Error).message).toBe("audit refused");
      expect(await rows(world)).toEqual(before);
    } finally { await world.db.close(); }
  });

  test("a nested `transaction`: refused before its callback runs, and nothing is stored; the next transaction works", async () => {
    const world = await fresh();
    try {
      const before = await rows(world);
      let ran = 0;
      let refusal: unknown;
      const error = await failure(world.mesh.transaction(async ({ actions }: any) => {
        await actions.openAccount({ name: "kept?" });
        try { await actions.failAudit({ what: "first" }); } catch { /* caught on purpose */ }
        refusal = await world.mesh.transaction(async ({ actions: nested }: any) => { ran++; await nested.tallyAudit({ what: "nested" }); }, world.ctx)
          .catch((cause: unknown) => cause);
      }, world.ctx));
      expect(refusedBy(refusal)).toBe("audit refused");
      expect(ran).toBe(0);
      expect(error).toBeInstanceOf(FrameworkError);
      expect(await rows(world)).toEqual(before);
      // The mark belongs to that transaction: the next one runs and commits.
      world.log.length = 0;
      await world.mesh.transaction(async ({ actions }: any) => { await actions.tallyAudit({ what: "later" }); }, world.ctx);
      expect(world.log).toEqual(["tally ran"]);
      expect((await rows(world)).audits).toHaveLength(before.audits.length + 1);
    } finally { await world.db.close(); }
  });
});

describe("an update that a nested write did not change passes the S3 check, whatever its columns hold (review r2, N9)", () => {
  let docDir: string;
  let docApp: any;
  beforeAll(async () => {
    docDir = await generate(".composition-doc-", { doc, audit });
    docApp = await import(join(docDir, ".mesh/index.ts"));
  });
  afterAll(async () => { if (docDir) await rm(docDir, { recursive: true, force: true }); });

  const full = {
    title: "Full", ref: "0190f2c4-1d2e-7a3b-8c4d-5e6f7a8b9c0d", ratio: 0.1 + 0.2, price: 12.34, flag: true, state: "live",
    day: new Date("2026-01-02T00:00:00.000Z"), at: new Date("2026-03-04T05:06:07.089Z"), seen: new Date(1_767_225_600_123),
    meta: { list: [1, null, [2, { deep: null }]], nested: { empty: [], none: null, text: "x" }, top: null },
  };

  test.each([["every column set", full], ["every nullable column null", { title: "Bare" }]] as const)("%s: own steps, an always step that writes, a nested update of another row, joined or not", async (_name, values) => {
    const db = sqlite({ file: ":memory:" });
    await createSchema(db, docApp.tables);
    const ctx = { actor: alice, log: [] as string[] };
    const mesh = docApp.bind(db);
    try {
      const made = await mesh.makeDoc(values, ctx);
      const other = await mesh.makeDoc({ title: "Other" }, ctx);
      await mesh.bumpDoc({ id: made.id }, ctx);
      await mesh.touchDoc({ id: made.id }, ctx);
      await mesh.pokeDoc({ id: made.id, other: other.id }, ctx);
      await mesh.transaction(async ({ actions }: any) => {
        await actions.bumpDoc({ id: made.id });
        await actions.touchDoc({ id: made.id });
        await actions.pokeDoc({ id: other.id, other: made.id });
      }, ctx);
      const stored = (await mesh.readDoc({}, ctx)) as any[];
      expect(stored.find((row) => row.id === made.id)).toEqual({ ...made, count: 3 });
      expect(stored.find((row) => row.id === other.id)).toEqual({ ...other, count: 1 });
      // One audit per update, nested ones included: bump, touch, poke and its bump; then bump, touch, poke and its bump.
      expect(await mesh.readAudit({}, ctx)).toHaveLength(8);
    } finally { await db.close(); }
  });
});
