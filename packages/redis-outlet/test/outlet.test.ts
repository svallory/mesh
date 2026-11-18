// `redisOutlet` (handlers design, rules O1 to O7; ruling D44 Q6, Q7 and Q13) against a real Redis server
// (`MESH_TEST_REDIS_URL`, a `redis:7-alpine` service in CI), on SQLite with localBus, in the project of
// `fixtures/project`, a fresh stream key per test. The options checks need no server.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RedisClient } from "bun";
import { FrameworkError, SubscriptionOverflowError, listSubscriptions, readEvents } from "@meshfw/runtime";
import { AsyncLocalStorage } from "node:async_hooks";
import { redisOutlet, type RedisOutletOptions } from "../src/index.ts";
import { builtProject, describeServer, entries, freshBinding, outletConnections, redis, redisUrl, streamKey, until } from "./support.ts";
import { redisProxy } from "./proxy.ts";

const project = builtProject();
const FRAME = new AsyncLocalStorage<unknown>();
const PAID = "billing.InvoicePaid";
const DRAFTED = "billing.InvoiceDrafted";

const rejection = (promise: Promise<unknown>) => promise.then(() => undefined, (error: unknown) => error);
const position = async (binding: Parameters<typeof listSubscriptions>[0], name: string) =>
  (await listSubscriptions(binding)).find((row) => row.name === name)?.position;

describe("redisOutlet's options", () => {
  const base = { url: "redis://localhost:6379", stream: "s", events: [PAID], maxLength: 1000 } satisfies RedisOutletOptions;
  test.each([
    ["no options", undefined, "redisOutlet takes { url, stream, events, maxLength, after, onError }, and was given undefined"],
    ["an unknown option", { ...base, names: [] }, `redisOutlet has no option "names"; its options are url, stream, events, maxLength, after and onError`],
    ["no url", { ...base, url: undefined }, `redisOutlet: url is the Redis server to send to, such as "redis://localhost:6379", and is missing`],
    ["a url that is no URL, its text never printed", { ...base, url: "secret-password" }, `redisOutlet: url is the Redis server to send to, such as "redis://localhost:6379", and is not a URL`],
    ["an http url, its text never printed", { ...base, url: "http://user:hunter2@localhost:6379" }, "redisOutlet: url is the Redis server to send to, such as \"redis://localhost:6379\", and is not a Redis URL: its scheme must be one of redis, rediss, valkey, valkeys, redis+tls, redis+unix, redis+tls+unix"],
    ["a url with no scheme", { ...base, url: "localhost:6379" }, "redisOutlet: url is the Redis server to send to, such as \"redis://localhost:6379\", and is not a Redis URL: its scheme must be one of redis, rediss, valkey, valkeys, redis+tls, redis+unix, redis+tls+unix"],
    ["a mailto url", { ...base, url: "mailto:x@y" }, "redisOutlet: url is the Redis server to send to, such as \"redis://localhost:6379\", and is not a Redis URL: its scheme must be one of redis, rediss, valkey, valkeys, redis+tls, redis+unix, redis+tls+unix"],
    ["a url that is no string", { ...base, url: 6379 }, `redisOutlet: url is the Redis server to send to, such as "redis://localhost:6379", and is 6379`],
    ["no stream", { ...base, stream: undefined }, `redisOutlet: stream is the key of the Redis stream to send to, such as "billing:events", and is missing`],
    ["a blank stream", { ...base, stream: " " }, `redisOutlet: stream is the key of the Redis stream to send to, such as "billing:events", and is " "`],
    ["no events", { ...base, events: undefined }, "redisOutlet: events is the list of event FQNs to send, such as surface.publishes of a surface's manifest, and is missing: nothing leaves the application unless it is listed"],
    ["empty events", { ...base, events: [] }, "redisOutlet: events is the list of event FQNs to send, such as surface.publishes of a surface's manifest, a non-empty array of FQNs, and is empty"],
    ["events holding no FQN", { ...base, events: [PAID, ""] }, "redisOutlet: events is the list of event FQNs to send, such as surface.publishes of a surface's manifest, a non-empty array of FQNs, and is an array holding something that is not an FQN"],
    ["events that are no array", { ...base, events: PAID }, `redisOutlet: events is the list of event FQNs to send, such as surface.publishes of a surface's manifest, a non-empty array of FQNs, and is "billing.InvoicePaid"`],
    ["no maxLength", { ...base, maxLength: undefined }, "redisOutlet: maxLength is the approximate number of entries the stream keeps (XADD MAXLEN ~), a whole number of 1 or more, and is missing: Mesh does not choose how long another system keeps its events"],
    ["a maxLength of 0", { ...base, maxLength: 0 }, "redisOutlet: maxLength is the approximate number of entries the stream keeps (XADD MAXLEN ~), a whole number of 1 or more, and is 0"],
    ["a fractional maxLength", { ...base, maxLength: 1.5 }, "redisOutlet: maxLength is the approximate number of entries the stream keeps (XADD MAXLEN ~), a whole number of 1 or more, and is 1.5"],
    ["a negative after", { ...base, after: -1 }, "redisOutlet: after is the position a first open starts from, a whole number, and is -1"],
    ["an onError that is no function", { ...base, onError: "log" }, `redisOutlet: onError is the function called with each Redis error and with the reason the outlet stopped, and is "log"`],
  ])("%s is a FrameworkError", async (_what, options, message) => {
    const { binding } = await freshBinding(project());
    expect(await rejection(redisOutlet(binding, options as RedisOutletOptions))).toEqual(new FrameworkError(message));
  });

  test("an event the domain does not declare is refused, naming the nearest declared FQN, before Redis is reached", async () => {
    const { binding } = await freshBinding(project());
    // The URL names no server: the check comes first.
    const options = { ...base, url: "redis://127.0.0.1:1" };
    expect(await rejection(redisOutlet(binding, { ...options, events: ["billing.InvoicePayed"] }))).toEqual(new FrameworkError(
      `redisOutlet: events lists "billing.InvoicePayed", which is not a declared event: did you mean ${PAID}? The project declares ${DRAFTED}, ${PAID}`));
    expect(await rejection(redisOutlet(binding, { ...options, events: [PAID, "shipping.Parcel"] }))).toEqual(new FrameworkError(
      `redisOutlet: events lists "shipping.Parcel", which is not a declared event. The project declares ${DRAFTED}, ${PAID}`));
  });

  test("a surface manifest's publishes is a valid events list", async () => {
    expect(project().publishes).toEqual([PAID]);
    const { binding } = await freshBinding(project());
    // Past the options and declared-event checks, the call reaches the (absent) server.
    const error = await rejection(redisOutlet(binding, { ...base, url: "redis://127.0.0.1:1", events: project().publishes }));
    expect(error).toBeInstanceOf(FrameworkError);
    expect((error as Error).message).toStartWith("redisOutlet: the Redis server at 127.0.0.1:1 did not answer: ");
  });

  test("a server that does not answer rejects the call, naming host and port only, never the password", async () => {
    const { binding } = await freshBinding(project());
    const error = await rejection(redisOutlet(binding, { ...base, url: "redis://user:hunter2@127.0.0.1:1" }));
    expect(error).toBeInstanceOf(FrameworkError);
    expect((error as Error).message).toStartWith("redisOutlet: the Redis server at 127.0.0.1:1 did not answer: ");
    expect((error as Error).message).not.toContain("hunter2");
    // Nothing was opened: the subscription row was never written.
    expect(await listSubscriptions(binding)).toEqual([]);
  });

  test("a Redis URL that Bun's client refuses when it is made is a FrameworkError too", async () => {
    const { binding } = await freshBinding(project());
    const error = await rejection(redisOutlet(binding, { ...base, url: "redis+unix://h" }));
    expect(error).toBeInstanceOf(FrameworkError);
    expect((error as Error).message).toStartWith("redisOutlet: the Redis server at h did not answer: Expected unix socket path");
  });

  test("a value bind() did not make is refused", async () => {
    expect(await rejection(redisOutlet({} as never, base))).toEqual(new FrameworkError("Not a binding made by bind()"));
  });
});

describeServer("redisOutlet against Redis", () => {
  let client: RedisClient;
  const streams: string[] = [];
  const key = (what: string) => { const stream = streamKey(what); streams.push(stream); return stream; };
  beforeAll(async () => { client = await redis(); });
  afterAll(async () => {
    if (streams.length) await client.send("DEL", streams);
    client.close();
  });

  test("only the listed events reach the stream, as <position>-0 entries in order, with the documented fields and no metadata", async () => {
    const { binding, paid, draft } = await freshBinding(project());
    const stream = key("format");
    const outlet = await redisOutlet(binding, { url: redisUrl!, stream, events: project().publishes, maxLength: 1000 });
    expect(outlet.name).toBe(`outlet:redis:${stream}`);
    expect(Object.isFrozen(outlet)).toBe(true);
    const first = await paid();
    await draft();
    const second = await paid();
    await binding.deliver();
    await until(async () => (await entries(client, stream)).length === 2, "two entries are in the stream");
    const page = await readEvents(FRAME, binding, { names: [PAID] });
    const sent = await entries(client, stream);
    expect(sent.map((entry) => entry.id)).toEqual(page.events.map((event) => `${event.position}-0`));
    expect(sent.map((entry) => JSON.parse(entry.fields.payload!).invoiceId)).toEqual([first, second]);
    const [event] = page.events;
    expect(sent[0]!.fields).toEqual({
      id: event!.id,
      name: PAID,
      position: String(event!.position),
      occurredAt: event!.occurredAt.toISOString(),
      causedBy: "",
      entity: "billing.Invoice",
      action: "pay",
      key: JSON.stringify({ id: first }),
      payload: JSON.stringify(event!.payload),
    });
    expect(JSON.parse(sent[0]!.fields.payload!)).toEqual({ invoiceId: first, amount: 42, paidAt: event!.occurredAt.toISOString() });
    // The last row, an InvoicePaid, was acknowledged, and with it every skipped InvoiceDrafted below it.
    await until(async () => (await position(binding, outlet.name)) === page.highest, "the outlet acknowledged the last row");
    expect(await outletConnections(client, stream)).toBe(1);
    await outlet.close();
    expect(await outlet.done).toBeNull();
    // close() closed the outlet's client: the server no longer lists its connection.
    await until(async () => (await outletConnections(client, stream)) === 0, "the outlet's connection is closed");
  });

  test("by default a first open starts now: an event published before it is not sent", async () => {
    const { binding, paid } = await freshBinding(project());
    const stream = key("now");
    await paid();
    const outlet = await redisOutlet(binding, { url: redisUrl!, stream, events: [PAID], maxLength: 1000 });
    const second = await paid();
    await binding.deliver();
    await until(async () => (await position(binding, outlet.name)) === 4, "the outlet acknowledged the second InvoicePaid");
    expect((await entries(client, stream)).map((entry) => JSON.parse(entry.fields.payload!).invoiceId)).toEqual([second]);
    await outlet.close();
  });

  test("skipped rows are acknowledged every 100, and the outbox deletes them under until-delivered", async () => {
    const { binding, draft, layer } = await freshBinding(project());
    const outlet = await redisOutlet(binding, { url: redisUrl!, stream: key("skips"), events: [PAID], maxLength: 1000 });
    for (let i = 0; i < 150; i++) await draft();
    await binding.deliver();
    await until(async () => (await position(binding, outlet.name)) === 100, "the first hundred skipped rows are acknowledged");
    await binding.deliver();
    expect((await layer.readOutbox!(0, 1000)).rows.map((row) => row.position)[0]).toBe(101);
    // close() acknowledges the 50 still pending.
    await outlet.close();
    expect(await position(binding, outlet.name)).toBe(150);
  });

  test("a few skipped rows and then nothing are acknowledged once the queue goes idle, without close()", async () => {
    const { binding, draft } = await freshBinding(project());
    const outlet = await redisOutlet(binding, { url: redisUrl!, stream: key("idle"), events: [PAID], maxLength: 1000 });
    for (let i = 0; i < 3; i++) await draft();
    await binding.deliver();
    await until(async () => (await position(binding, outlet.name)) === 3, "the idle skipped rows are acknowledged", 4000);
    await outlet.close();
    expect(await outlet.done).toBeNull();
  });

  test("an entry this outbox already wrote (sent, not acknowledged, then a crash) is not written again, and the row is acknowledged", async () => {
    const { binding, paid } = await freshBinding(project());
    const stream = key("replay");
    await paid();
    const [event] = (await readEvents(FRAME, binding, { names: [PAID] })).events;
    // What the outlet wrote before the process died between its XADD and its ack.
    await client.send("XADD", [stream, `${event!.position}-0`, "id", event!.id, "name", PAID]);
    const errors: unknown[] = [];
    const outlet = await redisOutlet(binding, { url: redisUrl!, stream, events: [PAID], maxLength: 1000, after: 0, onError: (e) => errors.push(e) });
    await binding.deliver();
    await until(async () => (await position(binding, outlet.name)) === event!.position, "the row is acknowledged");
    expect((await entries(client, stream)).map((entry) => entry.id)).toEqual([`${event!.position}-0`]);
    expect(errors).toEqual([]);
    await outlet.close();
  });

  test("an outbox reset (a new database on a stream an older one filled) stops the outlet with nothing acknowledged", async () => {
    const stream = key("reset");
    const older = await freshBinding(project());
    const first = await redisOutlet(older.binding, { url: redisUrl!, stream, events: [PAID], maxLength: 1000, after: 0 });
    await older.paid();
    await older.binding.deliver();
    await until(async () => (await entries(client, stream)).length === 1, "the older database sent its event");
    await first.close();
    const [kept] = await entries(client, stream);

    const newer = await freshBinding(project());
    const errors: unknown[] = [];
    const outlet = await redisOutlet(newer.binding, { url: redisUrl!, stream, events: [PAID], maxLength: 1000, after: 0, onError: (e) => errors.push(e) });
    await newer.paid();
    await newer.binding.deliver();
    const reason = await outlet.done;
    const message = `redisOutlet: the stream ${stream} holds entries this outbox did not write (its top id is at or above position 2, and entry 2-0 is the event ${kept!.fields.id} (${PAID})); a restored or reset database, or two applications on one stream key: use a new stream key`;
    expect(reason).toEqual(new FrameworkError(message));
    expect(errors).toEqual([new FrameworkError(message)]);
    expect(await position(newer.binding, outlet.name)).toBe(0);
    expect(await entries(client, stream)).toEqual([kept!]);
    // The stop closed the client without close().
    await until(async () => (await outletConnections(client, stream)) === 0, "the stopped outlet's connection is closed");
    // close() after the end does nothing more.
    await outlet.close();
  });

  test("a stream whose top entry another client wrote above the position stops the outlet: the entry is missing", async () => {
    const { binding, paid } = await freshBinding(project());
    const stream = key("foreign");
    await client.send("XADD", [stream, "1000-0", "from", "elsewhere"]);
    const outlet = await redisOutlet(binding, { url: redisUrl!, stream, events: [PAID], maxLength: 1000, onError: () => undefined });
    await paid();
    await binding.deliver();
    expect(await outlet.done).toEqual(new FrameworkError(
      `redisOutlet: the stream ${stream} holds entries this outbox did not write (its top id is at or above position 2, and entry 2-0 is missing); a restored or reset database, or two applications on one stream key: use a new stream key`));
    expect(await position(binding, outlet.name)).toBe(0);
  });

  test("each XADD carries MAXLEN ~ <maxLength>, so the stream's length is bounded", async () => {
    const proxy = redisProxy(redisUrl!);
    try {
      const { binding, paid } = await freshBinding(project());
      const stream = key("maxlen");
      const outlet = await redisOutlet(binding, { url: proxy.url, stream, events: [PAID], maxLength: 7 });
      await paid();
      await binding.deliver();
      await until(async () => (await entries(client, stream)).length === 1, "the entry is in the stream");
      await outlet.close();
      const resp = (text: string) => `$${Buffer.byteLength(text)}\r\n${text}\r\n`;
      expect(proxy.sent()).toContain(`${resp("XADD")}${resp(stream)}${resp("MAXLEN")}${resp("~")}${resp("7")}${resp("2-0")}`);
    } finally {
      proxy.stop();
    }
  });

  test("Redis away at a send: retried with back-off and reported, never acknowledged before, sent once it is back", async () => {
    const proxy = redisProxy(redisUrl!);
    try {
      const { binding, paid } = await freshBinding(project());
      const stream = key("away");
      const errors: unknown[] = [];
      const outlet = await redisOutlet(binding, { url: proxy.url, stream, events: [PAID], maxLength: 1000, onError: (e) => errors.push(e) });
      proxy.down();
      await paid();
      await binding.deliver();
      await until(() => errors.length >= 1, "a Redis error is reported");
      expect(errors.every((e) => !(e instanceof FrameworkError))).toBe(true);
      expect(await position(binding, outlet.name)).toBe(0);
      expect(await entries(client, stream)).toEqual([]);
      proxy.up();
      await until(async () => (await entries(client, stream)).length === 1, "the entry is sent once Redis is back", 5000);
      await until(async () => (await position(binding, outlet.name)) === 2, "the row is acknowledged after the send");
      await outlet.close();
      expect(await outlet.done).toBeNull();
    } finally {
      proxy.stop();
    }
  }, 15_000);

  test("an overflow while Redis is away reopens the subscription under its name once Redis answers PING", async () => {
    const proxy = redisProxy(redisUrl!);
    try {
      // maxQueue 2 with every row in one page: each reopen is fed the whole backlog above the acknowledged position at
      // once and overflows again, so the outlet keeps reopening and never ends on its own. The gap between the first two
      // overflows here is the PING retry's wait as much as the reopen back-off, which the test after this one pins.
      const { binding, paid } = await freshBinding(project(), { maxQueue: 2 });
      const stream = key("overflow");
      const overflows: number[] = [];
      const errors: unknown[] = [];
      const outlet = await redisOutlet(binding, {
        url: proxy.url, stream, events: [PAID], maxLength: 1000,
        onError: (e) => { errors.push(e); if (e instanceof SubscriptionOverflowError) overflows.push(Date.now()); },
      });
      proxy.down();
      for (let i = 0; i < 4; i++) await paid();
      await binding.deliver();
      await until(() => overflows.length === 1, "the overflow is reported");
      expect(await listSubscriptions(binding)).toEqual([{ name: outlet.name, position: 0 }]);
      proxy.up();
      await until(async () => {
        await binding.deliver().catch(() => undefined);
        return overflows.length >= 2;
      }, "the reopened subscription is fed again", 5000);
      expect(overflows[1]! - overflows[0]!).toBeGreaterThanOrEqual(900);
      expect(errors.every((e) => !(e instanceof FrameworkError))).toBe(true);
      expect(await Promise.race([outlet.done, Bun.sleep(50).then(() => "open")])).toBe("open");
      await outlet.close();
      expect(await outlet.done).toBeNull();
      expect(await position(binding, outlet.name)).toBe(0);
    } finally {
      proxy.stop();
    }
  }, 15_000);

  test("with Redis up, a backlog larger than maxQueue reopens after a back-off that doubles, never in a tight loop", async () => {
    // Redis answers throughout, so the waits between overflows can come only from the reopen back-off: every reopen is
    // fed the whole backlog above position 0 in one page and overflows before it acknowledges anything.
    const { binding, paid } = await freshBinding(project(), { maxQueue: 2 });
    for (let i = 0; i < 4; i++) await paid();
    const overflows: number[] = [];
    const errors: unknown[] = [];
    const outlet = await redisOutlet(binding, {
      url: redisUrl!, stream: key("backoff"), events: [PAID], maxLength: 1000, after: 0,
      onError: (e) => { errors.push(e); if (e instanceof SubscriptionOverflowError) overflows.push(Date.now()); },
    });
    await until(async () => {
      await binding.deliver().catch(() => undefined);
      return overflows.length >= 3;
    }, "three overflows", 8000);
    expect(errors.every((e) => e instanceof SubscriptionOverflowError)).toBe(true);
    expect(overflows[1]! - overflows[0]!).toBeGreaterThanOrEqual(900);
    expect(overflows[2]! - overflows[1]!).toBeGreaterThanOrEqual(1900);
    await outlet.close();
    expect(await outlet.done).toBeNull();
    expect(await position(binding, outlet.name)).toBe(0);
  }, 15_000);

  test("under started delivery the bus feeds it, and the delivery's stop ends it with null and closes the client", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mesh-redis-outlet-"));
    try {
      const { binding, paid } = await freshBinding(project(), { pollInterval: 20 }, join(dir, "app.db"));
      const delivery = await binding.startDelivery();
      const stream = key("started");
      const outlet = await redisOutlet(binding, { url: redisUrl!, stream, events: [PAID], maxLength: 1000 });
      await paid();
      await until(async () => (await entries(client, stream)).length === 1, "the started bus fed the outlet");
      expect(await outletConnections(client, stream)).toBe(1);
      await delivery.stop();
      expect(await outlet.done).toBeNull();
      // The delivery's stop closed the client without close().
      await until(async () => (await outletConnections(client, stream)) === 0, "the outlet's connection is closed");
      await outlet.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("two outlets on one stream in one process are refused: one row cannot have two readers", async () => {
    const { binding } = await freshBinding(project());
    const stream = key("twice");
    const outlet = await redisOutlet(binding, { url: redisUrl!, stream, events: [PAID], maxLength: 1000 });
    expect(await rejection(redisOutlet(binding, { url: redisUrl!, stream, events: [PAID], maxLength: 1000 }))).toEqual(new FrameworkError(
      `A subscription named "outlet:redis:${stream}" is open in this process already: two readers acknowledging under one row would pass each other's rows`));
    await outlet.close();
  });

  test("a reopen under the same stream resumes from what was acknowledged, with a different events list", async () => {
    const { binding, paid, draft } = await freshBinding(project());
    const stream = key("reopen");
    const first = await redisOutlet(binding, { url: redisUrl!, stream, events: [PAID], maxLength: 1000 });
    await paid();
    await binding.deliver();
    await until(async () => (await position(binding, first.name)) === 2, "the first open acknowledged its row");
    await first.close();
    await draft();
    // A surface that added an event to publishes reopens the same row: the filter lives in the callback, not the row.
    const second = await redisOutlet(binding, { url: redisUrl!, stream, events: [PAID, DRAFTED], maxLength: 1000 });
    await binding.deliver();
    await until(async () => (await entries(client, stream)).length === 2, "the reopened outlet sent the new row");
    expect((await entries(client, stream)).map((entry) => entry.fields.name)).toEqual([PAID, DRAFTED]);
    await second.close();
  });

  test("under binding.deliver() only, a process that closes its outlet exits: no timer outlives the handle", async () => {
    const worker = Bun.spawn([process.execPath, join(import.meta.dir, "exit-worker.ts"), project().root, redisUrl!, key("exit")], { stdout: "pipe", stderr: "pipe" });
    const exited = await Promise.race([worker.exited, Bun.sleep(8000).then(() => "still running")]);
    if (exited === "still running") worker.kill();
    expect({ exited, stderr: await new Response(worker.stderr).text() }).toEqual({ exited: 0, stderr: "" });
    expect(await new Response(worker.stdout).text()).toBe("sent 1\n");
  }, 15_000);
});
