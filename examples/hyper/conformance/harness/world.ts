/**
 * Test-facing DSL over one running engine: collaborators, typed commands and
 * queries, rejection assertions and event helpers. Every result is validated
 * against the protocol schemas.
 */
import { expect } from "bun:test";
import {
  type CommandName,
  ErrorCodes,
  ErrorData,
  type Event,
  type MethodName,
  type Params,
  type Payload,
  type ResultOf,
} from "../schemas/protocol.ts";
import { type EngineHandle, type EngineOptions, startEngine } from "./engine.ts";
import { RpcClient, RpcError } from "./rpc.ts";
import { checkResult, schemaErrors } from "./validate.ts";

export { ErrorCodes as E } from "../schemas/protocol.ts";

let seq = 0;
/** A fresh command ID, unique across the test run. */
export const newCommandId = (tag = "c") => `${tag}-${Date.now().toString(36)}-${(++seq).toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

/** Throws when a result does not match the schemas (set SCHEMA_STRICT=0 to only warn). */
function validated<T>(method: MethodName, result: T): T {
  const errs = checkResult(method, result);
  if (errs.length) {
    const msg = `${method}: response does not match the protocol schema:\n  ${errs.join("\n  ")}`;
    if (process.env.SCHEMA_STRICT === "0") console.warn(msg);
    else throw new Error(msg);
  }
  return result;
}

export interface CmdOptions {
  commandId?: string;
  expectedVersion?: number;
  caller?: string;
}

type Completed = Extract<ResultOf<"task.complete">, { outcome: "completed" }>;

export class Actor {
  constructor(
    readonly world: World,
    readonly id: string,
    readonly name: string,
    readonly client: RpcClient,
  ) {}

  get caller() {
    return `test:${this.name}`;
  }

  /** Sends a command and returns its (schema-validated) result. */
  async do<M extends CommandName>(method: M, payload: Payload<M>, opts: CmdOptions = {}): Promise<ResultOf<M>> {
    const params: Record<string, unknown> = {
      commandId: opts.commandId ?? newCommandId(),
      actor: this.id,
      caller: opts.caller ?? this.caller,
      payload,
    };
    if (opts.expectedVersion !== undefined) params.expectedVersion = opts.expectedVersion;
    return validated(method, await this.client.request(method, params));
  }

  /** Sends a query as this actor. */
  async query<M extends MethodName>(method: M, params: Omit<Params<M>, "actor" | "caller">): Promise<ResultOf<M>> {
    return validated(method, await this.client.request(method, { actor: this.id, caller: this.caller, ...params }));
  }

  /** `task.complete` that must complete (not be recorded as a late result). */
  async complete(payload: Payload<"task.complete">, opts: CmdOptions = {}): Promise<Completed> {
    const r = await this.do("task.complete", payload, opts);
    if (r.outcome !== "completed") throw new Error(`task.complete: expected outcome "completed", got "${r.outcome}"`);
    return r;
  }

  task(taskId: string) {
    return this.query("task.get", { taskId });
  }

  /** Creates a Task and returns its view. */
  async create(title: string, extra: Omit<Payload<"task.create">, "title"> = {}) {
    return (await this.do("task.create", { title, ...extra })).task;
  }

  /** Same actor on another connection. */
  async reconnect(): Promise<Actor> {
    return new Actor(this.world, this.id, this.name, await this.world.engine.connect());
  }
}

export class World {
  private names = 0;
  private constructor(
    readonly engine: EngineHandle,
    readonly client: RpcClient,
    readonly workspaceId: string,
    readonly owner: Actor,
  ) {}

  static async start(opts: EngineOptions = {}): Promise<World> {
    const engine = await startEngine(opts);
    try {
      const client = await engine.connect();
      const ws = validated("workspace.get", await client.request("workspace.get", {}));
      const first = ws.owners[0];
      if (!first) throw new Error("workspace.get returned no owners");
      const world: World = new World(engine, client, ws.workspace.id, undefined as unknown as Actor);
      (world as { owner: Actor }).owner = new Actor(world, first.id, first.name, client);
      return world;
    } catch (e) {
      await engine.dispose();
      throw e;
    }
  }

  /** Registers a collaborator and grants it a role (as the owner). Name is made unique. */
  async add(name: string, role: "owner" | "member" | "guest" = "member", kind: "human" | "agent" = "agent"): Promise<Actor> {
    const unique = `${name}-${++this.names}`;
    const { collaborator } = await this.owner.do("collaborator.register", { kind, name: unique });
    await this.owner.do("membership.grant", { collaboratorId: collaborator.id, role });
    return new Actor(this, collaborator.id, unique, this.client);
  }

  /** All events after a cursor (pages through events.read). */
  async events(after = 0, filter: { taskSubtree?: string; types?: string[] } = {}): Promise<Event[]> {
    const out: Event[] = [];
    let cursor = after;
    for (;;) {
      const r = await this.owner.query("events.read", { after: cursor, limit: 1000, ...filter });
      out.push(...r.events);
      if (!r.hasMore) return out;
      // A cursor that does not advance while more events remain would silently truncate the history.
      if (r.cursor <= cursor) {
        throw new Error(`events.read: hasMore is true but the cursor did not advance (after ${cursor}, cursor ${r.cursor})`);
      }
      cursor = r.cursor;
    }
  }

  async head(): Promise<number> {
    return (await this.client.request("workspace.get", {})).head;
  }

  dispose() {
    return this.engine.dispose();
  }
}

/**
 * The check phase each error code belongs to (PROTOCOL.md#check-phases). `-32700`/`-32600`/`-32603`
 * carry no phase (no phase ran, or the engine itself broke).
 */
export const phaseOf: Record<number, string> = {
  [ErrorCodes.methodNotFound]: "shape",
  [ErrorCodes.invalidParams]: "shape",
  [ErrorCodes.idempotencyConflict]: "shape",
  [ErrorCodes.notImplemented]: "shape",
  [ErrorCodes.permissionDenied]: "permission",
  [ErrorCodes.notFound]: "permission",
  [ErrorCodes.versionConflict]: "content",
  [ErrorCodes.ruleViolation]: "content",
  [ErrorCodes.checkFailed]: "hooks",
};

/**
 * Awaits a promise that must be rejected with `code`, the phase that code belongs to, and a `failures`
 * list containing the expected check — membership only, never position, count or exclusivity
 * (PROTOCOL.md#check-phases). `check` may be an array: at least one of those checks must appear
 * (a phase with several failures may report one or all). Every listed failure needs an actionable reason.
 */
export async function expectRejected(p: Promise<unknown>, code: number, check?: string | string[]): Promise<RpcError> {
  let value: unknown;
  try {
    value = await p;
  } catch (e) {
    if (!(e instanceof RpcError)) throw e;
    expect({ code: e.code, phase: e.phase }).toEqual({ code, phase: phaseOf[code] });
    // The whole error data must match the ErrorData schema (incl. the hooks-phase entry's details.failures).
    expect(schemaErrors(ErrorData, e.error.data)).toEqual([]);
    const failures = e.failures ?? [];
    expect(failures.length).toBeGreaterThan(0);
    if (check !== undefined) {
      const wanted = Array.isArray(check) ? check : [check];
      expect(wanted.some((c) => failures.some((f) => f.check === c))).toBe(true);
    }
    for (const f of failures) expect(typeof f.reason === "string" && f.reason.length > 0).toBe(true);
    return e;
  }
  const name = Object.entries(ErrorCodes).find(([, c]) => c === code)?.[0];
  throw new Error(`expected rejection ${code} ${name}${check ? ` [${check}]` : ""}, got success: ${JSON.stringify(value).slice(0, 400)}`);
}

export const types = (events: Event[]) => events.map((e) => e.type);

/** The failing required checks of a hooks-phase rejection: `details.failures` of the `hook.*` failure entry. */
export function hookFailures(e: RpcError): { kit: string; version: string; policy: string | null; reason: string }[] {
  const entry = e.failures?.find((f) => f.check?.startsWith("hook."));
  return (entry?.details?.failures ?? []) as { kit: string; version: string; policy: string | null; reason: string }[];
}

/** Polls `fn` until it returns a truthy value or the timeout passes. */
export async function until<T>(fn: () => Promise<T | undefined | null | false>, timeoutMs = 5000, stepMs = 50): Promise<T> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`condition not met within ${timeoutMs} ms`);
    await Bun.sleep(stepMs);
  }
}
