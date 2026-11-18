// PROTOCOL.md §8: connection lifetime owns streams; autonomous failure is a disconnect, not a new notification.
import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { createSchema, sqlite } from "@meshfw/data-sqlite";
import { serve, type Call, type Connection, type Server } from "@meshfw/jsonrpc";
import { CursorAheadError, type BusCore, type Delivery, type DeliveryOperations, type EventBus } from "@meshfw/runtime";
import { bind, tables } from "#mesh";
import { Client, gate, socketDir } from "../../../packages/jsonrpc/test/client.ts";
import { bootstrap } from "../src/daemon/bootstrap";
import { wireError } from "../src/rpc/errors";
import { attachEventLog } from "../src/rpc/event-log";
import { closeAll, closeSubscription, openSubscription } from "../src/rpc/subscriptions";
import { events } from "./world";

let dir: Awaited<ReturnType<typeof socketDir>>;
let db: ReturnType<typeof sqlite>;
let server: Server;
let core: BusCore;
let delivery: Delivery;
let connection: Connection;
let binding: ReturnType<typeof bind>;
const clients: Client[] = [];

beforeEach(async () => {
  dir = await socketDir();
  db = sqlite({ file: ":memory:" });
  await createSchema(db, tables);
  // A manually driven real bus/core: no poll timer, and the test can overflow just one stream deterministically.
  const bus: EventBus = {
    manifest: { adapter: "subscription-test", capabilities: ["ordered-delivery", "replay", "subscribe"] },
    create(value) {
      core = value;
      return { async start() {}, async stop() {}, async deliver() {} };
    },
  };
  binding = bind(db, { events: { ...events, bus } });
  attachEventLog({ binding });
  await bootstrap(binding);
  delivery = await binding.startDelivery();
  server = await serve({
    socket: dir.path(), binding,
    context: (call) => { connection = call.connection; return null; },
    methods: {
      subscribe: { run: (params, _context, call) => openSubscription({ after: Number(params.after) }, call.connection) },
      unsubscribe: { run: (params) => closeSubscription(String(params.subscriptionId)) },
    },
  });
});

afterEach(async () => {
  for (const client of clients.splice(0)) client.end();
  await server?.close();
  await closeAll();
  await delivery?.stop();
  attachEventLog(undefined);
  await db?.close();
  await dir?.remove();
});

async function connect() {
  const client = await Client.open(server.socket);
  clients.push(client);
  return client;
}

async function subscribe(client: Client, after: number, id = 1): Promise<string> {
  client.send({ jsonrpc: "2.0", id, method: "subscribe", params: { after } });
  const answer = await client.next();
  expect(answer.error).toBeUndefined();
  expect(answer.id).toBe(id);
  return answer.result.subscriptionId;
}

async function rows() {
  // The sqlite transaction exposes the optional delivery contract because createSchema installed its core tables.
  return db.transaction((tx) => (tx as typeof tx & DeliveryOperations).readSubscriptionProgress());
}

test("connection close ends its subscription in the close hook, without waiting for a sweep", async () => {
  const client = await connect();
  const id = await subscribe(client, 3);
  expect(core.subscriptions()).toHaveLength(1);
  const closed = gate();
  // Registered after openSubscription's hook: by this hook, synchronous stream teardown has already happened.
  connection.onClose(() => { closed.resolve(); });
  client.end();
  await closed.promise;
  expect(core.subscriptions()).toHaveLength(0);
  await closeAll(); // Wait for the hook's asynchronous row removal, not for a timer.
  expect((await rows()).map((row) => row.name)).not.toContain(id);
});

test("one overflowing stream disconnects the client, ends both subscriptions, and both cursors can resume", async () => {
  const client = await connect();
  const first = await subscribe(client, 0);
  const second = await subscribe(client, 1, 2);
  expect(core.subscriptions()).toHaveLength(2);
  const log = spyOn(console, "error").mockImplementation(() => {});
  try {
    const stream = core.subscriptions().find((entry) => entry.name === first)!;
    await stream.feed(await core.rows(0, 10), { maxQueue: 1 });
    await client.closed();
    expect(connection.closed).toBe(true);
    expect(core.subscriptions()).toHaveLength(0);
    await closeAll();
    expect((await rows()).filter((row) => row.name === first || row.name === second)).toEqual([]);
    expect(log.mock.calls.some((call) => String(call[0]).includes("ended on its own"))).toBe(true);

    const resumed = await connect();
    const a = await subscribe(resumed, 0);
    const b = await subscribe(resumed, 1, 4);
    for (const stream of core.subscriptions()) await stream.feed(await core.rows(stream.cursor, 10));
    const notifications = [await resumed.next(), await resumed.next(), await resumed.next(), await resumed.next(), await resumed.next()];
    expect(notifications.every((line) => line.method === "events.event" && !("id" in line))).toBe(true);
    expect(notifications.filter((line) => line.params.subscriptionId === a).map((line) => line.params.event.seq)).toEqual([1, 2, 3]);
    expect(notifications.filter((line) => line.params.subscriptionId === b).map((line) => line.params.event.seq)).toEqual([2, 3]);
    expect(connection.closed).toBe(false);
  } finally { log.mockRestore(); }
});

test("teardown still closes the stream when the event log was detached", async () => {
  const client = await connect();
  const id = await subscribe(client, 3);
  expect(core.subscriptions()).toHaveLength(1);
  attachEventLog(undefined);
  await expect(closeSubscription(id)).rejects.toThrow();
  expect(core.subscriptions()).toHaveLength(0);
});

test("unsubscribe ends only its own stream and keeps the connection and other subscription open", async () => {
  const client = await connect();
  const first = await subscribe(client, 3);
  const second = await subscribe(client, 3, 2);
  client.send({ jsonrpc: "2.0", id: 3, method: "unsubscribe", params: { subscriptionId: first } });
  expect((await client.next()).result).toEqual({ ok: true });
  expect(core.subscriptions().map((entry) => entry.name)).toEqual([second]);
  expect(connection.closed).toBe(false);
  const closed = gate();
  connection.onClose(() => { closed.resolve(); });
  client.end();
  await closed.promise;
  expect(core.subscriptions()).toHaveLength(0);
});

// `src/rpc/errors.ts` maps a cursor above the log's head for events.read or events.subscribe; the read side is
// `events.test.ts`. A reconnecting client with a cursor past the head gets -32602 on `after`, and no stream is left open.
test("a subscription after the log's head is refused CursorAheadError, wired as -32602 on after, and opens no stream", async () => {
  const client = await connect();
  await subscribe(client, 0);
  const head = (await core.rows(0, 1_000)).highest;
  const before = core.subscriptions().map((entry) => entry.name);
  // As the server runs a method: inside the binding.
  const error = await binding.run(() => openSubscription({ after: head + 5 }, connection)).catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(CursorAheadError);
  const wired = wireError(error, { method: "events.subscribe", id: 1, params: { after: head + 5 } } as unknown as Call);
  expect(wired).toMatchObject({ code: -32602, message: "invalid_params", data: { phase: "shape", failures: [{ check: "schema", details: { path: ["after"], head } }] } });
  expect(core.subscriptions().map((entry) => entry.name)).toEqual(before);
  // The legal neighbour: a cursor at the head opens a stream.
  await binding.run(() => openSubscription({ after: head }, connection));
  expect(core.subscriptions()).toHaveLength(before.length + 1);
});

