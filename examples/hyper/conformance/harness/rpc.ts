/**
 * Minimal newline-delimited JSON-RPC 2.0 over a Unix socket — the framing of
 * PROTOCOL.md#transport. Used by the conformance harness (client) and the
 * plugin host (server).
 */
import net from "node:net";

export interface FailureObject {
  check?: string;
  reason?: string;
  details?: Record<string, unknown>;
}

export interface RpcErrorObject {
  code: number;
  message: string;
  data?: { phase?: string; failures?: FailureObject[] } & Record<string, unknown>;
}

/** Thrown by {@link RpcClient.request} when the peer answers with an error. */
export class RpcError extends Error {
  constructor(
    readonly method: string,
    readonly error: RpcErrorObject,
  ) {
    const f = error.data?.failures?.[0];
    super(`${method} → ${error.code} ${error.message}${f?.check ? ` [${f.check}]` : ""}${f?.reason ? `: ${f.reason}` : ""}`);
  }
  get code() {
    return this.error.code;
  }
  get phase() {
    return this.error.data?.phase;
  }
  get failures() {
    return this.error.data?.failures;
  }
  get data() {
    return this.error.data;
  }
}

/** Splits a byte stream into lines and parses each as JSON. */
export function lineReader(onMessage: (msg: unknown, raw: string) => void, onBadLine?: (raw: string) => void) {
  let buf = "";
  // Streaming decoder: a multibyte character split across two chunks is decoded once both halves arrive.
  const decoder = new TextDecoder("utf-8");
  return (chunk: Uint8Array | string) => {
    buf += typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true });
    let i: number;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      let msg: unknown;
      try {
        msg = JSON.parse(line);
      } catch {
        onBadLine?.(line);
        continue;
      }
      onMessage(msg, line);
    }
  };
}

type Pending = { method: string; resolve: (v: unknown) => void; reject: (e: unknown) => void; timer: Timer };

export class RpcClient {
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private listeners = new Set<(method: string, params: any) => void>();
  private closed = false;
  /** Every message received, in order (for debugging failed tests). */
  readonly log: string[] = [];

  private constructor(
    private sock: net.Socket,
    readonly timeoutMs: number,
  ) {
    sock.on(
      "data",
      lineReader((msg: any, raw) => {
        this.log.push(raw);
        if (msg && msg.id !== undefined && msg.id !== null && (msg.result !== undefined || msg.error !== undefined)) {
          const p = this.pending.get(msg.id);
          if (!p) return;
          this.pending.delete(msg.id);
          clearTimeout(p.timer);
          if (msg.error) p.reject(new RpcError(p.method, msg.error));
          else p.resolve(msg.result);
        } else if (msg && typeof msg.method === "string" && msg.id === undefined) {
          for (const l of this.listeners) l(msg.method, msg.params);
        }
      }),
    );
    const fail = (why: string) => {
      this.closed = true;
      for (const [id, p] of this.pending) {
        clearTimeout(p.timer);
        p.reject(new Error(`${p.method}: connection ${why}`));
        this.pending.delete(id);
      }
    };
    sock.on("close", () => fail("closed"));
    sock.on("error", (e) => fail(`error: ${e.message}`));
  }

  static connect(path: string, timeoutMs = 10_000): Promise<RpcClient> {
    return new Promise((resolve, reject) => {
      const sock = net.createConnection({ path });
      sock.once("connect", () => resolve(new RpcClient(sock, timeoutMs)));
      sock.once("error", reject);
    });
  }

  request<R = any>(method: string, params: unknown = {}): Promise<R> {
    if (this.closed) return Promise.reject(new Error(`${method}: connection closed`));
    const id = this.nextId++;
    return new Promise<R>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method}: no response within ${this.timeoutMs} ms`));
      }, this.timeoutMs);
      this.pending.set(id, { method, resolve: resolve as (v: unknown) => void, reject, timer });
      this.sock.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  }

  /** Sends a raw line (for framing tests). */
  writeRaw(line: string) {
    this.sock.write(line);
  }

  onNotification(fn: (method: string, params: any) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  close(): Promise<void> {
    return new Promise((resolve) => {
      if (this.closed) return resolve();
      this.sock.once("close", () => resolve());
      this.sock.end();
      setTimeout(() => {
        this.sock.destroy();
        resolve();
      }, 500);
    });
  }
}

export type Handler = (params: any, ctx: { notify: (method: string, params: unknown) => void }) => unknown;

/** A JSON-RPC server on a Unix socket. Handlers may throw an {@link RpcErrorObject}-shaped `ServerError`. */
export class ServerError extends Error {
  constructor(readonly rpc: RpcErrorObject) {
    super(rpc.message);
  }
}

export interface RpcServer {
  server: net.Server;
  /** Closes the listener and destroys every open connection; resolves within ~1 s even if peers stay connected. */
  shutdown(): Promise<void>;
}

export function serve(path: string, handlers: Record<string, Handler>): Promise<RpcServer> {
  const sockets = new Set<net.Socket>();
  const server = net.createServer((sock) => {
    sockets.add(sock);
    sock.on("close", () => sockets.delete(sock));
    const send = (msg: unknown) => {
      if (!sock.destroyed) sock.write(JSON.stringify(msg) + "\n");
    };
    const notify = (method: string, params: unknown) => send({ jsonrpc: "2.0", method, params });
    sock.on("error", () => {});
    sock.on(
      "data",
      lineReader(
        async (msg: any) => {
          if (Array.isArray(msg) || !msg || msg.jsonrpc !== "2.0" || typeof msg.method !== "string") {
            send({ jsonrpc: "2.0", id: msg?.id ?? null, error: { code: -32600, message: "invalid_request" } });
            return;
          }
          // Only own, registered handlers: never inherited properties such as "constructor" or "toString".
          const h = Object.hasOwn(handlers, msg.method) ? handlers[msg.method] : undefined;
          if (!h) {
            if (msg.id !== undefined) send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "method_not_found" } });
            return;
          }
          try {
            const result = await h(msg.params ?? {}, { notify });
            if (msg.id !== undefined) send({ jsonrpc: "2.0", id: msg.id, result });
          } catch (e) {
            const error =
              e instanceof ServerError ? e.rpc : { code: -32603, message: "internal_error", data: { failures: [{ check: "internal", reason: String(e) }] } };
            if (msg.id !== undefined) send({ jsonrpc: "2.0", id: msg.id, error });
          }
        },
        () => send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse_error" } }),
      ),
    );
  });
  const shutdown = () =>
    new Promise<void>((resolve) => {
      server.close(() => resolve());
      for (const s of sockets) s.destroy();
      setTimeout(resolve, 1000).unref?.();
    });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(path, () => resolve({ server, shutdown }));
  });
}
