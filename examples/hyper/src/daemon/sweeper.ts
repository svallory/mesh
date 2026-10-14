// The lease sweeper (PROTOCOL.md:312): the engine expires a claim on its own, no later than 1000 ms after its
// `expiresAt`, even when no command touches its Task. Hyper runs it as a process that expires each overdue claim in a
// transaction of its own (`tasks/claim/sweeper.ex:19-61`); here it is a timer that calls the internal Claim `expire`
// with the engine's context (gap G17, ADR-0071). A claim is expired the moment its lease runs out whether or not the
// sweeper has reached it, so every check reads `expiresAt` itself; the sweeper only records what is already true.
import type { ActionContext } from "@meshfw/runtime";
import { Mesh } from "meshfw";
import { Claim } from "#mesh/domain/work";

/** How long the sweeper waits after one sweep before it starts the next: well inside the protocol's 1000 ms. */
export const SWEEP_INTERVAL_MS = 250;

/** What the sweeper runs on: the binding `bind(layer)` returns, or one a test bound. */
export interface SweepBinding {
  transaction<T>(fn: () => Promise<T>): Promise<T>;
}

/** The claims whose lease has run out at `now` and that nothing has ended yet. */
const lapsedAt = (now: Date) => ({ state: { eq: "active" as const }, expiresAt: { lte: now } });

/**
 * Expires every active claim whose lease has run out at `clock()`, through Claim `expire` with `context` (the engine's
 * in the daemon), each in a transaction of its own, in which it reads the claim again: a command may have ended it in
 * the meantime, or `claim.acquire` expired it first. `expire` touches the Task, which bumps its version, as the
 * protocol's `claim.expired` does (PROTOCOL.md:118). Resolves with how many it expired. A claim that fails does not
 * stop the others: once every claim was tried, it rejects with an `AggregateError` of the failures.
 */
export async function sweep(binding: SweepBinding, context: ActionContext, clock: () => Date = () => new Date()): Promise<number> {
  const lapsed = await binding.transaction(() => Mesh.privileged(Claim).read({ filter: lapsedAt(clock()), sort: ["expiresAt", "id"] }));
  const failures: unknown[] = [];
  let expired = 0;
  for (const { id } of lapsed) {
    try {
      const done = await binding.transaction(async () => {
        const [still] = await Mesh.privileged(Claim).read({ filter: { id: { eq: id }, ...lapsedAt(clock()) }, limit: 1 });
        if (!still) return false;
        await Claim.expire({ id, reason: "lease expired" }, context);
        return true;
      });
      if (done) expired++;
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length > 0) throw new AggregateError(failures, `the lease sweeper could not expire ${failures.length} of ${lapsed.length} lapsed claims`);
  return expired;
}

export interface SweeperOptions {
  /** The context `expire` runs with: the engine's (`ENGINE` in `src/rpc/context.ts`). */
  readonly context: ActionContext;
  /** The pause between two sweeps; `SWEEP_INTERVAL_MS` unless a test sets it. */
  readonly intervalMs?: number;
  /** The time a sweep compares `expiresAt` with; the system clock unless a test sets it. */
  readonly clock?: () => Date;
}

export interface Sweeper {
  /** Stops the timer and resolves once the sweep in progress, if any, has finished. Calling it again returns the same promise. */
  stop(): Promise<void>;
}

/**
 * Starts sweeping on `binding`: the first sweep `intervalMs` from now, and each next one `intervalMs` after the last
 * finished, so two never overlap. A sweep that fails is logged on standard error and the next one tries again. The
 * timer does not keep the process alive on its own.
 */
export function startSweeper(binding: SweepBinding, options: SweeperOptions): Sweeper {
  const intervalMs = options.intervalMs ?? SWEEP_INTERVAL_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running: Promise<void> | undefined;
  let stopping: Promise<void> | undefined;
  const schedule = () => {
    timer = setTimeout(() => {
      timer = undefined;
      running = sweep(binding, options.context, options.clock)
        .then(
          () => {},
          (error: unknown) => console.error("the lease sweeper failed; it tries again on its next sweep", error),
        )
        .finally(() => {
          running = undefined;
          if (stopping === undefined) schedule();
        });
    }, intervalMs);
    timer.unref();
  };
  schedule();
  return {
    stop: () =>
      (stopping ??= (async () => {
        if (timer !== undefined) clearTimeout(timer);
        timer = undefined;
        await running;
      })()),
  };
}
