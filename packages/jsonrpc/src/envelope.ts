/**
 * The JSON-RPC 2.0 envelope (https://www.jsonrpc.org/specification): what a request must look like, the error codes the
 * protocol reserves, and the lines a server writes back.
 */

/** The error codes JSON-RPC 2.0 reserves for the protocol itself (section 5.1 of the specification). */
export const codes = Object.freeze({
  parseError: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internalError: -32603,
} as const);

/** The `error` member of a response: an integer code, a short message and, when there is one, structured `data`. */
export interface ErrorObject {
  code: number;
  message: string;
  data?: unknown;
}

/**
 * An error whose code and message reach the client as they are. A method throws one to answer with its own code; the
 * server throws one for an unknown method (`-32601`) or parameters that fail their schema (`-32602`), and passes it to
 * the `error` option like any other error.
 */
export class RpcError extends Error {
  readonly code: number;
  readonly data?: unknown;

  constructor(code: number, message: string, data?: unknown) {
    super(message);
    this.name = "RpcError";
    this.code = code;
    if (data !== undefined) this.data = data;
  }
}

/** One of the codes JSON-RPC 2.0 reserves. */
export type ReservedCode = (typeof codes)[keyof typeof codes];

/** The messages JSON-RPC 2.0 gives its reserved codes; the server's `messages` option replaces them one by one. */
export const standardMessages: Readonly<Record<ReservedCode, string>> = Object.freeze({
  [codes.parseError]: "Parse error",
  [codes.invalidRequest]: "Invalid Request",
  [codes.methodNotFound]: "Method not found",
  [codes.invalidParams]: "Invalid params",
  [codes.internalError]: "Internal error",
});

/** A request id: a string or a number. `null` is used only in a response to a request whose id could not be read. */
export type Id = string | number | null;

/** What one line holds once its envelope is read. */
export type Envelope =
  /** A well-formed request. `id` is `undefined` for a notification (a request with no `id` member). */
  | { readonly kind: "request"; readonly id: string | number | undefined; readonly method: string; readonly params: unknown }
  /** A line that is answered with an error before any method is looked up: `-32700` or `-32600`. */
  | { readonly kind: "invalid"; readonly id: Id; readonly code: ReservedCode };

/**
 * Reads one line's request.
 *
 * - Text that is not JSON is `-32700` with id `null`.
 * - An array (a batch) is `-32600` with id `null`: batches are not supported.
 * - A value that is not an object, a `jsonrpc` other than `"2.0"`, a `method` that is not a string, or an `id` that is
 *   present but neither a string nor a finite number (`null` included, and `1e400`, which parses to `Infinity`) is
 *   `-32600`, answered with the request's id when that id is a string or a finite number, else with `null`.
 *
 * `params` is returned as it was sent, `undefined` when absent; the server checks it.
 */
export function readEnvelope(text: string): Envelope {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { kind: "invalid", id: null, code: codes.parseError };
  }
  if (Array.isArray(value)) return { kind: "invalid", id: null, code: codes.invalidRequest };
  if (typeof value !== "object" || value === null) return { kind: "invalid", id: null, code: codes.invalidRequest };
  const request = value as Record<string, unknown>;
  const hasId = Object.hasOwn(request, "id");
  const id = request.id;
  // JSON has no Infinity, but a number too large for a double parses to it, and would be echoed as `null`.
  const validId = typeof id === "string" || (typeof id === "number" && Number.isFinite(id));
  if (request.jsonrpc !== "2.0" || typeof request.method !== "string" || (hasId && !validId)) {
    return { kind: "invalid", id: validId ? id : null, code: codes.invalidRequest };
  }
  return {
    kind: "request",
    id: hasId ? (id as string | number) : undefined,
    method: request.method,
    params: Object.hasOwn(request, "params") ? request.params : undefined,
  };
}

/** True for a well-formed error object: an integer `code` and a string `message`. */
export function isErrorObject(value: unknown): value is ErrorObject {
  if (typeof value !== "object" || value === null) return false;
  const { code, message } = value as Partial<ErrorObject>;
  return Number.isInteger(code) && typeof message === "string";
}

/**
 * The response line for a result, or `undefined` when the result has no JSON form (a function or a symbol) or
 * cannot be serialised (a `BigInt`, a cycle). An `undefined` result is sent as `null`.
 */
export function resultLine(id: Id, result: unknown): string | undefined {
  let body: string | undefined;
  try {
    body = JSON.stringify(result === undefined ? null : result);
  } catch {
    return undefined;
  }
  if (body === undefined) return undefined;
  return `{"jsonrpc":"2.0","id":${JSON.stringify(id)},"result":${body}}`;
}

/**
 * The response line for an error. Only `code`, `message` and `data` are sent; `data` is left out when it is
 * `undefined`. Returns `undefined` when `data` cannot be serialised.
 */
export function errorLine(id: Id, error: ErrorObject): string | undefined {
  const object: ErrorObject = { code: error.code, message: error.message };
  if (error.data !== undefined) object.data = error.data;
  try {
    return JSON.stringify({ jsonrpc: "2.0", id, error: object });
  } catch {
    return undefined;
  }
}

/** The line of a server-to-client notification: a request with no `id`. */
export function notificationLine(method: string, params: Record<string, unknown>): string {
  return JSON.stringify({ jsonrpc: "2.0", method, params });
}
