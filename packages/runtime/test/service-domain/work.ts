import { AsyncLocalStorage } from "node:async_hooks";
import {
  DECLARATION, FrameworkError, InvalidInputError, NotFoundError, NO_FRAME, authorizer, castInput, entity, publishEvent, recordWrite, runAction, scope, service, uuidv7,
  type ActionFrame, type BindOptions, type Clock, type DataLayer, type DataOperations, type Declaration, type OperationScope, type OutboxAppend, type PolicySpec,
  type Row, type StandardSchemaV1,
} from "../../src/index.ts";

/**
 * A domain for `service.test.ts`, written as `mesh build` writes one: entity values whose actions cast their input, run
 * their policies through `authorizer`, run their work through `runAction` and the binding's frame (`within`), and record
 * their writes for the seams; and service values made with `service`. What a test varies (a step, a policy check, an
 * operation's body) it sets in `hooks`, and `reset()` clears.
 */

/** The tables: each a handle, as a data adapter's `tables` holds them. */
export const tables = { tasks: { name: "tasks" }, claims: { name: "claims" }, members: { name: "members" } } as const;
type Table = (typeof tables)[keyof typeof tables];

/**
 * An in-memory layer: one transaction at a time, joined by every call made inside it (tracked in async context, as the
 * SQL adapters do), rolled back on a throw; a joined call that fails marks the transaction, so a later joined call is
 * refused and the outermost call rejects even when the failure was caught (rollback-only).
 */
export function memoryLayer() {
  const state = { committed: { tasks: [], claims: [], members: [] } as Record<string, Row[]>, outbox: [] as OutboxAppend[], opened: 0 };
  interface Token { active: boolean; data: Record<string, Row[]>; outbox: OutboxAppend[]; ops: DataOperations; failed?: { cause: unknown } }
  const context = new AsyncLocalStorage<Token>();
  const refusal = (failed: { cause: unknown }) =>
    new FrameworkError("A call joined a transaction that an earlier joined call failed, so it was refused before it ran: the transaction rolls back", { cause: failed.cause });
  const keyOf = (key: object) => (key as { id: unknown }).id;
  const opsOver = (token: Token): DataOperations => {
    const rows = (table: object) => token.data[(table as Table).name]!;
    const refuse = async (): Promise<never> => { throw new Error("not used by these tests"); };
    const byKey = async (table: object, key: object) => { const row = rows(table).find((r) => r.id === keyOf(key)); return row && { ...row }; };
    return {
      insert: async (table, row) => { rows(table).push({ ...row }); return { ...row }; },
      selectByKey: byKey,
      selectByKeyForUpdate: byKey,
      select: async (table) => rows(table).map((row) => ({ ...row })),
      updateByKey: async (table, key, changes) => {
        const row = rows(table).find((r) => r.id === keyOf(key));
        if (!row) return undefined;
        Object.assign(row, changes);
        return { ...row };
      },
      deleteByKey: async (table, key) => {
        const list = rows(table);
        const at = list.findIndex((r) => r.id === keyOf(key));
        if (at >= 0) list.splice(at, 1);
        return at >= 0;
      },
      max: refuse, count: refuse, rollup: refuse,
      appendEvent: async (row) => { token.outbox.push(row); return state.outbox.length + token.outbox.length; },
      deleteOutboxThrough: refuse,
    };
  };
  const layer: DataLayer = {
    refuseIfFailed(): boolean {
      const token = context.getStore();
      if (!token?.active) return false;
      if (token.failed) throw refusal(token.failed);
      return true;
    },
    async transaction<T>(run: (tx: DataOperations) => Promise<T>): Promise<T> {
      const running = context.getStore();
      if (running?.active) {
        if (running.failed) throw refusal(running.failed);
        try { return await run(running.ops); } catch (error) { running.failed ??= { cause: error }; throw error; }
      }
      state.opened++;
      const data = Object.fromEntries(Object.entries(state.committed).map(([name, list]) => [name, list.map((row) => ({ ...row }))]));
      const token: Token = { active: true, data, outbox: [], ops: undefined as unknown as DataOperations };
      token.ops = opsOver(token);
      try {
        const result = await context.run(token, () => run(token.ops));
        if (token.failed) throw new FrameworkError("The transaction was rolled back: a call joined to it failed, even though the failure was caught", { cause: token.failed.cause });
        state.committed = token.data;
        state.outbox.push(...token.outbox);
        return result;
      } finally {
        token.active = false;
      }
    },
    close: async () => {},
    // The domain declares an event, so bind wants the outbox; these tests read `state.outbox` instead.
    readOutbox: async () => ({ rows: [], deletedThrough: 0, highest: state.outbox.length, settled: state.outbox.length }),
  };
  return { layer, state };
}

/** A validator over an object input: each key in `strings` must be a string; anything else passes as it is. */
export function schemaOf(strings: readonly string[] = []): StandardSchemaV1<unknown, Record<string, unknown>> {
  return {
    "~standard": {
      version: 1,
      vendor: "test",
      validate(value: unknown) {
        if (typeof value !== "object" || value === null) return { issues: [{ message: "expected an object" }] };
        const bad = strings.filter((key) => typeof (value as Record<string, unknown>)[key] !== "string");
        if (bad.length) return { issues: bad.map((key) => ({ message: "expected a string", path: [key] })) };
        return { value: value as Record<string, unknown> };
      },
    },
  };
}

type StepArgs = { tx: DataOperations; clock: Clock; input: Record<string, unknown>; context: unknown; row: Row | null };
export const hooks: {
  /** By action label: run inside the action's transaction, after its write, as a `run [after=:write]` step. */
  steps: Record<string, ((args: StepArgs) => unknown) | undefined>;
  /** By action label: the check of the action's one policy (record: false). */
  policies: Record<string, ((scope: unknown) => unknown) | undefined>;
  /** By operation label: the body. */
  bodies: Record<string, ((scope: OperationScope<Record<string, unknown>>) => unknown) | undefined>;
  /** `work.Work#handOver`'s checks: `actorOnly` before the transaction, `deep` (record: true) inside it. */
  actorOnly?: (scope: OperationScope<Record<string, unknown>>) => unknown;
  deep?: (scope: OperationScope<Record<string, unknown>>) => unknown;
  /** Evaluated as Task's computed field `marked` while a read loads it. */
  computed?: () => unknown;
} = { steps: {}, policies: {}, bodies: {} };

export function reset(): void {
  hooks.steps = {};
  hooks.policies = {};
  hooks.bodies = {};
  delete hooks.actorOnly;
  delete hooks.deep;
  delete hooks.computed;
}

/** An event class shaped as `mesh build` generates one. */
export class TaskCreated {
  readonly #brand = true;
  static readonly [DECLARATION]: Declaration<TaskCreated> = {
    kind: "event",
    fqn: "work.TaskCreated",
    is: (value: unknown): value is TaskCreated => typeof value === "object" && value !== null && #brand in value,
  };
  constructor() { Object.freeze(this); }
}

type Kind = "create" | "update" | "destroy";

function writeAction(fqn: string, table: Table, action: string, kind: Kind, layer: DataLayer, options: BindOptions, frame: ActionFrame) {
  const label = `${fqn}#${action}`;
  return async (input: unknown, ...[context]: [context?: Record<string, unknown>]): Promise<Row | null> => {
    const parsed = await castInput(layer, schemaOf(kind === "create" ? [] : ["id"]), input);
    const clock = frame.clock(options.clock);
    const given = context ?? {};
    const s = () => scope({ input: parsed, actor: given.actor, context: given }, { clock });
    const policy: PolicySpec = { name: "open", when: null, checks: [{ kind: "authorize-if", check: "() => true", record: false, run: (scoped) => (hooks.policies[label] ?? (() => true))(scoped) }] };
    const policies = authorizer(fqn, action, [policy]);
    await policies.before(layer, s());
    const target = { entity: fqn, action };
    return runAction(layer, options.seams, target, parsed, context, (tx) => frame.within(tx, clock, label, async () => {
      await policies.inside(s());
      if (parsed.fail === true) throw new InvalidInputError([{ path: [], message: `${label} failed its check`, label: null, code: "check", source: null, details: null }]);
      let row: Row | null;
      if (kind === "create") {
        const { fail: _fail, publish: _publish, ...fields } = parsed;
        row = await tx.insert(table, { id: uuidv7(), ...fields });
        await recordWrite(tx, options.seams, target, null, row, parsed, context);
      } else {
        const key = { id: parsed.id };
        const before = await tx.selectByKeyForUpdate(table, key);
        if (!before) throw new NotFoundError(fqn, key);
        if (kind === "update") {
          const { id: _id, fail: _fail, ...changes } = parsed;
          row = (await tx.updateByKey(table, key, changes))!;
        } else {
          await tx.deleteByKey(table, key);
          row = null;
        }
        await recordWrite(tx, options.seams, target, before, row, parsed, context);
      }
      if (parsed.publish === true) await frame.plain(() => publishEvent(tx, undefined, { ...target, key: { id: row!.id }, at: "work/task.mesh.mx:1:1" }, new TaskCreated(), context, clock));
      await hooks.steps[label]?.({ tx, clock, input: parsed, context, row });
      return row;
    }));
  };
}

/** A read body, as `bind<Entity>Reads` makes one: `load: ["claims"]` loads every claim through the transaction, as `loadRows` does. */
function readBody(fqn: string, table: Table, layer: DataLayer, frame: ActionFrame) {
  return async (input: unknown, _context?: unknown, clock?: Clock, _policies?: boolean): Promise<Row[]> => {
    const parsed = (input ?? {}) as { load?: string[] };
    return layer.transaction(async (tx) => {
      const rows = await tx.select(table);
      const claims = parsed.load?.includes("claims") ? await tx.select(tables.claims) : undefined;
      const computed = hooks.computed && fqn === "work.Task" ? frame.marked(`computed :lapsed of ${fqn}`, hooks.computed) : undefined;
      return rows.map((row) => ({ ...row, ...(claims ? { claims } : {}), ...(computed !== undefined ? { computed } : {}), at: clock?.() ?? null }));
    });
  };
}

function makeEntity<A extends string>(fqn: string, table: Table, writes: Record<A, Kind>) {
  const reads = (layer: DataLayer, _options: BindOptions, frame: ActionFrame = NO_FRAME) => Object.freeze({ read: readBody(fqn, table, layer, frame) });
  return entity(
    fqn,
    (layer, options, frame = NO_FRAME) => {
      const body = reads(layer, options, frame).read;
      const bound: Record<string, unknown> = {
        async read(input: unknown, ...[context]: [context?: Record<string, unknown>]) {
          const parsed = await castInput(layer, schemaOf(), input ?? {});
          const clock = frame.clock(options.clock);
          const policy: PolicySpec = { name: "open", when: null, checks: [{ kind: "authorize-if", check: "() => true", record: false, run: () => true }] };
          if (!(await authorizer(fqn, "read", [policy], frame).filter(layer, scope({ input: parsed, actor: context?.actor, context: context ?? {} }, { clock })))) return [];
          return body(parsed, context, clock, true);
        },
      };
      for (const [action, kind] of Object.entries(writes) as [string, Kind][]) bound[action] = writeAction(fqn, table, action, kind, layer, options, frame);
      return Object.freeze(bound);
    },
    reads,
    (call) => {
      const methods: Record<string, (input: unknown, ...context: [context?: object]) => Promise<never>> = {
        read: (input, ...context) => call("read", input, context),
      };
      for (const action of Object.keys(writes)) methods[action] = (input, ...context) => call(action, input, context);
      return methods as Record<A | "read", (input: Record<string, unknown>, ...context: [context?: object]) => Promise<any>>;
    },
  );
}

export const Task = makeEntity("work.Task", tables.tasks, { create: "create", complete: "update", destroy: "destroy" });
export const Claim = makeEntity("work.Claim", tables.claims, { create: "create", end: "update" });
export const Member = makeEntity("work.Member", tables.members, { create: "create" });

const open: PolicySpec = { name: "open", when: null, checks: [{ kind: "authorize-if", check: "() => true", record: false, run: () => true }] };
const body = (label: string) => (s: OperationScope<never>) => (hooks.bodies[label] ?? (() => undefined))(s as OperationScope<Record<string, unknown>>);

type Method = (input: Record<string, unknown>, ...context: [context?: object]) => Promise<any>;

export const Work = service("work.Work", {
  handOver: {
    schema: schemaOf(["task"]),
    policies: [
      { name: "members", when: null, checks: [{ kind: "authorize-if", check: "({ actor }) => actor != null", record: false, run: (s) => (hooks.actorOnly ?? (() => true))(s as never) }] },
      { name: "deep", when: null, checks: [{ kind: "authorize-if", check: "() => isMember()", record: true, run: (s) => (hooks.deep ?? (() => true))(s as never) }] },
    ],
    uses: { "work.Task": ["create", "complete", "read"], "work.Claim": ["read"] },
    body: body("work.Work#handOver"),
  },
  uncovered: { schema: schemaOf(), policies: [], uses: { "work.Task": ["read"] }, body: body("work.Work#uncovered") },
  toString: { schema: schemaOf(), policies: [open], uses: { "work.Task": ["read"] }, body: body("work.Work#toString") },
}, (call): { handOver: Method; uncovered: Method; toString: Method } => ({
  handOver: (input, ...context) => call("handOver", input, context),
  uncovered: (input, ...context) => call("uncovered", input, context),
  toString: (input, ...context) => call("toString", input, context),
}));

export const Billing = service("billing.Billing", {
  charge: { schema: schemaOf(), policies: [open], uses: { "work.Claim": ["read", "create"] }, body: body("billing.Billing#charge") },
}, (call): { charge: Method } => ({ charge: (input, ...context) => call("charge", input, context) }));
