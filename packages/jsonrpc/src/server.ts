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
  resultLine,
  RpcError,
  standardMessages,
  type ErrorObject,
  type Id,
  type ReservedCode,
} from "./envelope.ts";

/** What `run` receives: the schema's output, or, for a method with no schema (`P` unknown), the object as sent. */
type Params<P> = unknown extends P ? Readonly<Record<string, unknown>> : P;

/**
 * One method of the table. `params`, when given, is any Standard Schema validator (zod, valibot, ArkType...): the
 * request's `params` must pass it before the context factory or `run` is called, and `run` receives its output, typed
 * as the schema's output. Without one, `run` receives the request's `params` object as sent (`{}` when the request has
 * none), typed `Readonly<Record<string, unknown>>`.
 */
export interface Method<C, P = unknown> {
  readonly params?: StandardSchemaV1<unknown, P>;
  /** Returns the result, or a promise of it. `undefined` is sent as `null`. */
  run(params: Params<P>, context: C, call: Call): unknown;
}

/**
 * Plain data: method name to entry, for a table built apart from `serve`. Only the table's own keys are methods, so
 * `toString` or `__proto__` never is. An entry's `run` receives `Readonly<Record<string, unknown>>` here, whatever its
 * schema: written inline in `serve`'s options instead, it receives the schema's output.
 *
 * The entry type is `Method<C, any>`, not `Method<C, unknown>`: TypeScript compares `Method` as invariant in `P`, since
 * `run`'s parameter is a conditional type of `P`, so an entry built by a helper as `Method<C, { id: string }>` would not
 * fit `Method<C, unknown>`. `Params<any>` is still `Readonly<Record<string, unknown>>`.
 */
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
  /**
   * Runs once when either side closes, with `closed` already true; a late listener runs immediately. Returns an
   * unsubscribe function. A listener's throw or rejected promise is reported through `log`, without stopping others.
   */
  onClose(listener: () => void | Promise<void>): () => void;
  /**
   * Stops reading and marks this connection closed immediately, then ends it after previously queued bytes are
   * written. Idempotent. A call still validating never reaches its context factory; a call still building context
   * never reaches `run`. Work already in `run` is not cancelled, but its result is discarded without an error response.
   * Unlike `Server.close()`, this does not wait for running calls. Send any final notification before calling this.
   * The byte drain has no deadline: a client that never reads can keep its socket and queued bytes open indefinitely.
   */
  close(): void;
  /** True once the client or the server closed the connection. */
  readonly closed: boolean;
}

/** One failure of a method's `params` schema, in the `data.issues` of the `-32602` error the server throws for it. */
export interface ParamsIssue {
  readonly message: string;
  /** Where the failure is in `params`: property names and array indexes, `[]` for `params` itself. */
  readonly path: readonly (string | number)[];
}

export interface ServeOptions<C, T extends Record<string, unknown> = Record<string, unknown>> {
  /** The socket's file path. A stale socket file left there by a server that is gone is replaced. */
  socket: string;
  /**
   * The socket file's permission bits, `0o600` unless set: only the user the server runs as can connect. Some
   * systems ignore a socket file's permissions, so the directory that holds it should be closed to everyone else too.
   */
  mode?: number;
  /** Method name to entry. Written inline, each entry's `run` receives the type its `params` schema outputs. */
  methods: { readonly [K in keyof T]: Method<C, T[K]> };
  /** Builds the `context` argument of `run`, once per request, after `params` passed the method's schema. */
  context: (call: Call, params: unknown) => C | Promise<C>;
  /** Wraps each call, the context factory included; pass the generated binding (`bind(layer)` from `#mesh`). */
  binding?: { run<R>(fn: () => Promise<R>): Promise<R> };
  /**
   * Maps an error thrown while a request is handled to the error object the client receives. It also receives the
   * server's own `RpcError`s, `-32601` and `-32602`. An error it throws, or a value that is not an error object (an
   * integer `code` and a string `message`), is answered `-32603` and passed to `log`.
   */
  error?: (error: unknown, call: Call) => ErrorObject;
  /**
   * The message sent with each code the package answers with itself, replacing JSON-RPC's own ("Parse error",
   * "Invalid Request", "Method not found", "Invalid params", "Internal error") for the codes it names.
   */
  messages?: Partial<Record<-32700 | -32600 | -32601 | -32602 | -32603, string>>;
  /** Receives every unexpected failure. Defaults to `console.error`; the server never writes to standard output. */
  log?: (message: string, error?: unknown) => void;
  /** The longest line accepted, in bytes. A longer line is discarded and answered `-32700`. Defaults to 8 MiB. */
  maxLineBytes?: number;
}

export interface Server {
  /** The socket's file path. */
  readonly socket: string;
  /**
   * Stops accepting connections and removes the socket file, stops reading requests on the open connections, waits
   * for the calls still running and writes each one's answer, then ends every connection and resolves, with no
   * deadline of its own: the caller owns it. A request that arrives after `close()` began gets no answer, and a call
   * that has not reached its context factory or `run` by then never runs. A client that has gone does not delay it.
   * Calling it again returns the same promise.
   */
  close(): Promise<void>;
}

const MEBIBYTE = 1024 * 1024;
const encoder = new TextEncoder();

interface Settings<C> {
  readonly socket: string;
  readonly mode: number;
  readonly methods: ReadonlyMap<string, Method<C, unknown>>;
  readonly context: (call: Call, params: unknown) => C | Promise<C>;
  readonly binding: { run<R>(fn: () => Promise<R>): Promise<R> } | undefined;
  readonly error: ((error: unknown, call: Call) => ErrorObject) | undefined;
  readonly messages: Readonly<Record<ReservedCode, string>>;
  readonly log: (message: string, error?: unknown) => void;
  readonly maxLineBytes: number;
}

/** What a connection needs from the settings. */
type PeerSettings = Pick<Settings<unknown>, "messages" | "log" | "maxLineBytes">;

/** The error object of a reserved code, with the message the settings give it. */
function reserved(settings: Pick<Settings<unknown>, "messages">, code: ReservedCode): ErrorObject {
  return { code, message: settings.messages[code] };
}

/** What a call resolves with when `close()` began before it reached `run`. */
const SKIPPED: unique symbol = Symbol("skipped");

/**
 * Listens on a Unix socket and answers newline-delimited JSON-RPC 2.0 requests from the method table. Resolves once
 * the socket accepts connections. Rejects with `FrameworkError` when an option is invalid, when the path holds
 * something other than a stale socket (a file, a directory, a socket another server is listening on), or when
 * listening fails.
 */
export async function serve<C, T extends Record<string, unknown>>(options: ServeOptions<C, T>): Promise<Server> {
  const settings = checkOptions(options as ServeOptions<C>);
  await prepareSocketPath(settings.socket);
  const inflight = new Set<Promise<void>>();
  const peers = new Set<Peer>();
  const state = { closing: false };
  let closed: Promise<void> | undefined;

  const receive = (peer: Peer, chunk: Uint8Array) => {
    for (const frame of peer.reader.push(chunk)) {
      // close() began, possibly from a call this same chunk started: the rest of the chunk is not read.
      if (state.closing || peer.closed) return;
      if (frame.kind !== "line") {
        peer.sendError(null, reserved(settings, codes.parseError));
        continue;
      }
      const envelope = readEnvelope(frame.text);
      if (envelope.kind === "invalid") {
        peer.sendError(envelope.id, reserved(settings, envelope.code));
        continue;
      }
      peer.begin();
      const task: Promise<void> = dispatch(settings, state, peer, envelope.method, envelope.id, envelope.params)
        .catch((error: unknown) => settings.log(`unexpected failure while handling ${envelope.method}`, error))
        .finally(() => {
          inflight.delete(task);
          peer.done();
        });
      inflight.add(task);
    }
  };

  let listener: UnixSocketListener<Peer | undefined>;
  // Bun.listen binds synchronously, and the bind creates the socket file with the permissions the umask leaves. The
  // umask belongs to the whole process, so it is narrowed for this one call and restored before any other JavaScript
  // runs; only a file another thread (a Worker) creates at that same instant would be affected. Setting the mode at
  // creation leaves no moment in which the file has wider permissions, as a chmod after the bind would.
  const umask = process.umask(0o777 & ~settings.mode);
  try {
    listener = Bun.listen<Peer | undefined>({
      unix: settings.socket,
      // A client may shut down its writing side after its last request (`nc -U`, `socat` do): the connection stays
      // open for the answers, and the server ends it once they are written.
      allowHalfOpen: true,
      socket: {
        open(socket) {
          const peer = new Peer(socket, settings);
          socket.data = peer;
          peers.add(peer);
        },
        data(socket, chunk) {
          if (socket.data) receive(socket.data, chunk);
        },
        drain(socket) {
          socket.data?.flush();
        },
        end(socket) {
          socket.data?.endRead();
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
  } finally {
    process.umask(umask);
  }
  const identity = fileIdentity(settings.socket, settings.log);

  return Object.freeze({
    socket: settings.socket,
    close(): Promise<void> {
      closed ??= (async () => {
        state.closing = true;
        // The socket file goes first, so no client finds the path while the calls drain. `stop(false)` also refuses new
        // connections, but only the removal makes a late client fail at once with ENOENT instead of connecting to a
        // listener that is winding down. The identity check leaves a file another server took over alone. Bun's own
        // unlink inside `stop` finds nothing to remove after that.
        removeOwnSocket(settings.socket, identity, settings.log);
        // `false` keeps the open connections: their calls still owe an answer.
        listener.stop(false);
        // `receive` ignores every line from now on. Calls past the context factory run to the end; their answers are
        // written to the connection's queue as they settle. A call that fails still answers, so allSettled.
        await Promise.allSettled([...inflight]);
        // A connection the client already closed resolves at once (`markClosed`), so a vanished client never blocks.
        const open = [...peers];
        await Promise.all(open.map((peer) => peer.drained()));
        for (const peer of open) peer.finish();
        peers.clear();
      })();
      return closed;
    },
  });
}

/**
 * Handles one request. Never rejects: every failure becomes an error response, or a log line for a notification. Once
 * `close()` began, a call that has not reached its context factory or `run` stops there, unanswered.
 */
async function dispatch<C>(
  settings: Settings<C>,
  server: { readonly closing: boolean },
  peer: Peer,
  method: string,
  id: string | number | undefined,
  sent: unknown,
): Promise<void> {
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
      const issues: ParamsIssue[] = [{ message: "params must be an object", path: [] }];
      throw new RpcError(codes.invalidParams, settings.messages[codes.invalidParams], { issues });
    }
    const entry = settings.methods.get(method);
    if (!entry) throw new RpcError(codes.methodNotFound, settings.messages[codes.methodNotFound]);
    const params = entry.params ? await validate(entry.params, value, settings.messages[codes.invalidParams]) : value;
    const invoke = async (): Promise<unknown> => {
      if (server.closing || peer.closed) return SKIPPED;
      const context = await settings.context(call, params);
      if (server.closing || peer.closed) return SKIPPED;
      return entry.run(params as Readonly<Record<string, unknown>>, context, call);
    };
    result = settings.binding ? await settings.binding.run(invoke) : await invoke();
  } catch (error) {
    if (notification) {
      if (!(error instanceof RpcError)) settings.log(`notification ${method} failed`, error);
      return;
    }
    peer.sendError(responseId, toErrorObject(settings, error, call));
    return;
  }
  if (notification || result === SKIPPED) return;
  const line = resultLine(responseId, result);
  if (line === undefined) {
    settings.log(`the result of ${method} has no JSON form (a function, a symbol, a BigInt or a cycle)`);
    peer.sendError(responseId, reserved(settings, codes.internalError));
    return;
  }
  peer.send(line);
}

/** Runs the method's schema; a failure is the `-32602` `RpcError` whose `data.issues` lists each `ParamsIssue`. */
async function validate<P>(schema: StandardSchemaV1<unknown, P>, value: unknown, message: string): Promise<P> {
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
    throw new RpcError(codes.invalidParams, message, { issues });
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
      return reserved(settings, codes.internalError);
    }
    if (!isErrorObject(mapped)) {
      settings.log(`the error option returned no error object (an integer code and a string message) for ${call.method}`, error);
      return reserved(settings, codes.internalError);
    }
    return mapped;
  }
  if (error instanceof RpcError && Number.isInteger(error.code)) {
    return error.data === undefined ? { code: error.code, message: error.message } : { code: error.code, message: error.message, data: error.data };
  }
  settings.log(`${call.method} failed`, error);
  return reserved(settings, codes.internalError);
}

/** One client connection: its line reader, the bytes the socket has not taken yet, and the calls not yet answered. */
class Peer implements Connection {
  readonly reader: LineReader;
  readonly #socket: Socket<Peer | undefined>;
  readonly #settings: PeerSettings;
  /** Bytes waiting for the socket's `drain`, oldest first. */
  #queue: Uint8Array[] = [];
  #closed = false;
  /** A server-side close: no new output, but already queued bytes still drain. */
  #closeRequested = false;
  readonly #closeListeners = new Set<() => void>();
  /** Calls started on this connection that have not finished. */
  #pending = 0;
  /** True once the client shut down its writing side: no request follows. */
  #readEnded = false;
  /** Resolvers of `drained()`, called once the queue is empty or the connection is closed. */
  #drainWaiters: (() => void)[] = [];

  constructor(socket: Socket<Peer | undefined>, settings: PeerSettings) {
    this.#socket = socket;
    this.#settings = settings;
    this.reader = new LineReader(settings.maxLineBytes);
  }

  get closed(): boolean {
    return this.#closed || this.#closeRequested;
  }

  onClose(listener: () => void | Promise<void>): () => void {
    const run = () => {
      try {
        const result = listener();
        if (result) void Promise.resolve(result).catch((error: unknown) => this.#settings.log("connection onClose listener failed", error));
      } catch (error) {
        this.#settings.log("connection onClose listener failed", error);
      }
    };
    if (this.closed) run();
    else this.#closeListeners.add(run);
    return () => { this.#closeListeners.delete(run); };
  }

  close(): void {
    if (this.closed) return;
    this.#closeRequested = true;
    this.#notifyClosed();
    this.flush();
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
    if (this.closed) return;
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
    this.#settings.log(`the data of error ${error.code} (${error.message}) has no JSON form`);
    this.send(errorLine(id, reserved(this.#settings, codes.internalError))!);
  }

  /** Counts a call started on this connection. */
  begin(): void {
    this.#pending++;
  }

  /** Counts a call finished, its answer (if any) written or queued. */
  done(): void {
    this.#pending--;
    this.#endIfFinished();
  }

  /** The client shut down its writing side. */
  endRead(): void {
    this.#readEnded = true;
    this.#endIfFinished();
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
    if (this.#queue.length === 0) this.#releaseDrained();
    this.#endIfFinished();
  }

  /** Resolves once every queued byte is written, or the connection is closed (the client left, or a write failed). */
  drained(): Promise<void> {
    if (this.#closed || this.#queue.length === 0) return Promise.resolve();
    return new Promise((resolve) => this.#drainWaiters.push(resolve));
  }

  /** Ends the connection from the server's side, after `drained()`; does nothing when it is already closed. */
  finish(): void {
    if (this.#closed) return;
    this.markClosed();
    this.#socket.end();
  }

  /** Drains an explicit close, or a client's half-close after its pending calls finish. */
  #endIfFinished(): void {
    if (this.#closed || this.#queue.length > 0) return;
    if (!this.#closeRequested && (!this.#readEnded || this.#pending > 0)) return;
    this.finish();
  }

  markClosed(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#queue = [];
    this.#releaseDrained();
    this.#notifyClosed();
  }

  #notifyClosed(): void {
    const listeners = [...this.#closeListeners];
    this.#closeListeners.clear();
    for (const listener of listeners) listener();
  }

  #releaseDrained(): void {
    for (const resolve of this.#drainWaiters.splice(0)) resolve();
  }
}

function checkOptions<C>(options: ServeOptions<C>): Settings<C> {
  if (typeof options !== "object" || options === null) throw new FrameworkError("serve() needs an options object");
  const { socket, mode, methods, context, binding, error, messages, log, maxLineBytes } = options;
  if (typeof socket !== "string" || socket === "") throw new FrameworkError("serve() needs `socket`, the socket's file path");
  if (mode !== undefined && !(Number.isInteger(mode) && mode >= 0 && mode <= 0o777)) {
    throw new FrameworkError("serve() needs `mode` to be permission bits, an integer from 0 to 0o777");
  }
  if (typeof methods !== "object" || methods === null || Array.isArray(methods)) {
    throw new FrameworkError("serve() needs `methods`, an object of method name to entry");
  }
  const table = new Map<string, Method<C, unknown>>();
  for (const name of Object.keys(methods)) {
    const entry: unknown = (methods as Record<string, unknown>)[name];
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
    mode: mode ?? 0o600,
    methods: table,
    context,
    binding,
    error,
    messages: checkMessages(messages),
    log: guardedLog(log),
    maxLineBytes: maxLineBytes ?? 8 * MEBIBYTE,
  };
}

/** JSON-RPC's messages, with the ones the `messages` option gives in their place. */
function checkMessages(messages: unknown): Readonly<Record<ReservedCode, string>> {
  if (messages === undefined) return standardMessages;
  if (typeof messages !== "object" || messages === null || Array.isArray(messages)) {
    throw new FrameworkError("serve() needs `messages` to be an object of error code to message");
  }
  const merged: Record<ReservedCode, string> = { ...standardMessages };
  for (const key of Object.keys(messages)) {
    if (!Object.hasOwn(standardMessages, key)) {
      throw new FrameworkError(`serve() got a message for ${key}; \`messages\` takes only -32700, -32600, -32601, -32602 and -32603`);
    }
    const message: unknown = (messages as Record<string, unknown>)[key];
    if (typeof message !== "string" || message === "") {
      throw new FrameworkError(`serve() needs the message for ${key} to be a non-empty string`);
    }
    merged[Number(key) as ReservedCode] = message;
  }
  return Object.freeze(merged);
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

/** The device and inode of a file, which tell this server's socket file from another one at the same path. */
export interface FileIdentity {
  readonly dev: number;
  readonly ino: number;
}

/** The identity of the socket file the listener just created; `undefined`, logged, when it cannot be read. */
function fileIdentity(path: string, log: (message: string, error?: unknown) => void): FileIdentity | undefined {
  try {
    const { dev, ino } = lstatSync(path);
    return { dev, ino };
  } catch (error) {
    log(`cannot read the socket file ${path}; close() will leave whatever is at that path`, error);
    return undefined;
  }
}

/**
 * Removes the socket file after the listener stopped, if the path still holds the file this server created: the same
 * device and inode. Another process can bind the path while this server runs, once this server's file is removed (by
 * hand, or by a tool that clears stale sockets without checking that no server answers), and its file is left alone.
 *
 * Bun's `stop` unlinks the listening path itself, without that check, so in practice the file is usually gone before
 * this runs, and a second server on the path loses its file when this one stops: one path, one server.
 */
export function removeOwnSocket(path: string, identity: FileIdentity | undefined, log: (message: string, error?: unknown) => void): void {
  if (identity === undefined) return;
  try {
    const found = lstatSync(path);
    if (found.isSocket() && found.dev === identity.dev && found.ino === identity.ino) unlinkSync(path);
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
