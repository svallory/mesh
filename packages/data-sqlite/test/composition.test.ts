// M5, part 2: action composition (ADR-0068, CMP-16, TXN-16). A domain whose functions call other actions through the
// entity values they import, each with the context it passes, read through `privileged`, run after the row is written
// (`run [after=:write]`) and open an application transaction, built, generated, pushed to SQLite and called through the
// generated functions. Account and Entry import each other.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { ModelDocument } from "@meshfw/model";
import { buildModel, generateFiles, writeGeneratedFiles, type ResolvedConfig } from "@meshfw/compiler";
import { openPolicies } from "./open-policy.ts";
import { FrameworkError, InvalidInputError, Mesh, NotFoundError, type DataOperations } from "@meshfw/runtime";
import build from "../src/build.ts";
import { callsOf } from "./calls.ts";
import { createSchema, sqlite } from "../src/index.ts";

/** `Mesh.privileged` over an entity value this test takes untyped from the generated barrel: its reads, untyped too. */
const privilegedOf = (entity: unknown): any => Mesh.privileged(entity as never);

const account = `import { Entry } from "./entry.mesh.mx"
import { Audit } from "./audit.mesh.mx"
import { auditInTransaction, directDeposit, later } from "./helpers"
import { Mesh } from "meshfw"
entity :Account table="accounts"
  attributes
    integer :id primary-key
    string :name min=1
    integer :balance default=0
    boolean :closed default=false
    json :meta
  relationships
    has-many :entries entity=Entry inverse=:account
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
        run [after=:write] ({ self, context }) {
          context.log.push(\`after the write: id \${self.id}\`);
          await Audit.log({ what: \`opened \${self.id}\` }, context);
        }
    create :openFull
      input
        &name
        boolean :failLast
      do
        run [after=:write] ({ self, context }) {
          await Entry.post({ account: self.id, amount: 10, note: "opening" }, context);
        }
        run [after=:write] ({ self, context }) {
          await Audit.log({ what: \`opened \${self.name} in full\` }, context);
        }
        run [after=:write] ({ input }) {
          if (input.failLast) throw new Error("the last step failed");
        }
    create :openFor
      input
        &name
        string :auditor
      do
        run [after=:write] ({ self, input, context }) {
          await Audit.log({ what: \`opened \${self.name}\` }, context);
          await Audit.log({ what: \`opened \${self.name} for \${input.auditor}\` }, { actor: { id: input.auditor }, log: context.log });
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
        run({ input, context }) {
          try {
            if (input.phase === "cast") await Account.deposit({ id: input.target ?? 0, amount: "ten" as unknown as number }, context);
            if (input.phase === "validate") await Account.deposit({ id: input.target ?? 0, amount: -1 }, context);
            if (input.phase === "run") await Audit.fail({ what: "refused" }, context);
            if (input.phase === "missing") await Account.deposit({ id: 987654, amount: 1 }, context);
            if (input.phase === "read") await Mesh.privileged(Account).read({ limit: -1 });
            if (input.phase === "deep") await Audit.relay({ what: "deep" }, context);
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
        run [after=:write] ({ input, context }) {
          await Account.deposit({ id: input.to, amount: input.amount }, context);
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
        run({ input, context }) {
          if (input.how === "privileged") { const [row] = await Mesh.privileged(Account).read({}); (row as any).name = "changed through privileged"; }
          if (input.how === "result") { const audit = await Audit.log({ what: "meddled" }, context); (audit as any).what = "changed"; }
          if (input.how === "other") { const [row] = await Mesh.privileged(Audit).read({}); (row as any).what = "changed through privileged"; }
        }
    update :stash
      do
        run({ context }) {
          context.stash = later(() => Audit.log({ what: "late" }, context));
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
        run [after=:write] ({ self, context }) {
          await Account.rename({ id: self.id, name: \`\${self.name} (renamed)\` }, context);
        }
    update :rename
      input
        &name
    update :renameAfter
      input
        string :newName
      do
        run [after=:write] ({ self, input, context }) {
          await Account.rename({ id: self.id, name: input.newName }, context);
        }
    update :renameBefore
      input
        string :newName
        integer :other nullable
      do
        set
          &balance=({}) => &balance + 1
        run({ self, input, context }) {
          await Account.rename({ id: input.other ?? self.id, name: input.newName }, context);
        }
    update :depositTwice
      do
        run [after=:write] ({ self, context }) {
          await Promise.all([Account.deposit({ id: self.id, amount: 1 }, context), Account.deposit({ id: self.id, amount: 1 }, context)]);
        }
    create :failThenTally
      input
        &name
      do
        run({ context }) {
          try { await Audit.fail({ what: "first" }, context); } catch { context.log.push("caught the failure"); }
          for (const call of [{ what: "after" }, { what: 5 as unknown as string }]) {
            try { await Audit.tally(call, context); context.log.push("not refused"); }
            catch (error) { context.log.push(\`refused: \${(error as Error).constructor.name}, cause \${((error as Error).cause as Error | undefined)?.message}\`); }
          }
        }
    destroy :close
      do
        run [after=:write] ({ self, context }) {
          const left = await Mesh.privileged(Account).read({ filter: { id: { eq: self.id } } });
          await Audit.log({ what: \`closed \${self.name} with \${self.balance}, \${left.length} left\` }, context);
        }
`;

const entry = `import { Account } from "./account.mesh.mx"
import { Audit } from "./audit.mesh.mx"
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
        run [after=:write] ({ self, context }) {
          await Audit.log({ what: \`posted \${self.amount}\` }, context);
        }
`;

const audit = `import { peek, peekLater } from "./peek"

import { Mesh } from "meshfw"
entity :Audit table="audits"
  attributes
    integer :id primary-key
    string :what
    string :by nullable
  computed
    boolean :peeked() { return peek() }
    boolean :peekedLater() { return peekLater(&id) }
  actions auto=[:read]
    create :log
      input
        &what
      do
        set
          &by=({ actor }) => actor?.id ?? null
        run [after=:write] ({ self, context }) {
          const rows = await Mesh.privileged(Audit).read({ filter: { id: { eq: self.id } } });
          context.log?.push(\`audit "\${self.what}" by \${self.by ?? "nobody"}; privileged sees \${rows.length}\`);
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
        run({ context }) {
          try { await Audit.fail({ what: "inner" }, context); } catch { context.log.push("relay caught the inner failure"); }
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
const doc = `import { Audit } from "./audit.mesh.mx"

entity :Doc table="docs"
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
    json :meta
  actions auto=[:read]
    always types=[:update]
      do
        run({ self, context }) {
          await Audit.log({ what: \`touching doc \${self.id}\` }, context);
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
        run({ input, context }) {
          await Doc.bump({ id: input.other }, context);
        }
`;

/**
 * A helper module the entity file imports, as an application's would: it calls entity values, reads through
 * \`privileged\` and opens an application transaction from inside a \`run\`, each on the binding in scope. The calls are
 * typed by hand and made with no context on purpose, so the project still type-checks when its context declaration has a
 * required key. The entity values are read inside the functions: this module loads while the barrel that defines
 * \`Account\` is still loading.
 */
const helpers = `import { Account, Audit } from "../../.mesh/domain/index.ts";
import { Mesh } from "@meshfw/runtime";
import { transaction } from "../../.mesh/index.ts";
type Deposit = (input: { id: number; amount: number }) => Promise<unknown>;
type Log = (input: { what: string }) => Promise<unknown>;
/** An entity value called directly, as an application imports it from \`#mesh/domain\`. */
export async function directDeposit(id: number, amount: unknown): Promise<void> {
  await (Account.deposit as Deposit)({ id, amount: amount as number });
}
/** Run \`fn\` a little later, in the async context of the caller: a call the caller does not await. */
export function later<T>(fn: () => Promise<T>): Promise<T> {
  return new Promise((resolve) => setTimeout(resolve, 20)).then(fn);
}
export async function auditInTransaction(what: string): Promise<number> {
  return transaction(async () => {
    await (Audit.log as Log)({ what });
    return (await Mesh.privileged(Audit).read({})).length;
  });
}
`;

/** \`Audit\`'s computed field calls this: the privileged read it makes is refused while the field is evaluated (TXN-18). */
const peek = `import { Audit } from "../../.mesh/domain/index.ts";
import { Mesh } from "@meshfw/runtime";
export function peek(): boolean {
  void Mesh.privileged(Audit);
  return true;
}
/**
 * An async helper typed as synchronous, which the build cannot see through: it awaits, then calls \`privileged\`, so the
 * field that returns its result would hold a promise. Given the record, the field's body is plain code, which \`expr.pure\`
 * does not guard. Called while the field is evaluated in a frame, its late call still
 * throws; the load refuses the promise and drops that rejection.
 */
export const peekLater = (async (id: number) => {
  await Promise.resolve();
  return Mesh.privileged(Audit) !== undefined && id > 0;
}) as unknown as (id: number) => boolean;
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
  await Bun.write(join(dir, "src/domain/peek.ts"), peek);
  const built = buildModel({ root: dir, domainRoot: join(dir, "src/domain"), files: openPolicies(Object.entries(sources).map(([name, source]) => ({ file: `src/domain/${name}.mesh.mx`, source }))) });
  expect(built.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
  await writeGeneratedFiles(await generateFiles({ config, document: built.document as ModelDocument }, build), config);
  // `binding.ts` imports the project's config, which is not part of this fixture.
  await Bun.write(join(dir, "mesh.config.ts"), "export default { data: { name: 'sqlite', transaction: async () => undefined, close: async () => undefined } };\n");
  // The project declares the context keys its functions pass (ADR-0059): against the bare `ActionContext`, which holds only
  // the reserved `system`, `{ actor, log }` would be excess properties.
  await Bun.write(join(dir, "project-context.ts"), 'import "@meshfw/runtime";\ndeclare module "@meshfw/runtime" {\n  interface ActionContext {\n    actor: { id: string };\n    log: string[];\n    stash?: unknown;\n  }\n}\nexport {};\n');
  return dir;
}

/**
 * Type-check the generated files, and `extra`, under the strictest flags a consuming project might use. The project's
 * context declaration comes along unless `extra` brings its own (`context.ts`).
 */
async function typeCheck(dir: string, extra: string[] = []): Promise<string> {
  const files = (await readdir(join(dir, ".mesh"), { recursive: true })).filter((name) => name.endsWith(".ts")).map((name) => join(".mesh", name));
  if (!extra.includes("context.ts")) extra = ["project-context.ts", ...extra];
  const child = Bun.spawnSync([
    resolve(import.meta.dir, "../../../node_modules/.bin/tsc"), "--ignoreConfig", "--noEmit", "--strict", "--noUncheckedIndexedAccess",
    "--module", "esnext", "--moduleResolution", "bundler", "--target", "es2022", "--skipLibCheck", "--noUnusedLocals", "--noUnusedParameters",
    "--exactOptionalPropertyTypes", "--verbatimModuleSyntax", "--isolatedModules", "--allowImportingTsExtensions", "mesh.config.ts", ...extra, ...files,
  ], { cwd: dir });
  return child.stdout.toString() + child.stderr.toString();
}

let dir: string;
let app: any;
let domain: object;
/** The project's entity values, as the application imports them from `#mesh/domain`. */
let Account: any, Audit: any;
beforeAll(async () => {
  dir = await generate(".composition-", { account, entry, audit });
  app = await import(join(dir, ".mesh/index.ts"));
  domain = await import(join(dir, ".mesh/domain/index.ts"));
  ({ Account, Audit } = domain as any);
});
afterAll(async () => { if (dir) await rm(dir, { recursive: true, force: true }); });

const alice = { id: "alice" };

async function fresh() {
  const db = sqlite({ file: ":memory:" });
  await createSchema(db, app.tables);
  const log: string[] = [];
  const ctx: { actor: { id: string }; log: string[]; stash?: any } = { actor: alice, log };
  const mesh = callsOf(app.bind(db), domain);
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
  test("type-check under the strictest flags, with the entity values an entity file imports and `privileged`", async () => {
    expect(await typeCheck(dir)).toBe("");
  }, 30_000);

  test("type-check when the project's context has a required key: every call passes one, in a step and in the application's transaction", async () => {
    await Bun.write(join(dir, "context.ts"), 'import "@meshfw/runtime";\ndeclare module "@meshfw/runtime" {\n  interface ActionContext {\n    actor: { id: string };\n    log: string[];\n    stash?: unknown;\n  }\n}\nexport {};\n');
    await Bun.write(join(dir, "check-context.ts"), [
      'import { Account } from "./.mesh/domain/index.ts";',
      'import { Mesh } from "@meshfw/runtime";',
      'import { bind } from "./.mesh/index.ts";',
      "const mesh = bind(null as never);",
      "export async function calls(): Promise<void> {",
      "  // @ts-expect-error a top-level call needs the context",
      '  await Account.open({ name: "x" });',
      '  await mesh.run(() => Account.open({ name: "x" }, { actor: { id: "a" }, log: [] }));',
      '  await mesh.transaction(async () => { await Account.open({ name: "x" }, { actor: { id: "a" }, log: [] }); });',
      "  // @ts-expect-error inside the application's transaction too: nothing carries a context to the calls",
      '  await mesh.transaction(async () => { await Account.open({ name: "x" }); });',
      "  // A privileged read takes a context only for what it loads, and may leave it out.",
      '  await mesh.transaction(async () => { await Mesh.privileged(Account).read({}); });',
      "}",
      "",
    ].join("\n"));
    try {
      expect(await typeCheck(dir, ["context.ts", "check-context.ts"])).toBe("");
    } finally {
      await rm(join(dir, "context.ts"));
      await rm(join(dir, "check-context.ts"));
    }
  }, 30_000);

  test("`input`, related records, `before` and what entity calls and `privileged` return in an entity file are deep read-only; inputs are checked", async () => {
    await Bun.write(join(dir, "check-types.ts"), [
      'import { cloneValue } from "@meshfw/runtime";',
      'import type { $Account$StoredScope as AccountStoredScope } from "./.mesh/domain/account.expressions.ts";',
      'import type { DepositAccountInput } from "./.mesh/domain/account.types.ts";',
      'import type { $Entry$Scope as EntryScope } from "./.mesh/domain/entry.expressions.ts";',
      'import type { PostEntryInput } from "./.mesh/domain/entry.types.ts";',
      'import type { $ReadOnly as AccountView } from "./.mesh/domain/account.actions.ts";',
      'import type { $ReadOnly as EntryView } from "./.mesh/domain/entry.actions.ts";',
      'import { Account } from "./.mesh/domain/index.ts";',
      'import { Mesh } from "@meshfw/runtime";',
      'import { bind } from "./.mesh/index.ts";',
      "declare const s: AccountStoredScope<DepositAccountInput>;",
      "// The entity values as a function of an entity file sees them.",
      "declare const A: AccountView;",
      "declare const E: EntryView;",
      "const context = { actor: { id: 'a' }, log: [] };",
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
      '  await A.deposit({ id: 1, amount: "ten" }, context);',
      "  // @ts-expect-error so is a missing required field",
      "  await E.post({ amount: 1 }, context);",
      "  // @ts-expect-error the record a nested action returns is read-only",
      '  (await A.open({ name: "a" }, context)).name = "b";',
      "  // @ts-expect-error a row read through privileged is read-only",
      '  (await Mesh.privileged(A).read({}))[0]!.name = "b";',
      "  // @ts-expect-error privileged holds the reads only",
      '  await Mesh.privileged(A).open({ name: "a" });',
      "  // @ts-expect-error a privileged read takes the read's input",
      '  await Mesh.privileged(A).read({ limit: "all" });',
      "  // @ts-expect-error the scope holds no `actions` and no `tx` any more",
      "  void s.actions; void s.tx;",
      "  // A copy is the function's own: cloneValue (structuredClone in an entity file) drops read-only.",
      "  const copy = cloneValue(s.self);",
      '  copy.name = "mine";',
      "  copy.entries[0]!.amount = 2;",
      "  // The application's transaction hands out plain records, typed as the entity values return them.",
      "  const mesh = bind(null as never);",
      "  const count: number = await mesh.transaction(async () => {",
      '    const opened = await Account.open({ name: "x" }, context);',
      '    opened.name = "plain";',
      '    (await Mesh.privileged(Account).read({}))[0]!.name = "plain";',
      "    return (await Mesh.privileged(Account).read({})).length;",
      "  });",
      "  // @ts-expect-error the calls are typed there too",
      "  await mesh.transaction(async () => Account.open({ name: 1 }, context));",
      "  // @ts-expect-error the function is handed nothing",
      "  await mesh.transaction(async ({ actions }) => actions);",
      "  void count;",
      "}",
      "",
    ].join("\n"));
    expect(await typeCheck(dir, ["check-types.ts"])).toBe("");
  }, 30_000);

  test("an entity call with a wrong input in an entity file is a type error in its generated output", async () => {
    const wrong = await generate(".composition-wrong-", {
      account: account.replace("await Audit.log({ what: `opened ${self.id}` }, context);", "await Audit.log({ what: self.id }, context);"),
      entry, audit,
    });
    try {
      const output = await typeCheck(wrong);
      expect(output).toContain(".mesh/domain/account.expressions.ts");
      expect(output).toMatch(/Type 'number' is not assignable to type 'string'/);
    } finally { await rm(wrong, { recursive: true, force: true }); }
  }, 30_000);
});

describe("after=:write", () => {
  test("a step after the write sees the stored row, with the key the data layer filled; a step before it does not", async () => {
    const world = await fresh();
    try {
      const opened = await world.mesh.openAccount({ name: "Ada" }, world.ctx);
      expect(opened.id).toBe(1);
      expect(world.log.slice(0, 2)).toEqual(["before the write: id null", "after the write: id 1"]);
      // The step's nested call wrote in the same transaction: the audit carries the key, and its own after-write `privileged` read sees itself.
      expect(world.log[2]).toBe('audit "opened 1" by alice; privileged sees 1');
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

  test("on a destroy, self after the write is the deleted row as it was, and a read through privileged no longer finds it", async () => {
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

describe("the afterWrite seam (ACT-09)", () => {
  test("is application code: a privileged read and an entity call it makes resolve with plain values, while the action's steps still get read-only ones", async () => {
    const db = sqlite({ file: ":memory:" });
    await createSchema(db, app.tables);
    const seen: string[] = [];
    const log: string[] = [];
    const binding = app.bind(db, {
      seams: {
        afterWrite: async (_db: unknown, { entity, action }: { entity: string; action: string }) => {
          if (!entity.endsWith("Account") || action !== "open") return;
          const rows = await privilegedOf(Audit).read({});
          rows.push({ what: "pushed" });
          const logged = await Audit.log({ what: "from the seam" }, { actor: alice, log });
          logged.what = "changed in place";
          seen.push(`${rows.length} rows, ${logged.what}`);
        },
      },
    });
    try {
      await binding.run(() => Account.open({ name: "Ada" }, { actor: alice, log }));
      // The seam runs before the steps after the write, so no audit is there yet: the one row is the pushed one.
      expect(seen).toEqual(["1 rows, changed in place"]);
      // The audit's own step after its write ran as a step, and saw its row through privileged.
      expect(log).toContain('audit "from the seam" by alice; privileged sees 1');
      // A change made in place is never persisted.
      expect((await binding.run(() => privilegedOf(Audit).read({}))).map((row: { what: string }) => row.what).sort()).toEqual(["from the seam", "opened 1"]);
    } finally { await db.close(); }
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
      // Entry.post's own after-write step logged the first audit: Account.openFull, then Entry.post, then Audit.log, each step passing alice's context on.
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
  test("a nested call gets the context its caller passes: the step's own, or one it makes", async () => {
    const world = await fresh();
    try {
      await world.mesh.openForAccount({ name: "Ada", auditor: "carol" }, world.ctx);
      expect((await rows(world)).audits.map((row: { what: string; by: string }) => [row.what, row.by]))
        .toEqual([["opened Ada", "alice"], ["opened Ada for carol", "carol"]]);
    } finally { await world.db.close(); }
  });
});

describe("a computed field (TXN-18)", () => {
  test("a privileged read made while it is evaluated, even from an imported function, throws and names the field", async () => {
    const world = await fresh();
    try {
      await world.mesh.logAudit({ what: "x" }, world.ctx);
      const error = await failure(world.mesh.readAudit({ load: ["peeked"] }, world.ctx));
      expect(error).toBeInstanceOf(FrameworkError);
      expect((error as Error).message).toStartWith("Mesh.privileged(Audit) was called while computed :peeked of Audit is evaluated");
      // Not loaded, the field's body never runs.
      expect(await world.mesh.readAudit({}, world.ctx)).toHaveLength(1);
    } finally { await world.db.close(); }
  });

  test("so does one made while it is evaluated by the load function, which no binding's frame reaches", async () => {
    const world = await fresh();
    try {
      await world.mesh.logAudit({ what: "x" }, world.ctx);
      const rows = await world.mesh.readAudit({}, world.ctx);
      const binding = app.bind(world.db);
      const loading = binding.run(() => world.db.transaction((tx: DataOperations) => (domain as any).loadAuditFields(tx, rows, ["peeked"])));
      const error = await failure(loading);
      expect(error).toBeInstanceOf(FrameworkError);
      expect((error as Error).message).toStartWith("Mesh.privileged(Audit) was called while computed :peeked of Audit is evaluated");
    } finally { await world.db.close(); }
  });

  const returnedAPromise = "computed :peekedLater of Audit returned a promise: a computed field is synchronous, and reads only its record and what it loads.";
  test("one whose body returns a promise is refused, naming the field, and the promise's own failure is dropped", async () => {
    const world = await fresh();
    try {
      await world.mesh.logAudit({ what: "x" }, world.ctx);
      const error = await failure(world.mesh.readAudit({ load: ["peekedLater"] }, world.ctx));
      expect(error).toBeInstanceOf(FrameworkError);
      expect((error as Error).message).toStartWith(returnedAPromise);
      // The late `privileged` call made by the helper, still in the field's frame, rejects its promise: let it settle.
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(await world.mesh.readAudit({}, world.ctx)).toHaveLength(1);
    } finally { await world.db.close(); }
  });

  test("so is one the load function evaluates with no binding's frame", async () => {
    const world = await fresh();
    try {
      await world.mesh.logAudit({ what: "x" }, world.ctx);
      const rows = await world.mesh.readAudit({}, world.ctx);
      const binding = app.bind(world.db);
      const loading = binding.run(() => world.db.transaction((tx: DataOperations) => (domain as any).loadAuditFields(tx, rows, ["peekedLater"])));
      const error = await failure(loading);
      expect(error).toBeInstanceOf(FrameworkError);
      expect((error as Error).message).toStartWith(returnedAPromise);
      // Nothing was attached to the rows the caller passed.
      expect(rows.every((row: object) => !("peekedLater" in row))).toBe(true);
      await new Promise((resolve) => setTimeout(resolve, 10));
    } finally { await world.db.close(); }
  });
});

describe("the application transaction", () => {
  test("returns what its function returns, which need not be a record, and commits every call together", async () => {
    const world = await fresh();
    try {
      const result = await world.mesh.transaction(async () => {
        const a = await Account.open({ name: "Ada", balance: 10 }, world.ctx);
        await Account.deposit({ id: a.id, amount: 5 }, world.ctx);
        // Records handed to the application are plain: changing one changes nothing stored.
        a.name = "changed";
        return { count: (await privilegedOf(Account).read({})).length, label: "done" };
      });
      expect(result).toEqual({ count: 1, label: "done" });
      expect((await rows(world)).accounts).toMatchObject([{ name: "Ada", balance: 15 }]);
    } finally { await world.db.close(); }
  });

  test("nested transaction calls join one transaction: the inner sees the outer's writes, and a later throw rolls back both", async () => {
    const world = await fresh();
    try {
      const error = await failure(world.mesh.transaction(async () => {
        await Account.open({ name: "Ada" }, world.ctx);
        const seen = await world.mesh.transaction(async () => {
          await Account.open({ name: "Bo" }, world.ctx);
          return (await privilegedOf(Account).read({})).length;
        });
        expect(seen).toBe(2);
        throw new Error("after both");
      }));
      expect((error as Error).message).toBe("after both");
      expect(await rows(world)).toEqual({ accounts: [], entries: [], audits: [] });
    } finally { await world.db.close(); }
  });

  test("a failed call it catches fails it all the same", async () => {
    const world = await fresh();
    try {
      const error = await failure(world.mesh.transaction(async () => {
        const a = await Account.open({ name: "Ada" }, world.ctx);
        try { await Account.deposit({ id: a.id, amount: -1 }, world.ctx); } catch { /* caught on purpose */ }
        return "ignored";
      }));
      expect(error).toBeInstanceOf(FrameworkError);
      expect((error as Error).cause).toBeInstanceOf(InvalidInputError);
      expect(await rows(world)).toEqual({ accounts: [], entries: [], audits: [] });
    } finally { await world.db.close(); }
  });

  test("it carries no context: each call gets the one it passes, or none (TXN-20)", async () => {
    const world = await fresh();
    try {
      await world.mesh.transaction(async () => {
        await Audit.log({ what: "carol's" }, { actor: { id: "carol" }, log: world.log });
        await Audit.log({ what: "own" }, { actor: { id: "dave" } });
        await Audit.log({ what: "none" });
      });
      expect((await rows(world)).audits.map((row: { what: string; by: string }) => [row.what, row.by])).toEqual([["carol's", "carol"], ["own", "dave"], ["none", null]]);
    } finally { await world.db.close(); }
  });

  test("called inside a `run`, it joins the action's transaction", async () => {
    const world = await fresh();
    try {
      await world.mesh.openNestedAccount({ name: "Ada", thenFail: false }, world.ctx);
      expect(world.log).toContain("the nested transaction saw 1 audit");
      // The helper's call passes no context, so it has none.
      expect((await rows(world)).audits).toMatchObject([{ what: "nested for Ada", by: null }]);
      const error = await failure(world.mesh.openNestedAccount({ name: "Bo", thenFail: true }, world.ctx));
      expect((error as Error).message).toBe("failed after the nested transaction");
      const after = await rows(world);
      expect(after.accounts.map((row: { name: string }) => row.name)).toEqual(["Ada"]);
      expect(after.audits).toHaveLength(1);
    } finally { await world.db.close(); }
  });

  test("a call left running once its transaction ended is refused, and writes nothing", async () => {
    const world = await fresh();
    const ENDED = "a call was made inside a transaction that has ended: await every entity call and privileged read before the function or the transaction callback returns";
    try {
      // The application's transaction: a call its callback did not await runs after the commit.
      let kept!: Promise<unknown>;
      await world.mesh.transaction(async () => {
        kept = new Promise((resolve) => setTimeout(resolve, 20)).then(() => Account.open({ name: "late" }, world.ctx));
      });
      const late = await failure(kept);
      expect(late).toBeInstanceOf(FrameworkError);
      expect((late as Error).message).toBe(ENDED);
      // An action's step: the same for a call its step did not await, and for a privileged read.
      const opened = await world.mesh.openAccount({ name: "Ada" }, world.ctx);
      await world.mesh.stashAccount({ id: opened.id }, world.ctx);
      const fromRun = await failure(world.ctx.stash);
      expect(fromRun).toBeInstanceOf(FrameworkError);
      expect((fromRun as Error).message).toBe(ENDED);
      let read!: Promise<unknown>;
      await world.mesh.transaction(async () => {
        read = new Promise((resolve) => setTimeout(resolve, 20)).then(() => privilegedOf(Account).read({}));
      });
      expect(((await failure(read)) as Error).message).toBe(ENDED);
      expect((await rows(world)).accounts.map((row: { name: string }) => row.name)).toEqual(["Ada"]);
      expect((await rows(world)).audits.map((row: { what: string }) => row.what)).toEqual(["opened 1"]);
    } finally { await world.db.close(); }
  });
});

describe("changes made in place are never persisted, through composition too (decisions log, 2026-10-11 00:20)", () => {
  for (const how of ["privileged", "other", "result"])
    test(`a record ${how === "result" ? "a nested action returns" : how === "other" ? "of another entity read through privileged" : "read through privileged"} cannot be changed, and the action stores nothing`, async () => {
      const world = await fresh();
      try {
        const opened = await world.mesh.openAccount({ name: "Ada" }, world.ctx);
        const before = await rows(world);
        const error = await failure(world.mesh.meddleAccount({ id: opened.id, how }, world.ctx));
        expect(error).toBeInstanceOf(FrameworkError);
        expect((error as Error).message).toMatch(/^Account\#meddle: a function cannot change the record/);
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
  test("runs its actions; a step's entity call runs on the binding in scope, so inside run() of a binding it writes there", async () => {
    const world = await fresh();
    try {
      const { bindAccount } = await import(join(dir, ".mesh/domain/account.actions.ts"));
      const alone = bindAccount(world.db);
      const from = await world.mesh.openAccount({ name: "Ada", balance: 100 }, world.ctx);
      const to = await world.mesh.openAccount({ name: "Bo" }, world.ctx);
      expect((await alone.deposit({ id: to.id, amount: 1 }, world.ctx)).balance).toBe(1);
      // Outside any run, and not connected, the step's call has nowhere to run: the transfer stores nothing.
      const error = await failure(alone.transfer({ id: from.id, to: to.id, amount: 10 }, world.ctx));
      expect(error).toBeInstanceOf(FrameworkError);
      expect((error as Error).message).toStartWith("Account#deposit was called while not connected");
      expect((await rows(world)).accounts.map((row: { balance: number }) => row.balance)).toEqual([100, 1]);
      // Inside run() of the project's binding on the same layer, it runs there.
      await world.mesh.run(() => alone.transfer({ id: from.id, to: to.id, amount: 10 }, world.ctx));
      expect((await rows(world)).accounts.map((row: { balance: number }) => row.balance)).toEqual([90, 11]);
    } finally { await world.db.close(); }
  });
});

describe("a generated function called directly inside a transaction fails it as a nested call does (decisions log, 2026-10-11 02:45, B1)", () => {
  test("inside the application transaction: a caught cast failure of a direct call rolls everything back", async () => {
    const world = await fresh();
    try {
      const opened = await world.mesh.openAccount({ name: "Ada", balance: 5 }, world.ctx);
      const before = await rows(world);
      const error = await failure(world.mesh.transaction(async () => {
        await world.mesh.openAccount({ name: "kept?" }, world.ctx);
        try { await world.mesh.depositAccount({ id: opened.id, amount: "nope" }, world.ctx); } catch { /* caught on purpose */ }
        return "ignored";
      }));
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
      }));
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
      const other = failure(world.mesh.transaction(async () => {
        await Audit.fail({ what: "the other request's failure" }, world.ctx).catch(() => undefined);
        marked();
        await gate;
      }));
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
  test("two parallel deposits in one transaction add 2", async () => {
    const world = await fresh();
    try {
      const opened = await world.mesh.openAccount({ name: "Ada" }, world.ctx);
      await world.mesh.transaction(async () => {
        await Promise.all([Account.deposit({ id: opened.id, amount: 1 }, world.ctx), Account.deposit({ id: opened.id, amount: 1 }, world.ctx)]);
      });
      // The same, from an action's own step after its write.
      const twice = await world.mesh.depositTwiceAccount({ id: opened.id }, world.ctx);
      expect(twice.balance).toBe(4);
      expect((await rows(world)).accounts).toMatchObject([{ id: opened.id, balance: 4 }]);
    } finally { await world.db.close(); }
  });

  test("Promise.all over calls that call other entities two levels down completes, without a deadlock", async () => {
    const world = await fresh();
    try {
      const opened = await world.mesh.transaction(async () =>
        Promise.all(["Ada", "Bo", "Cy"].map((name) => Account.openFull({ name, failLast: false }, world.ctx))));
      expect(opened.map((row: { name: string }) => row.name)).toEqual(["Ada", "Bo", "Cy"]);
      const { accounts, entries, audits } = await rows(world);
      expect(accounts).toHaveLength(3);
      expect(entries.map((row: { accountId: number }) => row.accountId)).toEqual([1, 2, 3]);
      // Each account's cascade ran whole before the next began.
      expect(audits.map((row: { what: string }) => row.what)).toEqual(["posted 10", "opened Ada in full", "posted 10", "opened Bo in full", "posted 10", "opened Cy in full"]);
    } finally { await world.db.close(); }
  });

  test("a `privileged` read in parallel with a write sees the row as the calls made before it left it", async () => {
    const world = await fresh();
    try {
      const opened = await world.mesh.openAccount({ name: "Ada", balance: 10 }, world.ctx);
      const seen = await world.mesh.transaction(async () => {
        const [first, , second] = await Promise.all([
          privilegedOf(Account).read({}),
          Account.deposit({ id: opened.id, amount: 5 }, world.ctx),
          privilegedOf(Account).read({}),
        ]);
        return [first[0].balance, second[0].balance];
      });
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
      expect((error as Error).message).toMatch(/^Account\#renameBefore: a call made before this action's write changed the row this action is updating \(\{"id":1\}\), so this action's checks and steps decided on a stale row\. /);
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

  test("from a step: after a caught failure, the next calls are refused before their cast and their `run`, and nothing is stored", async () => {
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
        refusals.push(await privilegedOf(Account).read({}).catch((cause: unknown) => cause));
      }));
      expect(refusals.map(refusedBy)).toEqual(["audit refused", "audit refused", "audit refused", "audit refused", "audit refused"]);
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
      const error = await failure(world.mesh.transaction(async () => {
        await Account.open({ name: "kept?" }, world.ctx);
        try { await Audit.fail({ what: "first" }, world.ctx); } catch { /* caught on purpose */ }
        refusal = await world.mesh.transaction(async () => { ran++; await Audit.tally({ what: "nested" }, world.ctx); })
          .catch((cause: unknown) => cause);
      }));
      expect(refusedBy(refusal)).toBe("audit refused");
      expect(ran).toBe(0);
      expect(error).toBeInstanceOf(FrameworkError);
      expect(await rows(world)).toEqual(before);
      // The mark belongs to that transaction: the next one runs and commits.
      world.log.length = 0;
      await world.mesh.transaction(async () => { await Audit.tally({ what: "later" }, world.ctx); });
      expect(world.log).toEqual(["tally ran"]);
      expect((await rows(world)).audits).toHaveLength(before.audits.length + 1);
    } finally { await world.db.close(); }
  });
});

describe("an update that a nested write did not change passes the S3 check, whatever its columns hold (review r2, N9)", () => {
  let docDir: string;
  let docApp: any;
  let docDomain: object;
  beforeAll(async () => {
    docDir = await generate(".composition-doc-", { doc, audit });
    docApp = await import(join(docDir, ".mesh/index.ts"));
    docDomain = await import(join(docDir, ".mesh/domain/index.ts"));
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
    const mesh = callsOf(docApp.bind(db), docDomain);
    try {
      const made = await mesh.makeDoc(values, ctx);
      const other = await mesh.makeDoc({ title: "Other" }, ctx);
      await mesh.bumpDoc({ id: made.id }, ctx);
      await mesh.touchDoc({ id: made.id }, ctx);
      await mesh.pokeDoc({ id: made.id, other: other.id }, ctx);
      const { Doc } = docDomain as any;
      await mesh.transaction(async () => {
        await Doc.bump({ id: made.id }, ctx);
        await Doc.touch({ id: made.id }, ctx);
        await Doc.poke({ id: other.id, other: made.id }, ctx);
      });
      const stored = (await mesh.readDoc({}, ctx)) as any[];
      expect(stored.find((row) => row.id === made.id)).toEqual({ ...made, count: 3 });
      expect(stored.find((row) => row.id === other.id)).toEqual({ ...other, count: 1 });
      // One audit per update, nested ones included: bump, touch, poke and its bump; then bump, touch, poke and its bump.
      expect(await mesh.readAudit({}, ctx)).toHaveLength(8);
    } finally { await db.close(); }
  });
});
