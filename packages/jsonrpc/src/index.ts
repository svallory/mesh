/**
 * `@meshfw/jsonrpc`: newline-delimited JSON-RPC 2.0 over a Unix socket. A project hands `serve` a method table (plain
 * data), a context factory and, optionally, the binding each call runs in; the package frames, validates, dispatches
 * and answers. What a method means, and how a Mesh error maps to an error object, stay with the project.
 */
export { serve } from "./server.ts";
export type { Call, Connection, Method, MethodTable, ParamsIssue, ServeOptions, Server } from "./server.ts";
export { codes, RpcError } from "./envelope.ts";
export type { ErrorObject } from "./envelope.ts";
