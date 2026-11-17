/**
 * The listeners behind `onAppended` (the layer's wake-ups): the first listener starts a `LISTEN` on the layer's
 * channel, the last unsubscribe stops it, and every notification calls each listener. Best effort, as the contract
 * says: a `LISTEN` that cannot start is reported once and retried with a back-off of 1 s doubling to 30 s while
 * listeners remain, and a wake-up missed meanwhile is caught by the bus's poll. Bun.SQL reconnects a dropped listen
 * connection itself; each reconnect after the first `LISTEN` wakes every listener, since notifications sent while it
 * was down are lost.
 */

/** A `LISTEN` that is running. */
export interface ListenSubscription { unlisten(): Promise<void> }

/** Starts a `LISTEN`: `onNotify` for each notification, `onListen` each time the server acknowledged it. */
export type Listen = (onNotify: () => void, onListen: () => void) => Promise<ListenSubscription>;

/** The timer functions the retry uses; tests pass their own. */
export interface WakeupTimers {
  setTimeout(run: () => void, ms: number): unknown;
  clearTimeout(timer: unknown): void;
}

const SYSTEM_TIMERS: WakeupTimers = {
  setTimeout(run, ms) {
    const timer = setTimeout(run, ms);
    // A retry never keeps the process alive on its own.
    (timer as { unref?: () => void }).unref?.();
    return timer;
  },
  clearTimeout: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
};

const FIRST_DELAY = 1000;
const LAST_DELAY = 30_000;

export class AppendedListeners {
  readonly #listen: Listen;
  readonly #timers: WakeupTimers;
  readonly #report: (error: unknown) => void;
  readonly #listeners = new Set<() => void>();
  /** Bumped by every start and every halt, so a start that settles after a halt undoes itself. */
  #generation = 0;
  /** Whether a start, a subscription or a retry belongs to the current generation. */
  #active = false;
  #subscription: ListenSubscription | undefined;
  /** The start in flight, which never rejects; `stop()` waits for it. */
  #starting: Promise<void> = Promise.resolve();
  #retry: unknown;
  #delay = FIRST_DELAY;
  /** Whether the current run of failures was reported. */
  #reported = false;

  constructor(listen: Listen, options: { timers?: WakeupTimers; report?: (error: unknown) => void } = {}) {
    this.#listen = listen;
    this.#timers = options.timers ?? SYSTEM_TIMERS;
    this.#report = options.report ?? ((error) => console.error("data-postgres: LISTEN for outbox wake-ups failed; retrying while the bus polls:", error));
  }

  /** Adds a listener, starting the `LISTEN` for the first; returns the unsubscribe, which stops it after the last. */
  add(listener: () => void): () => void {
    // A wrapper per registration, so one function registered twice is two registrations.
    const entry = () => { listener(); };
    this.#listeners.add(entry);
    this.resume();
    return () => {
      if (!this.#listeners.delete(entry) || this.#listeners.size > 0) return;
      void this.#halt();
    };
  }

  /** Starts the `LISTEN` again when listeners remain and none runs (after `stop()`, when the layer opens again). */
  resume(): void {
    if (this.#active || this.#listeners.size === 0) return;
    this.#start();
  }

  /** Ends the `LISTEN` and any retry and keeps the listeners (the layer's `close()`). */
  async stop(): Promise<void> {
    await this.#halt();
  }

  #fire(): void {
    for (const listener of [...this.#listeners]) {
      try { listener(); } catch (error) { this.#report(error); }
    }
  }

  #start(): void {
    const generation = ++this.#generation;
    this.#active = true;
    let acknowledged = 0;
    const onNotify = () => { if (generation === this.#generation) this.#fire(); };
    const onListen = () => { if (++acknowledged > 1 && generation === this.#generation) this.#fire(); };
    this.#starting = (async () => {
      let subscription: ListenSubscription;
      try { subscription = await this.#listen(onNotify, onListen); }
      catch (error) {
        if (generation !== this.#generation) return;
        if (!this.#reported) { this.#reported = true; this.#report(error); }
        const delay = this.#delay;
        this.#delay = Math.min(delay * 2, LAST_DELAY);
        this.#retry = this.#timers.setTimeout(() => {
          this.#retry = undefined;
          if (generation === this.#generation && this.#listeners.size > 0) this.#start();
        }, delay);
        return;
      }
      if (generation !== this.#generation) { await subscription.unlisten().catch(() => undefined); return; }
      this.#subscription = subscription;
      this.#delay = FIRST_DELAY;
      this.#reported = false;
    })();
  }

  async #halt(): Promise<void> {
    this.#generation++;
    this.#active = false;
    if (this.#retry !== undefined) { this.#timers.clearTimeout(this.#retry); this.#retry = undefined; }
    const subscription = this.#subscription;
    this.#subscription = undefined;
    await this.#starting;
    await subscription?.unlisten().catch(() => undefined);
  }
}
