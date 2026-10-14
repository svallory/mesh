import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { AsyncLocalStorage } from "node:async_hooks";
import { existsSync, lstatSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { FrameworkError, type StandardSchemaV1 } from "@meshfw/runtime";
import { z } from "zod";
import { codes, RpcError, serve, type Call, type MethodTable, type ServeOptions, type Server } from "../src/index.ts";
import { removeOwnSocket } from "../src/server.ts";
import { Client, exchange, gate, socketDir } from "./client.ts";

let dir: Awaited<ReturnType<typeof socketDir>>;
const servers: Server[] = [];
const clients: Client[] = [];
let logged: { message: string; error: unknown }[];

beforeEach(async () => {
  dir = await socketDir();
  logged = [];
});

afterEach(async () => {
  for (const client of clients.splice(0)) client.end();
  await Promise.all(servers.splice(0).map((server) => server.close()));
  await dir.remove();
});

/** Starts a server on a fresh socket, logging into `logged`. */
async function start<C = null, T extends Record<string, unknown> = Record<string, unknown>>(
  methods: ServeOptions<C, T>["methods"],
  options: Partial<ServeOptions<C, T>> = {},
): Promise<Server> {
  const server = await serve<C, T>({
    socket: dir.path(),
    methods,
    context: () => null as C,
    log: (message, error) => logged.push({ message, error }),
    ...options,
  });
  servers.push(server);
  return server;
}

async function connect(server: Server = servers[0]!): Promise<Client> {
  const client = await Client.open(server.socket);
  clients.push(client);
  return client;
}

/** The single response to one request. */
async function ask(client: Client, method: string, params?: unknown, id: string | number = 1): Promise<any> {
  client.send(params === undefined ? { jsonrpc: "2.0", id, method } : { jsonrpc: "2.0", id, method, params });
  return client.next();
}

const echo: MethodTable<null> = { echo: { run: (params) => params } };

describe("framing", () => {
  test("one line in gives one line out, echoing a string or a number id", async () => {
    const client = await connect(await start(echo));
    expect(await ask(client, "echo", { a: 1 }, "abc")).toEqual({ jsonrpc: "2.0", id: "abc", result: { a: 1 } });
    expect(await ask(client, "echo", { a: 2 }, 7)).toEqual({ jsonrpc: "2.0", id: 7, result: { a: 2 } });
  });

  test("a request split across three writes, inside a multi-byte character, is read whole", async () => {
    const client = await connect(await start(echo));
    const line = new TextEncoder().encode('{"jsonrpc":"2.0","id":1,"method":"echo","params":{"word":"café €"}}\n');
    const first = line.indexOf(0xc3) + 1;
    const second = line.indexOf(0xe2) + 1;
    client.write(line.subarray(0, first));
    await Bun.sleep(10);
    client.write(line.subarray(first, second));
    await Bun.sleep(10);
    client.write(line.subarray(second));
    expect(await client.next()).toEqual({ jsonrpc: "2.0", id: 1, result: { word: "café €" } });
  });

  test("two requests in one write are both answered", async () => {
    const client = await connect(await start(echo));
    client.write('{"jsonrpc":"2.0","id":1,"method":"echo","params":{"n":1}}\n{"jsonrpc":"2.0","id":2,"method":"echo","params":{"n":2}}\n');
    const answers = [await client.next(), await client.next()].sort((a, b) => a.id - b.id);
    expect(answers).toEqual([
      { jsonrpc: "2.0", id: 1, result: { n: 1 } },
      { jsonrpc: "2.0", id: 2, result: { n: 2 } },
    ]);
  });

  test("a trailing \\r\\n and blank lines between requests are accepted", async () => {
    const client = await connect(await start(echo));
    client.write('\r\n\n{"jsonrpc":"2.0","id":1,"method":"echo","params":{}}\r\n\n  \n{"jsonrpc":"2.0","id":2,"method":"echo","params":{}}\r\n');
    expect((await client.next()).id).toBe(1);
    expect((await client.next()).id).toBe(2);
  });

  test("a line over maxLineBytes gets -32700, and the next line on the connection works", async () => {
    const client = await connect(await start(echo, { maxLineBytes: 64 }));
    client.write(`{"jsonrpc":"2.0","id":1,"method":"echo","params":{"pad":"${"x".repeat(100)}"}}\n`);
    expect(await client.next()).toEqual({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
    expect(await ask(client, "echo", {}, 2)).toEqual({ jsonrpc: "2.0", id: 2, result: {} });
  });

  test("a line that is not valid UTF-8 gets -32700", async () => {
    const client = await connect(await start(echo));
    client.write(new Uint8Array([0x7b, 0xff, 0x7d, 0x0a]));
    expect(await client.next()).toEqual({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
  });

  test("a 4 MiB result arrives whole: what the socket does not take at once is written on drain", async () => {
    const big = "x".repeat(4 * 1024 * 1024);
    const client = await connect(await start({ big: { run: () => ({ big }) } }));
    client.send({ jsonrpc: "2.0", id: 1, method: "big" });
    const line = await client.nextLine();
    expect(line.length).toBe(big.length + '{"jsonrpc":"2.0","id":1,"result":{"big":""}}'.length);
    expect(JSON.parse(line).result.big === big).toBe(true);
    // The connection is still in order after the large write.
    expect(await ask(client, "big", undefined, 2).then((answer) => answer.id)).toBe(2);
  });

  test("large and small answers in flight together reach a client that reads late whole, one per line", async () => {
    const server = await start({
      big: { params: z.object({ fill: z.string().length(1), mebibytes: z.number() }), run: ({ fill, mebibytes }) => fill.repeat(mebibytes * 1024 * 1024) },
      small: { run: (_params, _context, call) => call.id },
    });
    const sizes: Record<number, [string, number]> = { 1: ["a", 1], 3: ["b", 2], 5: ["c", 1] };
    const requests = [1, 2, 3, 4, 5, 6].map((id) =>
      JSON.stringify(id in sizes ? { jsonrpc: "2.0", id, method: "big", params: { fill: sizes[id]![0], mebibytes: sizes[id]![1] } } : { jsonrpc: "2.0", id, method: "small" }),
    );
    // The client reads nothing for 200 ms, so the socket's buffer fills and the server queues the rest for its drains.
    const { lines } = await exchange(server.socket, requests.join("\n") + "\n", { readAfterMs: 200, lines: 6 });
    const answers = lines.map((line) => JSON.parse(line));
    expect(answers.map((answer) => answer.id).sort()).toEqual([1, 2, 3, 4, 5, 6]);
    for (const answer of answers) {
      const size = sizes[answer.id];
      if (!size) {
        expect(answer.result).toBe(answer.id);
        continue;
      }
      expect(answer.result.length).toBe(size[1] * 1024 * 1024);
      expect(answer.result === size[0].repeat(size[1] * 1024 * 1024)).toBe(true);
    }
  });
});

describe("a client that shuts down its writing side", () => {
  test("gets every answer, slow ones included, and the server then ends the connection cleanly", async () => {
    let notified = 0;
    const server = await start({
      slow: { run: async () => { await Bun.sleep(100); return "slow"; } },
      fast: { run: () => "fast" },
      note: { run: async () => { await Bun.sleep(150); notified++; } },
    });
    const requests = [
      { jsonrpc: "2.0", id: 1, method: "slow" },
      { jsonrpc: "2.0", id: 2, method: "fast" },
      { jsonrpc: "2.0", method: "note" },
      { jsonrpc: "2.0", id: 3, method: "missing" },
    ];
    const result = await exchange(server.socket, requests.map((request) => JSON.stringify(request) + "\n").join(""), { halfClose: true });
    const answers = result.lines.map((line) => JSON.parse(line));
    // The slow call, answered 100 ms after the client stopped writing, is the last line.
    expect(answers.at(-1)).toEqual({ jsonrpc: "2.0", id: 1, result: "slow" });
    expect(answers.sort((a, b) => a.id - b.id)).toEqual([
      { jsonrpc: "2.0", id: 1, result: "slow" },
      { jsonrpc: "2.0", id: 2, result: "fast" },
      { jsonrpc: "2.0", id: 3, error: { code: -32601, message: "Method not found" } },
    ]);
    // The connection stayed open for the notification too, which ran to its end before the server closed it.
    expect(notified).toBe(1);
    expect({ endedByServer: result.endedByServer, hadError: result.hadError }).toEqual({ endedByServer: true, hadError: false });
  });

  test("gets a large answer whole when it also reads late, and only then is the connection ended", async () => {
    const big = "x".repeat(4 * 1024 * 1024);
    const server = await start({ big: { run: () => big } });
    const result = await exchange(server.socket, '{"jsonrpc":"2.0","id":1,"method":"big"}\n', { halfClose: true, readAfterMs: 150 });
    expect(result.lines).toHaveLength(1);
    expect(JSON.parse(result.lines[0]!).result === big).toBe(true);
    expect({ endedByServer: result.endedByServer, hadError: result.hadError }).toEqual({ endedByServer: true, hadError: false });
  });

  test("with nothing in flight, the connection is ended at once", async () => {
    const server = await start(echo);
    expect(await exchange(server.socket, "", { halfClose: true })).toEqual({ lines: [], endedByServer: true, hadError: false });
    // Shut down only after the answer arrived, when nothing else on the connection would end it.
    const request = '{"jsonrpc":"2.0","id":1,"method":"echo","params":{}}\n';
    expect(await exchange(server.socket, request, { halfClose: true, halfCloseAfter: 1 })).toEqual({
      lines: ['{"jsonrpc":"2.0","id":1,"result":{}}'],
      endedByServer: true,
      hadError: false,
    });
  });
});

describe("the envelope", () => {
  test("a malformed line gets -32700 with id null, and the same connection then answers a valid request", async () => {
    const client = await connect(await start(echo));
    client.write('{"jsonrpc":"2.0","id":1,"method":\n');
    expect(await client.next()).toEqual({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
    expect(await ask(client, "echo", { ok: true }, 2)).toEqual({ jsonrpc: "2.0", id: 2, result: { ok: true } });
  });

  test("an id too large for a number (1e400 parses to Infinity) gets -32600 with id null", async () => {
    const client = await connect(await start(echo));
    for (const id of ["1e400", "-1e400"]) {
      client.write(`{"jsonrpc":"2.0","id":${id},"method":"echo","params":{}}\n`);
      expect(await client.next()).toEqual({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid Request" } });
    }
    expect(await ask(client, "echo", {}, 1e300)).toEqual({ jsonrpc: "2.0", id: 1e300, result: {} });
  });

  test("a batch gets -32600 with id null", async () => {
    const client = await connect(await start(echo));
    client.send([{ jsonrpc: "2.0", id: 1, method: "echo", params: {} }]);
    expect(await client.next()).toEqual({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid Request" } });
  });

  test.each([
    ["no jsonrpc", { id: 1, method: "echo" }, 1],
    ['jsonrpc "1.0"', { jsonrpc: "1.0", id: "a", method: "echo" }, "a"],
    ["a numeric method", { jsonrpc: "2.0", id: 2, method: 5 }, 2],
    ["no method", { jsonrpc: "2.0", id: 3 }, 3],
    ["an object id", { jsonrpc: "2.0", id: { n: 1 }, method: "echo" }, null],
    ["a null id", { jsonrpc: "2.0", id: null, method: "echo" }, null],
    ["a boolean id", { jsonrpc: "2.0", id: true, method: "echo" }, null],
    ["a top-level string", "echo", null],
    ["a top-level number", 42, null],
    ["a top-level null", null, null],
  ])("%s gets -32600, echoing a string or number id", async (_name, message, id) => {
    const client = await connect(await start(echo));
    client.send(message);
    expect(await client.next()).toEqual({ jsonrpc: "2.0", id, error: { code: -32600, message: "Invalid Request" } });
  });

  test("params that are not an object get -32602; absent params arrive as {}", async () => {
    const client = await connect(await start(echo));
    for (const params of [[1, 2], "text", 3, null]) {
      expect(await ask(client, "echo", params)).toEqual({
        jsonrpc: "2.0",
        id: 1,
        error: { code: -32602, message: "Invalid params", data: { issues: [{ message: "params must be an object", path: [] }] } },
      });
    }
    expect(await ask(client, "echo")).toEqual({ jsonrpc: "2.0", id: 1, result: {} });
  });

  test.each(["missing", "toString", "__proto__", "constructor", "hasOwnProperty", "valueOf"])(
    "%s is not a method: -32601",
    async (method) => {
      const client = await connect(await start(echo));
      expect(await ask(client, method, {})).toEqual({ jsonrpc: "2.0", id: 1, error: { code: -32601, message: "Method not found" } });
    },
  );

  test("only the table's own entries are methods, not inherited ones", async () => {
    const inherited = Object.create({ hidden: { run: () => "inherited" } }) as MethodTable<null>;
    const client = await connect(await start(inherited));
    expect((await ask(client, "hidden", {})).error.code).toBe(-32601);
  });
});

describe("ordering", () => {
  test("a call that finishes first is answered first, and responses are matched by id", async () => {
    const slow = gate();
    const client = await connect(await start({
      slow: { run: async () => { await slow.promise; return "slow"; } },
      fast: { run: () => "fast" },
    }));
    client.send({ jsonrpc: "2.0", id: "s", method: "slow", params: {} });
    client.send({ jsonrpc: "2.0", id: "f", method: "fast", params: {} });
    expect(await client.next()).toEqual({ jsonrpc: "2.0", id: "f", result: "fast" });
    slow.resolve();
    expect(await client.next()).toEqual({ jsonrpc: "2.0", id: "s", result: "slow" });
  });

  test("three connections at once are each answered on their own socket", async () => {
    const server = await start(echo);
    const all = await Promise.all([connect(server), connect(server), connect(server)]);
    all.forEach((client, n) => client.send({ jsonrpc: "2.0", id: 1, method: "echo", params: { n } }));
    const answers = await Promise.all(all.map((client) => client.next()));
    expect(answers.map((answer) => answer.result.n)).toEqual([0, 1, 2]);
  });
});

describe("errors", () => {
  test("a thrown RpcError passes through with its code, message and data", async () => {
    const client = await connect(await start({ fail: { run: () => { throw new RpcError(-32010, "not_implemented", { phase: "shape" }); } } }));
    expect(await ask(client, "fail", {})).toEqual({
      jsonrpc: "2.0",
      id: 1,
      error: { code: -32010, message: "not_implemented", data: { phase: "shape" } },
    });
    expect(logged).toEqual([]);
  });

  test("a thrown Error gives -32603 with no data, and one log call", async () => {
    const boom = new Error("secret detail");
    const client = await connect(await start({ fail: { run: async () => { throw boom; } } }));
    expect(await ask(client, "fail", {})).toEqual({ jsonrpc: "2.0", id: 1, error: { code: -32603, message: "Internal error" } });
    expect(logged).toEqual([{ message: "fail failed", error: boom }]);
  });

  test("the error option replaces the error object, and sees the server's own -32601 and -32602", async () => {
    const seen: unknown[] = [];
    const client = await connect(await start(
      {
        fail: { run: () => { throw new Error("boom"); } },
        typed: { params: z.object({ name: z.string() }), run: () => "ok" },
      },
      {
        error(error, call) {
          seen.push(error);
          if (error instanceof RpcError) return { code: error.code, message: "mapped", data: { method: call.method, original: error.data ?? null } };
          return { code: -32003, message: "rule_violation", data: { reason: (error as Error).message } };
        },
      },
    ));
    expect((await ask(client, "fail", {})).error).toEqual({ code: -32003, message: "rule_violation", data: { reason: "boom" } });
    expect((await ask(client, "nope", {})).error).toEqual({ code: -32601, message: "mapped", data: { method: "nope", original: null } });
    expect((await ask(client, "typed", { name: 1 })).error).toEqual({
      code: -32602,
      message: "mapped",
      data: { method: "typed", original: { issues: [{ message: expect.any(String), path: ["name"] }] } },
    });
    expect(seen.map((error) => (error instanceof RpcError ? error.code : "Error"))).toEqual(["Error", -32601, -32602]);
    expect(logged).toEqual([]);
  });

  test("an error option that throws, or returns something that is not an error object, gives -32603 and a log line", async () => {
    const results: unknown[] = [{ code: "x", message: "m" }, { code: 1.5, message: "m" }, { code: 1 }, null, Promise.resolve({ code: 1, message: "m" })];
    let call = 0;
    const failure = new Error("run failed");
    const hookError = new Error("hook failed");
    const client = await connect(await start(
      { fail: { run: () => { throw failure; } } },
      {
        error() {
          if (call++ === 0) throw hookError;
          return results[call - 2] as never;
        },
      },
    ));
    for (let n = 0; n <= results.length; n++) {
      expect((await ask(client, "fail", {})).error).toEqual({ code: -32603, message: "Internal error" });
    }
    expect(logged[0]).toEqual({ message: "the error option threw while mapping a failure of fail", error: hookError });
    expect(logged.slice(1).map((entry) => entry.error)).toEqual(results.map(() => failure));
    expect(logged).toHaveLength(results.length + 1);
  });

  test("an error option that rethrows the error gives -32603, logged as the method's failure", async () => {
    const failure = new Error("unexpected");
    const client = await connect(await start({ fail: { run: () => { throw failure; } } }, { error(error) { throw error; } }));
    expect((await ask(client, "fail", {})).error).toEqual({ code: -32603, message: "Internal error" });
    expect(logged).toEqual([{ message: "fail failed", error: failure }]);
  });

  test.each([
    ["a BigInt", () => ({ n: 1n })],
    ["a cycle", () => { const a: Record<string, unknown> = {}; a.self = a; return a; }],
    ["a function", () => () => 1],
    ["a symbol", () => Symbol("s")],
  ])("a result with no JSON form (%s) gives -32603 and a log line", async (_name, run) => {
    const client = await connect(await start({ bad: { run } }));
    expect(await ask(client, "bad", {})).toEqual({ jsonrpc: "2.0", id: 1, error: { code: -32603, message: "Internal error" } });
    expect(logged).toHaveLength(1);
  });

  test("an undefined result is sent as null", async () => {
    const client = await connect(await start({ nothing: { run: () => undefined } }));
    expect(await ask(client, "nothing", {})).toEqual({ jsonrpc: "2.0", id: 1, result: null });
  });

  test("error data with no JSON form gives -32603 and a log line", async () => {
    const client = await connect(await start({ fail: { run: () => { throw new RpcError(-32003, "rule_violation", { n: 10n }); } } }));
    expect(await ask(client, "fail", {})).toEqual({ jsonrpc: "2.0", id: 1, error: { code: -32603, message: "Internal error" } });
    expect(logged).toHaveLength(1);
  });
});

describe("messages", () => {
  const custom = {
    [codes.parseError]: "parse_error",
    [codes.invalidRequest]: "invalid_request",
    [codes.methodNotFound]: "method_not_found",
    [codes.invalidParams]: "invalid_params",
    [codes.internalError]: "internal_error",
  };
  const failing = {
    ...echo,
    typed: { params: z.object({ name: z.string() }), run: () => "ok" },
    fail: { run: () => { throw new Error("boom"); } },
    bigint: { run: () => 1n },
    badData: { run: () => { throw new RpcError(-32003, "rule_violation", { n: 1n }); } },
  };

  test("each code the package answers with itself carries the message the messages option gives it", async () => {
    const client = await connect(await start(failing, { messages: custom, maxLineBytes: 256 }));
    const errorOf = async (line: string | Uint8Array) => {
      client.write(line);
      return (await client.next()).error;
    };
    expect(await errorOf("not json\n")).toEqual({ code: -32700, message: "parse_error" });
    expect(await errorOf(`{"pad":"${"x".repeat(300)}"}\n`)).toEqual({ code: -32700, message: "parse_error" });
    expect(await errorOf(new Uint8Array([0x7b, 0xff, 0x7d, 0x0a]))).toEqual({ code: -32700, message: "parse_error" });
    expect(await errorOf("[]\n")).toEqual({ code: -32600, message: "invalid_request" });
    expect(await errorOf('{"id":1,"method":"echo"}\n')).toEqual({ code: -32600, message: "invalid_request" });
    expect((await ask(client, "missing", {})).error).toEqual({ code: -32601, message: "method_not_found" });
    expect((await ask(client, "echo", [1])).error).toEqual({
      code: -32602,
      message: "invalid_params",
      data: { issues: [{ message: "params must be an object", path: [] }] },
    });
    expect((await ask(client, "typed", { name: 1 })).error).toMatchObject({ code: -32602, message: "invalid_params" });
    for (const method of ["fail", "bigint", "badData"]) {
      expect((await ask(client, method, {})).error).toEqual({ code: -32603, message: "internal_error" });
    }
    expect(logged).toHaveLength(3);
  });

  test("the error option receives -32601 and -32602 with those messages, and its own failures are answered with -32603's", async () => {
    const seen: string[] = [];
    let mode: "map" | "throw" | "malformed" = "map";
    const client = await connect(await start(failing, {
      messages: custom,
      error(error) {
        if (mode === "throw") throw new Error("hook failed");
        if (mode === "malformed") return { code: "x" } as never;
        seen.push((error as Error).message);
        return { code: -32000, message: "mapped" };
      },
    }));
    await ask(client, "missing", {});
    await ask(client, "typed", {});
    expect(seen).toEqual(["method_not_found", "invalid_params"]);
    mode = "throw";
    expect((await ask(client, "fail", {})).error).toEqual({ code: -32603, message: "internal_error" });
    mode = "malformed";
    expect((await ask(client, "fail", {})).error).toEqual({ code: -32603, message: "internal_error" });
  });

  test("a code the option leaves out keeps JSON-RPC's message", async () => {
    const client = await connect(await start(failing, { messages: { [codes.methodNotFound]: "method_not_found" } }));
    expect((await ask(client, "missing", {})).error).toEqual({ code: -32601, message: "method_not_found" });
    expect((await ask(client, "fail", {})).error).toEqual({ code: -32603, message: "Internal error" });
    client.write("not json\n");
    expect((await client.next()).error).toEqual({ code: -32700, message: "Parse error" });
  });
});

describe("parameters and context", () => {
  test("a Standard Schema failure gives -32602 listing each issue, and neither run nor the context factory is called", async () => {
    let ran = 0;
    let built = 0;
    const client = await connect(await start(
      { create: { params: z.object({ name: z.string(), tags: z.array(z.string()) }), run: () => ran++ } },
      { context: () => { built++; return null; } },
    ));
    const answer = await ask(client, "create", { name: 3, tags: ["a", 4] });
    expect(answer.error.code).toBe(codes.invalidParams);
    expect(answer.error.message).toBe("Invalid params");
    expect(answer.error.data.issues.map((issue: { path: unknown }) => issue.path)).toEqual([["name"], ["tags", 1]]);
    expect(answer.error.data.issues.every((issue: { message: unknown }) => typeof issue.message === "string")).toBe(true);
    expect({ ran, built }).toEqual({ ran: 0, built: 0 });
  });

  test("run receives the schema's output, not the raw params", async () => {
    const client = await connect(await start({
      count: { params: z.object({ n: z.coerce.number() }).transform(({ n }) => ({ doubled: n * 2 })), run: (params) => params },
    }));
    expect((await ask(client, "count", { n: "21" })).result).toEqual({ doubled: 42 });
  });

  test("the context factory is called once per request, after validation, and run receives what it returns", async () => {
    const calls: { call: Call; params: unknown }[] = [];
    const client = await connect(await start<{ actor: string }>(
      { whoami: { params: z.object({ actor: z.string() }), run: (params, context, call) => ({ context, sameCall: call === calls.at(-1)!.call, params }) } },
      { context: (call, params) => { calls.push({ call, params }); return { actor: (params as { actor: string }).actor.toUpperCase() }; } },
    ));
    expect((await ask(client, "whoami", { actor: "ana" }, 5)).result).toEqual({ context: { actor: "ANA" }, sameCall: true, params: { actor: "ana" } });
    expect((await ask(client, "whoami", { actor: "bo" }, 6)).result.context).toEqual({ actor: "BO" });
    expect(calls).toHaveLength(2);
    expect(calls[0]!.call.method).toBe("whoami");
    expect(calls[0]!.call.id).toBe(5);
    expect(calls[0]!.call.params).toEqual({ actor: "ana" });
    expect(Object.isFrozen(calls[0]!.call)).toBe(true);
  });

  test("a context factory's throw is mapped like run's", async () => {
    const denied = new RpcError(-32001, "permission_denied");
    const broken = new Error("lookup failed");
    let throwing: Error = denied;
    let ran = 0;
    const client = await connect(await start({ act: { run: () => ran++ } }, { context: async () => { throw throwing; } }));
    expect((await ask(client, "act", {})).error).toEqual({ code: -32001, message: "permission_denied" });
    throwing = broken;
    expect((await ask(client, "act", {})).error).toEqual({ code: -32603, message: "Internal error" });
    expect(logged).toEqual([{ message: "act failed", error: broken }]);
    expect(ran).toBe(0);
  });

  test("binding.run wraps both the context factory and run", async () => {
    const store = new AsyncLocalStorage<string>();
    let wrapped = 0;
    const seen: (string | undefined)[] = [];
    const client = await connect(await start(
      { act: { run: async () => { await Bun.sleep(1); seen.push(store.getStore()); return "done"; } } },
      {
        binding: { run: (fn) => { wrapped++; return store.run("bound", fn); } },
        context: () => { seen.push(store.getStore()); return null; },
      },
    ));
    expect((await ask(client, "act", {})).result).toBe("done");
    expect({ wrapped, seen }).toEqual({ wrapped: 1, seen: ["bound", "bound"] });
  });
});

describe("notifications", () => {
  test("a request with no id runs and gets no response; the next request's response is the next line", async () => {
    let ran = 0;
    const client = await connect(await start({ note: { run: () => { ran++; return "ignored"; } }, ...echo }));
    client.send({ jsonrpc: "2.0", method: "note", params: {} });
    client.send({ jsonrpc: "2.0", method: "missing", params: {} });
    client.send({ jsonrpc: "2.0", id: 9, method: "echo", params: { after: true } });
    expect(await client.next()).toEqual({ jsonrpc: "2.0", id: 9, result: { after: true } });
    expect(ran).toBe(1);
    expect(logged).toEqual([]);
  });

  test("a notification whose method fails is logged, and still gets no response", async () => {
    const failure = new Error("note failed");
    const client = await connect(await start({ note: { run: () => { throw failure; } }, ...echo }));
    client.send({ jsonrpc: "2.0", method: "note", params: {} });
    expect(await ask(client, "echo", {}, 2)).toEqual({ jsonrpc: "2.0", id: 2, result: {} });
    expect(logged).toEqual([{ message: "notification note failed", error: failure }]);
  });

  test("connection.notify writes one line with no id", async () => {
    const client = await connect(await start({
      subscribe: { run: (_params, _context, call) => { call.connection.notify("events.event", { seq: 1 }); return { subscribed: true }; } },
    }));
    client.send({ jsonrpc: "2.0", id: 1, method: "subscribe", params: {} });
    const notification = await client.next();
    expect(notification).toEqual({ jsonrpc: "2.0", method: "events.event", params: { seq: 1 } });
    expect(Object.hasOwn(notification, "id")).toBe(false);
    expect(await client.next()).toEqual({ jsonrpc: "2.0", id: 1, result: { subscribed: true } });
  });

  test("connection.notify refuses a missing method name or params that are not a JSON object", async () => {
    const thrown: unknown[] = [];
    const client = await connect(await start({
      bad: {
        run: (_params, _context, { connection }) => {
          for (const args of [["", {}], ["m", null], ["m", [1]], ["m", { n: 1n }]] as const) {
            try {
              connection.notify(args[0], args[1] as never);
            } catch (error) {
              thrown.push(error);
            }
          }
          return thrown.length;
        },
      },
    }));
    expect((await ask(client, "bad", {})).result).toBe(4);
    expect(thrown.every((error) => error instanceof FrameworkError)).toBe(true);
  });

  test("connection.notify on a closed connection does nothing, and closed says so", async () => {
    let connection: Call["connection"] | undefined;
    const server = await start({ keep: { run: (_params, _context, call) => { connection = call.connection; return null; } } });
    const client = await connect(server);
    await ask(client, "keep", {});
    expect(connection!.closed).toBe(false);
    client.end();
    for (let n = 0; n < 50 && !connection!.closed; n++) await Bun.sleep(5);
    expect(connection!.closed).toBe(true);
    expect(() => connection!.notify("late", {})).not.toThrow();
  });
});

describe("lifecycle", () => {
  test("close() holds the connection open until an in-flight call settles and is answered, then ends it and removes the socket file", async () => {
    const running = gate();
    let finished = false;
    const server = await start({ slow: { run: async () => { await running.promise; finished = true; return "late"; } } });
    const client = await connect(server);
    client.send({ jsonrpc: "2.0", id: 1, method: "slow", params: {} });
    await Bun.sleep(10);
    let closed = false;
    const closing = server.close().then(() => (closed = true));
    expect(server.close()).toBe(server.close());
    await Bun.sleep(20);
    expect({ closed, clientClosed: client.isClosed }).toEqual({ closed: false, clientClosed: false });
    running.resolve();
    expect(await client.next()).toEqual({ jsonrpc: "2.0", id: 1, result: "late" });
    await closing;
    await client.closed();
    expect({ finished, closed }).toEqual({ finished: true, closed: true });
    expect(existsSync(server.socket)).toBe(false);
    await expect(Client.open(server.socket)).rejects.toThrow();
  });

  test("a call inside run when close() begins gets its result, and close() resolves after the answer is written", async () => {
    const running = gate();
    const server = await start({ add: { run: async () => { await running.promise; return { committed: true }; } } });
    const client = await connect(server);
    client.send({ jsonrpc: "2.0", id: 9, method: "add", params: {} });
    await Bun.sleep(10);
    const closing = server.close();
    running.resolve();
    // close() resolves only once the answer is handed to the socket, so the line is already on its way.
    await closing;
    expect(await client.next()).toEqual({ jsonrpc: "2.0", id: 9, result: { committed: true } });
    await client.closed();
  });

  test("a call that fails while close() drains still gets its error answer", async () => {
    const running = gate();
    const server = await start({ boom: { run: async () => { await running.promise; throw new RpcError(-32001, "nope"); } } });
    const client = await connect(server);
    client.send({ jsonrpc: "2.0", id: 1, method: "boom", params: {} });
    await Bun.sleep(10);
    const closing = server.close();
    running.resolve();
    expect((await client.next()).error).toMatchObject({ code: -32001, message: "nope" });
    await closing;
  });

  test("a request sent after close() began gets no answer and its method never runs", async () => {
    const running = gate();
    const ran: string[] = [];
    const server = await start({
      slow: { run: async () => { ran.push("slow"); await running.promise; return "done"; } },
      late: { run: () => { ran.push("late"); return "late"; } },
    });
    const client = await connect(server);
    client.send({ jsonrpc: "2.0", id: 1, method: "slow", params: {} });
    await Bun.sleep(10);
    const closing = server.close();
    client.send({ jsonrpc: "2.0", id: 2, method: "late", params: {} });
    client.send({ jsonrpc: "2.0", id: 3, method: "nothing-here", params: {} });
    await Bun.sleep(30);
    running.resolve();
    expect(await client.next()).toEqual({ jsonrpc: "2.0", id: 1, result: "done" });
    await closing;
    await client.closed();
    await expect(client.nextLine()).rejects.toThrow("no line");
    expect(ran).toEqual(["slow"]);
  });

  test("a new connection attempt after close() began fails, while the drain is still running", async () => {
    const running = gate();
    const server = await start({ slow: { run: async () => { await running.promise; return 1; } } });
    const client = await connect(server);
    client.send({ jsonrpc: "2.0", id: 1, method: "slow", params: {} });
    await Bun.sleep(10);
    const closing = server.close();
    await expect(Client.open(server.socket)).rejects.toThrow();
    running.resolve();
    await client.next();
    await closing;
  });

  test("a client that disconnects during the drain does not hang close(), and the other client is still answered", async () => {
    const running = gate();
    const server = await start({ slow: { run: async () => { await running.promise; return "ok"; } } });
    const leaver = await connect(server);
    const stayer = await connect(server);
    leaver.send({ jsonrpc: "2.0", id: 1, method: "slow", params: {} });
    stayer.send({ jsonrpc: "2.0", id: 2, method: "slow", params: {} });
    await Bun.sleep(10);
    const closing = server.close();
    leaver.end();
    await Bun.sleep(20);
    running.resolve();
    expect((await stayer.next()).result).toBe("ok");
    await closing;
    expect(logged).toEqual([]);
  });

  test("a client that half-closes mid-call still gets its answer and does not hang close()", async () => {
    const running = gate();
    const server = await start({ slow: { run: async () => { await running.promise; return "ok"; } } });
    const exchanging = exchange(server.socket, '{"jsonrpc":"2.0","id":1,"method":"slow","params":{}}\n', { halfClose: true });
    await Bun.sleep(20);
    const closing = server.close();
    await Bun.sleep(20);
    running.resolve();
    const seen = await exchanging;
    expect(seen.lines.map((line) => JSON.parse(line).result)).toEqual(["ok"]);
    await closing;
  });

  test("a client that vanished with the call still running does not make close() throw or hang", async () => {
    const running = gate();
    const server = await start({ slow: { run: async () => { await running.promise; return "ok"; } } });
    const client = await connect(server);
    client.send({ jsonrpc: "2.0", id: 1, method: "slow", params: {} });
    await Bun.sleep(10);
    client.end();
    await client.closed();
    const closing = server.close();
    running.resolve();
    await closing;
    expect(logged).toEqual([]);
  });

  test("notifications in flight settle before close() resolves", async () => {
    const running = gate();
    let finished = false;
    const server = await start({ note: { run: async () => { await running.promise; finished = true; } } });
    const client = await connect(server);
    client.send({ jsonrpc: "2.0", method: "note", params: {} });
    await Bun.sleep(10);
    let closed = false;
    const closing = server.close().then(() => (closed = true));
    await Bun.sleep(20);
    expect(closed).toBe(false);
    running.resolve();
    await closing;
    expect(finished).toBe(true);
    await client.closed();
  });

  test("a notification a call sends through its connection while draining is written before the connection ends", async () => {
    const running = gate();
    const server = await start({
      work: { run: async (_params, _context, call) => { await running.promise; call.connection.notify("progress", { done: true }); return "ok"; } },
    });
    const client = await connect(server);
    client.send({ jsonrpc: "2.0", id: 1, method: "work", params: {} });
    await Bun.sleep(10);
    const closing = server.close();
    running.resolve();
    expect(await client.next()).toEqual({ jsonrpc: "2.0", method: "progress", params: { done: true } });
    expect((await client.next()).result).toBe("ok");
    await closing;
  });

  test("two close() calls share one promise, also while the drain runs", async () => {
    const running = gate();
    const server = await start({ slow: { run: async () => { await running.promise; return 1; } } });
    const client = await connect(server);
    client.send({ jsonrpc: "2.0", id: 1, method: "slow", params: {} });
    await Bun.sleep(10);
    const first = server.close();
    const second = server.close();
    expect(second).toBe(first);
    running.resolve();
    await first;
    expect(server.close()).toBe(first);
  });

  test("a stale socket file left by a server that is gone is replaced", async () => {
    const path = dir.path();
    const child = Bun.spawnSync([process.execPath, "-e", `Bun.listen({ unix: ${JSON.stringify(path)}, socket: { data() {} } }); process.exit(0);`]);
    expect(child.exitCode).toBe(0);
    expect(lstatSync(path).isSocket()).toBe(true);
    const client = await connect(await start(echo));
    expect((await ask(client, "echo", { fresh: true })).result).toEqual({ fresh: true });
  });

  test("a socket another server is listening on is refused, and that server keeps working", async () => {
    const first = await start(echo);
    const error = await serve({ socket: first.socket, methods: echo, context: () => null }).catch((error: unknown) => error);
    expect(error).toBeInstanceOf(FrameworkError);
    expect((error as Error).message).toContain("another server is listening");
    const client = await connect(first);
    expect((await ask(client, "echo", { still: "up" })).result).toEqual({ still: "up" });
  });

  test("a regular file or a directory at the path is refused and left untouched", async () => {
    const file = dir.path("file.sock");
    writeFileSync(file, "keep me");
    const folder = dir.path("folder.sock");
    mkdirSync(folder);
    for (const socket of [file, folder]) {
      const error = await serve({ socket, methods: echo, context: () => null }).catch((error: unknown) => error);
      expect(error).toBeInstanceOf(FrameworkError);
      expect((error as Error).message).toContain("is not a socket");
    }
    expect(readFileSync(file, "utf8")).toBe("keep me");
    expect(lstatSync(folder).isDirectory()).toBe(true);
  });

  test("a socket that cannot be listened on rejects with FrameworkError and its cause", async () => {
    const error = await serve({ socket: join(dir.path("missing-dir"), "s.sock"), methods: echo, context: () => null }).catch((error: unknown) => error);
    expect(error).toBeInstanceOf(FrameworkError);
    expect((error as Error).message).toContain("cannot listen on the Unix socket");
    expect((error as Error).cause).toBeDefined();
  });

  test("the socket file is 0600 unless mode says otherwise, and the process's umask is left as it was", async () => {
    const umask = process.umask();
    const first = await start(echo);
    expect(lstatSync(first.socket).mode & 0o777).toBe(0o600);
    const second = await start(echo, { socket: dir.path("group.sock"), mode: 0o660 });
    expect(lstatSync(second.socket).mode & 0o777).toBe(0o660);
    await serve({ socket: join(dir.path("missing-dir"), "s.sock"), methods: echo, context: () => null }).catch(() => {});
    expect(process.umask()).toBe(umask);
    const client = await connect(second);
    expect((await ask(client, "echo", { group: true })).result).toEqual({ group: true });
  });

  test("a socket file removed and taken by another server is not deleted by close()", () => {
    // A server whose file was replaced must leave the replacement alone, so the check compares the file's identity.
    const path = dir.path("taken.sock");
    const original = Bun.listen({ unix: path, socket: { data() {} } });
    const identity = { dev: lstatSync(path).dev, ino: lstatSync(path).ino };
    unlinkSync(path);
    const replacement = Bun.listen({ unix: path, socket: { data() {} } });
    try {
      removeOwnSocket(path, identity, (message) => logged.push({ message, error: undefined }));
      expect(lstatSync(path).isSocket()).toBe(true);
      removeOwnSocket(path, undefined, (message) => logged.push({ message, error: undefined }));
      expect(lstatSync(path).isSocket()).toBe(true);
      removeOwnSocket(path, { dev: lstatSync(path).dev, ino: lstatSync(path).ino }, (message) => logged.push({ message, error: undefined }));
      expect(existsSync(path)).toBe(false);
      // A file already gone is not an error.
      removeOwnSocket(path, identity, (message) => logged.push({ message, error: undefined }));
      expect(logged).toEqual([]);
    } finally {
      original.stop(true);
      replacement.stop(true);
    }
  });

  test("lines that arrive after close() has begun are not run, and a call close() overtakes never reaches its context or run", async () => {
    let server!: Server;
    const reached: string[] = [];
    const closer: StandardSchemaV1<unknown, Record<string, unknown>> = {
      "~standard": {
        version: 1,
        vendor: "test",
        validate: (value) => {
          reached.push("validate first");
          void server.close();
          return { value: value as Record<string, unknown> };
        },
      },
    };
    const spy: StandardSchemaV1<unknown, Record<string, unknown>> = {
      "~standard": { version: 1, vendor: "test", validate: (value) => { reached.push("validate second"); return { value: value as Record<string, unknown> }; } },
    };
    server = await start(
      { first: { params: closer, run: () => reached.push("run first") }, second: { params: spy, run: () => reached.push("run second") } },
      { context: (call) => { reached.push(`context ${call.method}`); return null; } },
    );
    const client = await connect(server);
    client.write('{"jsonrpc":"2.0","id":1,"method":"first","params":{}}\n{"jsonrpc":"2.0","id":2,"method":"second","params":{}}\n');
    await client.closed();
    await server.close();
    expect(reached).toEqual(["validate first"]);
  });

  test("a call whose validation or context factory is still pending when close() begins never reaches the next step", async () => {
    const validating = gate<void>();
    const building = gate<void>();
    const reached: string[] = [];
    const slow: StandardSchemaV1<unknown, Record<string, unknown>> = {
      "~standard": {
        version: 1,
        vendor: "test",
        validate: async (value) => {
          reached.push("validate");
          await validating.promise;
          return { value: value as Record<string, unknown> };
        },
      },
    };
    const server = await start(
      { checked: { params: slow, run: () => reached.push("run checked") }, built: { run: () => reached.push("run built") } },
      {
        context: async (call) => {
          reached.push(`context ${call.method}`);
          if (call.method === "built") await building.promise;
          return null;
        },
      },
    );
    const client = await connect(server);
    client.send({ jsonrpc: "2.0", id: 1, method: "checked", params: {} });
    client.send({ jsonrpc: "2.0", id: 2, method: "built", params: {} });
    while (reached.length < 2) await Bun.sleep(1);
    let closed = false;
    const closing = server.close().then(() => (closed = true));
    await Bun.sleep(20);
    expect(closed).toBe(false);
    validating.resolve();
    building.resolve();
    await closing;
    await client.closed();
    expect(reached.sort()).toEqual(["context built", "validate"]);
    expect(logged).toEqual([]);
  });

  const run = () => null;
  test.each<[string, Record<string, unknown>]>([
    ["no options", { options: null }],
    ["an empty socket path", { socket: "" }],
    ["a socket path that is not a string", { socket: 3 }],
    ["methods that are null", { methods: null }],
    ["methods that are an array", { methods: [] }],
    ["an entry without run", { methods: { a: {} } }],
    ["an entry that is not an object", { methods: { a: run } }],
    ["params that are not a Standard Schema", { methods: { a: { run, params: { parse() {} } } } }],
    ["no context factory", { context: undefined }],
    ["a binding without run", { binding: {} }],
    ["an error option that is not a function", { error: {} }],
    ["a log option that is not a function", { log: "stderr" }],
    ["a zero maxLineBytes", { maxLineBytes: 0 }],
    ["a fractional maxLineBytes", { maxLineBytes: 1.5 }],
    ["a negative maxLineBytes", { maxLineBytes: -1 }],
    ["a negative mode", { mode: -1 }],
    ["a mode over 0o777", { mode: 0o1000 }],
    ["a fractional mode", { mode: 1.5 }],
    ["a mode that is a string", { mode: "600" }],
    ["messages that are null", { messages: null }],
    ["messages that are an array", { messages: [] }],
    ["a message for a code JSON-RPC does not reserve", { messages: { [-32000]: "server_error" } }],
    ["a message for a code given by name", { messages: { parseError: "parse_error" } }],
    ["a message that is not a string", { messages: { [-32700]: 1 } }],
    ["an empty message", { messages: { [-32700]: "" } }],
  ])("serve rejects %s with FrameworkError", async (_name, change) => {
    const options = "options" in change ? change.options : { socket: dir.path(), methods: { a: { run } }, context: () => null, ...change };
    const error = await serve(options as never).catch((error: unknown) => error);
    expect(error).toBeInstanceOf(FrameworkError);
    expect(existsSync(dir.path())).toBe(false);
  });

  test("the server writes nothing to standard output, even when it logs through the default log", async () => {
    const path = dir.path();
    const script = `
      import { serve } from ${JSON.stringify(join(import.meta.dir, "../src/index.ts"))};
      const server = await serve({ socket: ${JSON.stringify(path)}, methods: { fail: { run: () => { throw new Error("boom"); } }, bad: { run: () => 1n } }, context: () => null });
      const lines = [];
      let done;
      const finished = new Promise((resolve) => (done = resolve));
      const client = await Bun.connect({ unix: server.socket, socket: { data(_s, chunk) { lines.push(...new TextDecoder().decode(chunk).split("\\n").filter(Boolean)); if (lines.length === 4) done(); } } });
      client.write('not json\\n{"jsonrpc":"2.0","id":1,"method":"fail","params":{}}\\n{"jsonrpc":"2.0","id":2,"method":"nope"}\\n{"jsonrpc":"2.0","id":3,"method":"bad"}\\n');
      await finished;
      client.end();
      await server.close();
      console.error(JSON.stringify(lines.map((line) => JSON.parse(line).error.code).sort()));
    `;
    const child = Bun.spawnSync([process.execPath, "-e", script], { cwd: import.meta.dir });
    const stderr = child.stderr.toString();
    expect({ exit: child.exitCode, stdout: child.stdout.toString() }).toEqual({ exit: 0, stdout: "" });
    expect(stderr).toContain("@meshfw/jsonrpc: fail failed");
    // A log call with no error object (the result of bad cannot be serialised) goes to standard error too.
    expect(stderr).toContain("@meshfw/jsonrpc: the result of bad has no JSON form");
    expect(stderr).toContain("[-32601,-32603,-32603,-32700]");
  });
});
