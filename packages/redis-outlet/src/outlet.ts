import { RedisClient } from "bun";
import {
  FrameworkError, SubscriptionOverflowError, declaredEvents, subscribe,
  type Binding, type EventRecord, type Subscription,
} from "@meshfw/runtime";

/** What `redisOutlet` takes. */
export interface RedisOutletOptions {
  /** The Redis URL, such as "redis://localhost:6379". Required: there is no default server. */
  readonly url: string;
  /** The stream key, such as "billing:events". Required; it names the subscription, `outlet:redis:<stream>`. */
  readonly stream: string;
  /** The FQNs of the events to send: a surface manifest's `publishes`. Required and non-empty; nothing else leaves. */
  readonly events: readonly string[];
  /** Approximate cap on the stream's length (`XADD MAXLEN ~`). Required: Mesh does not choose another system's retention. */
  readonly maxLength: number;
  /** Where a first open starts, as `subscribe`'s `after`; default: now (the highest position). Ignored on a reopen. */
  readonly after?: number;
  /** Called with each Redis error and with the reason the outlet stopped; without it, stderr. */
  readonly onError?: (error: unknown) => void;
}

/** What `redisOutlet` resolves with. */
export interface RedisOutlet {
  /** The subscription's name, `outlet:redis:<stream>`: its row in `mesh_subscription_progress`. */
  readonly name: string;
  /** End the subscription (its row is kept, so a later open resumes from what was sent) and close the Redis client. */
  close(): Promise<void>;
  /** Resolves when the outlet ends: with null after `close()` or the deliverer's stop, else with the error that ended it. */
  readonly done: Promise<Error | null>;
}

/** The schemes Bun's `RedisClient` takes; another one (`http:`, or `localhost:` in "localhost:6379") is a bad option. */
const REDIS_SCHEMES = new Set(["redis:", "rediss:", "valkey:", "valkeys:", "redis+tls:", "redis+unix:", "redis+tls+unix:"]);
const OPTION_NAMES = new Set(["url", "stream", "events", "maxLength", "after", "onError"]);
/** The first wait before a Redis call is tried again, doubled after each failure up to `LAST_DELAY` (rule O5). */
const FIRST_DELAY = 1_000;
const LAST_DELAY = 30_000;
/** How many skipped rows (events not in `events`) go unacknowledged at most before one `ack` passes them. */
const ACK_EVERY = 100;
/**
 * How long a skipped row waits for another row before it is acknowledged alone. Without it, a few skipped rows and then
 * nothing would stay unacknowledged until the next sent row, holding the outbox's rows and making the deliverer report
 * the outlet as not acknowledging.
 */
const IDLE_ACK = 1_000;
/** The words of Redis's refusal of an entry id that is not above the stream's top one. */
const NOT_ABOVE_TOP = "equal or smaller than the target stream top item";

function describe(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "an array";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "undefined") return String(value);
  return `a value of type ${typeof value}`;
}

interface Checked {
  readonly url: string;
  readonly stream: string;
  readonly events: ReadonlySet<string>;
  readonly maxLength: number;
  readonly after: number | undefined;
  readonly onError: ((error: unknown) => void) | undefined;
}

/** The options, checked as `localBus` checks its own: each bad one is a `FrameworkError` saying what it is for. */
function checked(options: RedisOutletOptions | undefined): Checked {
  if (typeof options !== "object" || options === null || Array.isArray(options))
    throw new FrameworkError(`redisOutlet takes { url, stream, events, maxLength, after, onError }, and was given ${describe(options)}`);
  for (const key of Object.keys(options))
    if (!OPTION_NAMES.has(key)) throw new FrameworkError(`redisOutlet has no option ${JSON.stringify(key)}; its options are url, stream, events, maxLength, after and onError`);
  const { url, stream, events, maxLength, after, onError } = options;
  if (url === undefined) throw new FrameworkError(`redisOutlet: url is the Redis server to send to, such as "redis://localhost:6379", and is missing`);
  // The value is never printed: a Redis URL may hold a password.
  if (typeof url !== "string" || !URL.canParse(url))
    throw new FrameworkError(`redisOutlet: url is the Redis server to send to, such as "redis://localhost:6379", and is ${typeof url === "string" ? "not a URL" : describe(url)}`);
  if (!REDIS_SCHEMES.has(new URL(url).protocol))
    throw new FrameworkError(`redisOutlet: url is the Redis server to send to, such as "redis://localhost:6379", and is not a Redis URL: its scheme must be one of ${[...REDIS_SCHEMES].map((scheme) => scheme.slice(0, -1)).join(", ")}`);
  if (stream === undefined) throw new FrameworkError(`redisOutlet: stream is the key of the Redis stream to send to, such as "billing:events", and is missing`);
  if (typeof stream !== "string" || stream.trim() === "")
    throw new FrameworkError(`redisOutlet: stream is the key of the Redis stream to send to, such as "billing:events", and is ${describe(stream)}`);
  if (events === undefined)
    throw new FrameworkError("redisOutlet: events is the list of event FQNs to send, such as surface.publishes of a surface's manifest, and is missing: nothing leaves the application unless it is listed");
  if (!Array.isArray(events) || events.length === 0 || events.some((name) => typeof name !== "string" || name === ""))
    throw new FrameworkError(`redisOutlet: events is the list of event FQNs to send, such as surface.publishes of a surface's manifest, a non-empty array of FQNs, and is ${Array.isArray(events) ? (events.length === 0 ? "empty" : "an array holding something that is not an FQN") : describe(events)}`);
  if (maxLength === undefined)
    throw new FrameworkError("redisOutlet: maxLength is the approximate number of entries the stream keeps (XADD MAXLEN ~), a whole number of 1 or more, and is missing: Mesh does not choose how long another system keeps its events");
  if (typeof maxLength !== "number" || !Number.isSafeInteger(maxLength) || maxLength < 1)
    throw new FrameworkError(`redisOutlet: maxLength is the approximate number of entries the stream keeps (XADD MAXLEN ~), a whole number of 1 or more, and is ${describe(maxLength)}`);
  if (after !== undefined && (typeof after !== "number" || !Number.isSafeInteger(after) || after < 0))
    throw new FrameworkError(`redisOutlet: after is the position a first open starts from, a whole number, and is ${describe(after)}`);
  if (onError !== undefined && typeof onError !== "function")
    throw new FrameworkError(`redisOutlet: onError is the function called with each Redis error and with the reason the outlet stopped, and is ${describe(onError)}`);
  return { url, stream, events: new Set(events), maxLength, after, onError };
}

/** The edit distance between two names, for the nearest declared FQN. */
function distance(a: string, b: string): number {
  let previous = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++)
      current[j] = Math.min(previous[j]! + 1, current[j - 1]! + 1, previous[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
    previous = current;
  }
  return previous[b.length]!;
}

/** Every `events` entry must be an event the binding's domain declares: a name that matches none would send nothing, silently. */
function checkDeclared(binding: Binding, events: ReadonlySet<string>): void {
  const declared = declaredEvents(binding);
  for (const name of events) {
    if (declared.includes(name)) continue;
    const nearest = [...declared].sort((a, b) => distance(name, a) - distance(name, b))[0];
    const near = nearest !== undefined && distance(name, nearest) <= Math.max(2, Math.floor(name.length / 3)) ? `: did you mean ${nearest}?` : ".";
    throw new FrameworkError(`redisOutlet: events lists ${JSON.stringify(name)}, which is not a declared event${near} The project declares ${declared.join(", ") || "none"}`);
  }
}

/** The host and port of a Redis URL, for messages: the URL itself may hold a password. */
function serverOf(url: string): string {
  try { return new URL(url).host || "the configured server"; } catch { return "the configured server"; }
}

/** The fields of one stream entry: the format other applications read (strings, as Redis stores them; no `metadata`). */
function fieldsOf(event: EventRecord): string[] {
  return [
    "id", event.id,
    "name", event.name,
    "position", String(event.position),
    "occurredAt", event.occurredAt.toISOString(),
    "causedBy", event.causedBy ?? "",
    "entity", event.entity,
    "action", event.action,
    "key", JSON.stringify(event.key),
    "payload", JSON.stringify(event.payload),
  ];
}

/** The value of `field` in an entry's flat field list, as XRANGE returns it. */
function fieldOf(entry: unknown, field: string): string | undefined {
  const fields = Array.isArray(entry) ? entry[1] : undefined;
  if (!Array.isArray(fields)) return undefined;
  for (let i = 0; i + 1 < fields.length; i += 2) if (fields[i] === field) return String(fields[i + 1]);
  return undefined;
}

const isRefusal = (error: unknown): boolean => error instanceof Error && error.message.includes(NOT_ABOVE_TOP);

/** One open of the subscription: ended once its stream ends, so a callback still running for it stops sending. */
interface Open {
  readonly subscription: Subscription;
  ended: boolean;
  /** True once a row was acknowledged through this open. */
  progressed: boolean;
}

class Outlet {
  readonly name: string;
  readonly done: Promise<Error | null>;
  readonly handle: RedisOutlet;
  #settle!: (value: Error | null) => void;
  #open: Open | undefined;
  /** The callback running now, awaited by `close()` and before a reopen, so no two sends of one outlet overlap. */
  #running: Promise<void> | undefined;
  /** The highest position skipped (its event is not sent) and not acknowledged yet; 0 when none. */
  #pending = 0;
  #skipped = 0;
  #closing: Promise<void> | undefined;
  #finished = false;
  /** The pending idle acknowledgement of skipped rows (`IDLE_ACK`), cleared when a row arrives, at the end and by close(). */
  #idle: ReturnType<typeof setTimeout> | undefined;
  /** Ends the back-off wait running now, if any. */
  #wake: (() => void) | undefined;
  /** The wait before a reopen after an overflow that acknowledged nothing since the open before it. */
  #reopenDelay = FIRST_DELAY;

  constructor(readonly binding: Binding, readonly options: Checked, readonly client: RedisClient) {
    this.name = `outlet:redis:${options.stream}`;
    this.done = new Promise((resolve) => { this.#settle = resolve; });
    this.handle = Object.freeze({ name: this.name, close: () => this.close(), done: this.done });
  }

  /** Open (or reopen) the subscription. A first open passes `after`; a reopen resumes from the acknowledged position. */
  async open(after: number | undefined): Promise<void> {
    let ready!: (open: Open) => void;
    const opened = new Promise<Open>((resolve) => { ready = resolve; });
    // A round may feed a row before `subscribe` resolves: the callback waits for the handle it acknowledges through.
    const subscription = await subscribe(this.binding, { name: this.name, ...(after !== undefined ? { after } : {}) }, async (event) => {
      const open = await opened;
      // An idle acknowledgement still running finishes first, so no acknowledgement passes a later one.
      await this.#running?.catch(() => undefined);
      const run = this.#row(event, open);
      this.#running = run;
      try { await run; } finally { if (this.#running === run) this.#running = undefined; }
    });
    const open: Open = { subscription, ended: false, progressed: false };
    this.#open = open;
    this.#pending = 0;
    this.#skipped = 0;
    ready(open);
    void subscription.done.then((reason) => this.#ended(open, reason));
  }

  async #row(event: EventRecord, open: Open): Promise<void> {
    this.#cancelIdle();
    if (open.ended || this.#closing) return;
    if (!this.options.events.has(event.name)) {
      this.#pending = event.position;
      if (++this.#skipped >= ACK_EVERY) await this.#ackPending(open);
      else this.#idleAck(open);
      return;
    }
    if (!(await this.#send(event, open))) return;
    // An acknowledgement passes every skipped row below it as well.
    await open.subscription.ack(event.position);
    open.progressed = true;
    this.#pending = 0;
    this.#skipped = 0;
  }

  #cancelIdle(): void {
    if (this.#idle !== undefined) clearTimeout(this.#idle);
    this.#idle = undefined;
  }

  /** Acknowledge the pending skipped rows once no row came for `IDLE_ACK`, unless a row is being handled then. */
  #idleAck(open: Open): void {
    this.#cancelIdle();
    this.#idle = setTimeout(() => {
      this.#idle = undefined;
      if (open.ended || this.#closing || this.#running !== undefined) return;
      const run = this.#ackPending(open).catch((error: unknown) => { if (!open.ended) this.#report(error); });
      this.#running = run;
      void run.finally(() => { if (this.#running === run) this.#running = undefined; });
    }, IDLE_ACK);
  }

  async #ackPending(open: Open): Promise<void> {
    if (this.#pending === 0) return;
    await open.subscription.ack(this.#pending);
    open.progressed = true;
    this.#pending = 0;
    this.#skipped = 0;
  }

  /**
   * XADD the row as entry `<position>-0` (rule O3). Redis errors are retried with back-off and reported, never thrown
   * (O5). A refusal of the id counts as sent only when the entry at that id is this event (O4); otherwise this throws,
   * which ends the subscription. False when the open ended or the outlet is closing meanwhile: nothing is acknowledged.
   */
  async #send(event: EventRecord, open: Open): Promise<boolean> {
    const { stream, maxLength } = this.options;
    const id = `${event.position}-0`;
    // Built once, before the retries: a payload JSON cannot encode (a bigint or a cycle an upcast returned) is no Redis
    // error to retry for ever, so it ends the subscription.
    let fields: string[];
    try {
      fields = fieldsOf(event);
    } catch (error) {
      throw new FrameworkError(`redisOutlet: the event ${event.name} at position ${event.position} cannot be written as JSON: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    }
    let delay = FIRST_DELAY;
    for (;;) {
      if (open.ended || this.#closing) return false;
      try {
        await this.#connected();
        try {
          await this.client.send("XADD", [stream, "MAXLEN", "~", String(maxLength), id, ...fields]);
          return true;
        } catch (error) {
          if (!isRefusal(error)) throw error;
        }
        const entries: unknown = await this.client.send("XRANGE", [stream, id, id]);
        const entry = Array.isArray(entries) ? entries[0] : undefined;
        if (entry !== undefined && fieldOf(entry, "id") === event.id) return true;
        const found = entry === undefined ? "missing" : `the event ${fieldOf(entry, "id") ?? "(no id field)"}${fieldOf(entry, "name") ? ` (${fieldOf(entry, "name")})` : ""}`;
        throw new FrameworkError(`redisOutlet: the stream ${stream} holds entries this outbox did not write (its top id is at or above position ${event.position}, and entry ${id} is ${found}); a restored or reset database, or two applications on one stream key: use a new stream key`);
      } catch (error) {
        if (error instanceof FrameworkError) throw error;
        this.#report(error);
        await this.#sleep(delay);
        delay = Math.min(delay * 2, LAST_DELAY);
      }
    }
  }

  /** The client is opened without reconnecting on its own or queueing offline, so a call fails at once while Redis is away. */
  async #connected(): Promise<void> {
    if (this.client.connected) return;
    await this.client.connect();
    await nameConnection(this.client, this.name);
  }

  #report(error: unknown): void {
    const onError = this.options.onError;
    if (onError === undefined) { console.error(`Mesh (redisOutlet ${this.name}):`, error); return; }
    try { onError(error); } catch (thrown) { console.error(`Mesh (redisOutlet ${this.name}): onError threw:`, thrown, "while handed:", error); }
  }

  /** A back-off wait; `close()` and the end of the stream cut it short. The outlet's other timer is the idle acknowledgement. */
  #sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => { this.#wake = undefined; resolve(); }, ms);
      this.#wake = () => { clearTimeout(timer); this.#wake = undefined; resolve(); };
    });
  }

  /** The subscription's stream ended: reopen after an overflow once Redis answers (O6), else end the outlet. */
  async #ended(open: Open, reason: unknown): Promise<void> {
    open.ended = true;
    this.#cancelIdle();
    this.#wake?.();
    if (this.#closing) return;
    if (reason instanceof SubscriptionOverflowError) {
      this.#report(reason);
      await this.#running?.catch(() => undefined);
      // A reopen feeds every row above the acknowledged position again, so one that overflowed before acknowledging
      // anything would overflow again at once: it waits, longer each time, instead of reopening in a tight loop.
      if (open.progressed) this.#reopenDelay = FIRST_DELAY;
      else {
        await this.#sleep(this.#reopenDelay);
        this.#reopenDelay = Math.min(this.#reopenDelay * 2, LAST_DELAY);
      }
      let delay = FIRST_DELAY;
      for (;;) {
        if (this.#closing) return;
        try {
          await this.#connected();
          await this.client.send("PING", []);
          break;
        } catch (error) {
          this.#report(error);
          await this.#sleep(delay);
          delay = Math.min(delay * 2, LAST_DELAY);
        }
      }
      if (this.#closing) return;
      try {
        await this.open(undefined);
        if (this.#closing) await this.#open?.subscription.close();
      } catch (error) {
        this.#finish(error instanceof Error ? error : new Error(String(error)));
      }
      return;
    }
    if (reason !== null && reason !== undefined) this.#finish(reason instanceof Error ? reason : new Error(String(reason)));
    else this.#finish(null);
  }

  #finish(reason: Error | null): void {
    if (this.#finished) return;
    this.#finished = true;
    if (reason !== null) this.#report(reason);
    this.client.close();
    this.#settle(reason);
  }

  close(): Promise<void> {
    return this.#closing ??= (async () => {
      this.#cancelIdle();
      this.#wake?.();
      await this.#running?.catch(() => undefined);
      const open = this.#open;
      if (open !== undefined && !open.ended) {
        try { await this.#ackPending(open); } catch (error) { this.#report(error); }
        await open.subscription.close();
      }
      this.#finish(null);
    })();
  }
}

/**
 * Name the connection after the subscription (`CLIENT SETNAME`), so `CLIENT LIST` on the server shows which outlet holds
 * it. A connection name takes no space or control character, so each of those in the stream key is written as `_`.
 */
async function nameConnection(client: RedisClient, name: string): Promise<void> {
  await client.send("CLIENT", ["SETNAME", name.replace(/[^\x21-\x7e]/g, "_")]);
}

/** A client that answered PING. Every failure, Bun's refusal of the URL in the constructor included, is a `FrameworkError`. */
async function connectedClient(url: string, name: string): Promise<RedisClient> {
  let client: RedisClient | undefined;
  try {
    client = new RedisClient(url, { autoReconnect: false, enableOfflineQueue: false });
    await client.connect();
    await client.send("PING", []);
    await nameConnection(client, name);
    return client;
  } catch (cause) {
    client?.close();
    throw new FrameworkError(`redisOutlet: the Redis server at ${serverOf(url)} did not answer: ${cause instanceof Error ? cause.message : String(cause)}`, { cause });
  }
}

/**
 * Open an outlet (rules O1 to O7): a subscription named `outlet:redis:<stream>` on `binding`, in its delivering
 * process, whose callback copies each row whose event is in `options.events` to the Redis stream `options.stream` as
 * entry `<position>-0`, then acknowledges it; other rows are acknowledged unsent. Rejects with a `FrameworkError` on a
 * bad option, an event the domain does not declare, a Redis server that does not answer `PING`, or what `subscribe`
 * refuses.
 */
export async function redisOutlet(binding: Binding, options: RedisOutletOptions): Promise<RedisOutlet> {
  const settings = checked(options);
  checkDeclared(binding, settings.events);
  const client = await connectedClient(settings.url, `outlet:redis:${settings.stream}`);
  const outlet = new Outlet(binding, settings, client);
  try {
    await outlet.open(settings.after);
  } catch (error) {
    client.close();
    throw error;
  }
  return outlet.handle;
}
