import { lstat, unlink } from "node:fs/promises";
import { lstatSync, unlinkSync } from "node:fs";
import type { Socket, UnixSocketListener } from "bun";
import { FrameworkError, type StandardSchemaV1 } from "@meshfw/runtime";
import { LineReader } from "./framing.ts";
import {
  codes,
  errorLine,
  isErrorObject,
  notificationLine,
  readEnvelope,
  reserved,
  resultLine,
  RpcError,
  type ErrorObject,
  type Id,
} from "./envelope.ts";

/**
 * One method of the table. `params`, when given, is any Standard Schema validator (zod, valibot, ArkType...): the
 * request's `params` must pass it before the context factory or `run` is called, and `run` receives its output.
 * Without one, `run` receives the request's `params` object as sent (`{}` when the request has none).
 */
export interface Method<C, P = Record<string, unknown>> {
  readonly params?: StandardSchemaV1<unknown, P>;
  /** Returns the result, or a promise of it. `undefined` is sent as `null`. */
  run(params: P, context: C, call: Call): unknown;
}

/** Plain data: method name to entry. Only the table's own keys are methods, so `toString` or `__proto__` never is. */
export type MethodTable<C> = { readonly [name: string]: Method<C, any> };

/** One request, as the context factory, `run` and the `error` option see it. */
export interface Call {
  readonly method: string;
  /** The request's id; `null` for a notification, a request sent with no `id`, which gets no response. */
  readonly id: string | number | null;
  /** The request's `params` object as sent: `{}` when it had none or when it was not an object (answered `-32602`). */
  readonly params: Readonly<Record<string, unknown>>;
  /** The connection the request came in on. */
  readonly connection: Connection;
}

/** One client connection. */
export interface Connection {
  /**
   * Writes a notification to this client: one line, `{"jsonrpc":"2.0","method":...,"params":...}`, with no `id`.
   * Does nothing once the connection is closed. Throws `FrameworkError` when `params` is not a plain JSON object.
   */
  notify(method: string, params: Record<string, unknown>): void;
  /** True once the client or the server closed the connection. */
  readonly closed: boolean;
}

/** One failure of a method's `params` schema, in the `data.issues` of the `-32602` error the server throws for it. */
export interface ParamsIssue {
  readonly message: string;
  /** Where the failure is in `params`: property names and array indexes, `[]` for `params` itself. */
  readonly path: readonly (string | number)[];
}

export interface ServeOptions<C> {
  /** The socket's file path. A stale socket file left there by a server that is gone is replaced. */
  socket: string;
  methods: MethodTable<C>;
  /** Builds the `context` argument of `run`, once per request, after `params` passed the method's schema. */
  context: (call: Call, params: unknown) => C | Promise<C>;
  /** Wraps each call, the context factory included; pass the generated binding (`bind(layer)` from `#mesh`). */
  binding?: { run<T>(fn: () => Promise<T>): Promise<T> };
  /**
   * Maps an error thrown while a request is handled to the error object the client receives. It also receives the
   * server's own `RpcError`s, `-32601` and `-32602`. An error it throws, or a value that is not an error object (an
   * integer `code` and a string `message`), is answered `-32603` and passed to `log`.
   */
  error?: (error: unknown, call: Call) => ErrorObject;
  /** Receives every unexpected failure. Defaults to `console.error`; the server never writes to standard output. */
  log?: (message: string, error?: unknown) => void;
  /** The longest line accepted, in bytes. A longer line is discarded and answered `-32700`. Defaults to 8 MiB. */
  maxLineBytes?: number;
}

export interface Server {
  /** The socket's file path. */
  readonly socket: string;
  /**
   * Stops accepting connections, closes every open one and removes the socket file, then resolves once the calls
   * still running have settled. Calling it again returns the same promise.
   */
  close(): Promise<void>;
}

const MEBIBYTE = 1024 * 1024;
const encoder = new TextEncoder();

interface Settings<C> {
  readonly socket: string;
  readonly methods: ReadonlyMap<string, Method<C, unknown>>;
  readonly context: (call: Call, params: unknown) => C | Promise<C>;
  readonly binding: { run<T>(fn: () => Promise<T>): Promise<T> } | undefined;
  readonly error: ((error: unknown, call: Call) => ErrorObject) | undefined;
  readonly log: (message: string, error?: unknown) => void;
  readonly maxLineBytes: number;
}

/**
 * Listens on a Unix socket and answers newline-delimited JSON-RPC 2.0 requests from the method table. Resolves once
 * the socket accepts connections. Rejects with `FrameworkError` when an option is invalid, when the path holds
 * something other than a stale socket (a file, a directory, a socket another server is listening on), or when
 * listening fails.
 */
export async function serve<C>(options: ServeOptions<C>): Promise<Server> {
  const settings = checkOptions(options);
  await prepareSocketPath(settings.socket);
  const inflight = new Set<Promise<void>>();
  const peers = new Set<Peer>();
  let closing: Promise<void> | undefined;

  const receive = (peer: Peer, chunk: Uint8Array) => {
    for (const frame of peer.reader.push(chunk)) {
      if (closing) return;
      if (frame.kind !== "line") {
        peer.sendError(null, reserved(codes.parseError));
        continue;
      }
      const envelope = readEnvelope(frame.text);
      if (envelope.kind === "invalid") {
        peer.sendError(envelope.id, envelope.error);
        continue;
      }
      const task: Promise<void> = dispatch(settings, peer, envelope.method, envelope.id, envelope.params)
        .catch((error: unknown) => settings.log(`unexpected failure while handling ${envelope.method}`, error))
        .finally(() => inflight.delete(task));
      inflight.add(task);
    }
  };

  let listener: UnixSocketListener<Peer | undefined>;
  try {
    listener = Bun.listen<Peer | undefined>({
      unix: settings.socket,
      socket: {
        open(socket) {
          const peer = new Peer(socket, settings.maxLineBytes, settings.log);
          socket.data = peer;
          peers.add(peer);
        },
        data(socket, chunk) {
          if (socket.data) receive(socket.data, chunk);
        },
        drain(socket) {
          socket.data?.flush();
        },
        close(socket) {
          if (!socket.data) return;
          socket.data.markClosed();
          peers.delete(socket.data);
        },
        error(_socket, error) {
          settings.log("connection error", error);
        },
      },
    });
  } catch (error) {
    throw new FrameworkError(`cannot listen on the Unix socket ${settings.socket}: ${describe(error)}`, { cause: error });
  }

  return Object.freeze({
    socket: settings.socket,
    close(): Promise<void> {
      closing ??= (async () => {
        listener.stop(true);
        for (const peer of peers) peer.markClosed();
        peers.clear();
        removeOwnSocket(settings.socket, settings.log);
        await Promise.allSettled([...inflight]);
      })();
      return closing;
    },
  });
}

/** Handles one request. Never rejects: every failure becomes an error response, or a log line for a notification. */
async function dispatch<C>(settings: Settings<C>, peer: Peer, method: string, id: string | number | undefined, sent: unknown): Promise<void> {
  const notification = id === undefined;
  const responseId: Id = notification ? null : id;
  const value = sent === undefined ? {} : sent;
  const isObject = typeof value === "object" && value !== null && !Array.isArray(value);
  const call: Call = Object.freeze({
    method,
    id: responseId,
    params: isObject ? (value as Record<string, unknown>) : {},
    connection: peer,
  });
  let result: unknown;
  try {
    if (!isObject) {
      throw new RpcError(codes.invalidParams, "Invalid params", { issues: [{ message: "params must be an object", path: [] }] });
    }
    const entry = settings.methods.get(method);
    if (!entry) throw new RpcError(codes.methodNotFound, "Method not found");
    const params = entry.params ? await validate(entry.params, value) : value;
    const invoke = async () => entry.run(params, await settings.context(call, params), call);
    result = settings.binding ? await settings.binding.run(invoke) : await invoke();
  } catch (error) {
    if (notification) {
      if (!(error instanceof RpcError)) settings.log(`notification ${method} failed`, error);
      return;
    }
    peer.sendError(responseId, toErrorObject(settings, error, call));
    return;
  }
  if (notification) return;
  const line = resultLine(responseId, result);
  if (line === undefined) {
    settings.log(`the result of ${method} has no JSON form (a function, a symbol, a BigInt or a cycle)`);
    peer.sendError(responseId, reserved(codes.internalError));
    return;
  }
  peer.send(line);
}

/** Runs the method's schema; a failure is the `-32602` `RpcError` whose `data.issues` lists each `ParamsIssue`. */
async function validate<P>(schema: StandardSchemaV1<unknown, P>, value: unknown): Promise<P> {
  const result = await schema["~standard"].validate(value);
  if (typeof result !== "object" || result === null || !("value" in result || "issues" in result)) {
    throw new FrameworkError("Malformed Standard Schema result: expected an object containing value or issues");
  }
  if (result.issues !== undefined) {
    if (!Array.isArray(result.issues)) throw new FrameworkError("Malformed Standard Schema result: issues must be an array");
    const issues: ParamsIssue[] = result.issues.map((issue: StandardSchemaV1.Issue) => ({
      message: issue.message,
      path: issue.path?.map((segment) => {
        const key = typeof segment === "object" ? segment.key : segment;
        return typeof key === "number" ? key : String(key);
      }) ?? [],
    }));
    throw new RpcError(codes.invalidParams, "Invalid params", { issues });
  }
  return result.value;
}

/** The error object a failed request is answered with: the `error` option's, else an `RpcError`'s, else `-32603`. */
function toErrorObject<C>(settings: Settings<C>, error: unknown, call: Call): ErrorObject {
  let mapped: unknown;
  if (settings.error) {
    try {
      mapped = settings.error(error, call);
    } catch (thrown) {
      settings.log(thrown === error ? `${call.method} failed` : `the error option threw while mapping a failure of ${call.method}`, thrown);
      return reserved(codes.internalError);
    }
    if (!isErrorObject(mapped)) {
      settings.log(`the error option returned no error object (an integer code and a string message) for ${call.method}`, error);
      return reserved(codes.internalError);
    }
    return mapped;
  }
  if (error instanceof RpcError && Number.isInteger(error.code)) {
    return error.data === undefined ? { code: error.code, message: error.message } : { code: error.code, message: error.message, data: error.data };
  }
  settings.log(`${call.method} failed`, error);
  return reserved(codes.internalError);
}

/** One client connection: its line reader, and the bytes the socket has not taken yet. */
class Peer implements Connection {
  readonly reader: LineReader;
  readonly #socket: Socket<Peer | undefined>;
  readonly #log: (message: string, error?: unknown) => void;
  /** Bytes waiting for the socket's `drain`, oldest first. */
  #queue: Uint8Array[] = [];
  #closed = false;

  constructor(socket: Socket<Peer | undefined>, maxLineBytes: number, log: (message: string, error?: unknown) => void) {
    this.#socket = socket;
    this.#log = log;
    this.reader = new LineReader(maxLineBytes);
  }

  get closed(): boolean {
    return this.#closed;
  }

  notify(method: string, params: Record<string, unknown>): void {
    if (typeof method !== "string" || method === "") throw new FrameworkError("connection.notify needs a method name");
    if (typeof params !== "object" || params === null || Array.isArray(params)) {
      throw new FrameworkError(`connection.notify(${JSON.stringify(method)}) needs params that are an object`);
    }
    let line: string;
    try {
      line = notificationLine(method, params);
    } catch (error) {
      throw new FrameworkError(`connection.notify(${JSON.stringify(method)}) got params that have no JSON form`, { cause: error });
    }
    this.send(line);
  }

  /** Writes one line, after whatever is still queued. */
  send(line: string): void {
    if (this.#closed) return;
    const bytes = encoder.encode(line + "\n");
    if (this.#queue.length > 0) {
      this.#queue.push(bytes);
      return;
    }
    this.#queue.push(bytes);
    this.flush();
  }

  /** Writes an error response; an error whose `data` has no JSON form is sent as `-32603` instead, and logged. */
  sendError(id: Id, error: ErrorObject): void {
    const line = errorLine(id, error);
    if (line !== undefined) return this.send(line);
    this.#log(`the data of error ${error.code} (${error.message}) has no JSON form`);
    this.send(errorLine(id, reserved(codes.internalError))!);
  }

  /** Hands the socket as much of the queue as it takes; the rest waits for the next `drain`. */
  flush(): void {
    while (!this.#closed && this.#queue.length > 0) {
      const head = this.#queue[0]!;
      const written = this.#socket.write(head);
      if (written < 0) {
        this.markClosed();
        return;
      }
      if (written < head.length) {
        this.#queue[0] = head.subarray(written);
        return;
      }
      this.#queue.shift();
    }
  }

  markClosed(): void {
    this.#closed = true;
    this.#queue = [];
  }
}

function checkOptions<C>(options: ServeOptions<C>): Settings<C> {
  if (typeof options !== "object" || options === null) throw new FrameworkError("serve() needs an options object");
  const { socket, methods, context, binding, error, log, maxLineBytes } = options;
  if (typeof socket !== "string" || socket === "") throw new FrameworkError("serve() needs `socket`, the socket's file path");
  if (typeof methods !== "object" || methods === null || Array.isArray(methods)) {
    throw new FrameworkError("serve() needs `methods`, an object of method name to entry");
  }
  const table = new Map<string, Method<C, unknown>>();
  for (const name of Object.keys(methods)) {
    const entry: unknown = methods[name];
    if (typeof entry !== "object" || entry === null || typeof (entry as Method<C>).run !== "function") {
      throw new FrameworkError(`method ${JSON.stringify(name)} needs a \`run\` function`);
    }
    const schema = (entry as Method<C>).params;
    if (schema !== undefined && typeof (schema as Partial<StandardSchemaV1>)?.["~standard"]?.validate !== "function") {
      throw new FrameworkError(`method ${JSON.stringify(name)} has \`params\` that is not a Standard Schema validator`);
    }
    table.set(name, entry as Method<C, unknown>);
  }
  if (typeof context !== "function") throw new FrameworkError("serve() needs `context`, a function that builds each call's context");
  if (binding !== undefined && typeof binding?.run !== "function") {
    throw new FrameworkError("serve() needs `binding` to have a `run` function, as a binding from `bind` has");
  }
  if (error !== undefined && typeof error !== "function") throw new FrameworkError("serve() needs `error` to be a function");
  if (log !== undefined && typeof log !== "function") throw new FrameworkError("serve() needs `log` to be a function");
  if (maxLineBytes !== undefined && !(Number.isSafeInteger(maxLineBytes) && maxLineBytes > 0)) {
    throw new FrameworkError("serve() needs `maxLineBytes` to be a positive integer");
  }
  return {
    socket,
    methods: table,
    context,
    binding,
    error,
    log: guardedLog(log),
    maxLineBytes: maxLineBytes ?? 8 * MEBIBYTE,
  };
}

/** The `log` option, or `console.error`; a `log` that throws falls back to `console.error` rather than failing a call. */
function guardedLog(log: ((message: string, error?: unknown) => void) | undefined): (message: string, error?: unknown) => void {
  const fallback = (message: string, error?: unknown) => {
    if (error === undefined) console.error(`@meshfw/jsonrpc: ${message}`);
    else console.error(`@meshfw/jsonrpc: ${message}`, error);
  };
  if (!log) return fallback;
  return (message, error) => {
    try {
      log(message, error);
    } catch (thrown) {
      fallback(`the log option threw while logging: ${message}`, thrown);
    }
  };
}

/**
 * Makes the path free to listen on. Nothing there is fine. A socket no server answers on is a stale one, left by a
 * server that did not close it, and is removed. Anything else is refused and left as it is.
 */
async function prepareSocketPath(path: string): Promise<void> {
  let isSocket: boolean;
  try {
    isSocket = (await lstat(path)).isSocket();
  } catch (error) {
    if (codeOf(error) === "ENOENT") return;
    throw new FrameworkError(`cannot inspect ${path}: ${describe(error)}`, { cause: error });
  }
  if (!isSocket) throw new FrameworkError(`${path} exists and is not a socket; remove it or choose another path`);
  try {
    const probe = await Bun.connect({ unix: path, socket: { data() {} } });
    probe.end();
  } catch (error) {
    const code = codeOf(error);
    if (code === "ENOENT") return;
    if (code !== "ECONNREFUSED") {
      throw new FrameworkError(`cannot tell whether a server is listening at ${path}: ${describe(error)}`, { cause: error });
    }
    try {
      await unlink(path);
    } catch (unlinkError) {
      if (codeOf(unlinkError) !== "ENOENT") {
        throw new FrameworkError(`cannot remove the stale socket ${path}: ${describe(unlinkError)}`, { cause: unlinkError });
      }
    }
    return;
  }
  throw new FrameworkError(`another server is listening at ${path}`);
}

/**
 * Removes the socket file after the listener stopped, if it is still there and still a socket. Synchronous, so no
 * other server can have taken the path between the stop and the check.
 */
function removeOwnSocket(path: string, log: (message: string, error?: unknown) => void): void {
  try {
    if (lstatSync(path).isSocket()) unlinkSync(path);
  } catch (error) {
    // ENOENT is the usual case: the listener removes the file when it stops.
    if (codeOf(error) !== "ENOENT") log(`cannot remove the socket ${path}`, error);
  }
}

function codeOf(error: unknown): unknown {
  return typeof error === "object" && error !== null ? (error as { code?: unknown }).code : undefined;
}

function describe(error: unknown): string {
  const code = codeOf(error);
  const message = error instanceof Error ? error.message : String(error);
  return typeof code === "string" ? `${code}, ${message}` : message;
}
