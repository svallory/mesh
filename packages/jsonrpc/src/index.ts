/**
 * `@meshfw/jsonrpc`: newline-delimited JSON-RPC 2.0 over a Unix socket. A project hands `serve` a method table (plain
 * data), a context factory and, optionally, the binding each call runs in; the package frames, validates, dispatches
 * and answers. `surfaceMethods` builds such a table from a surface's generated manifest. What a method means, and how a Mesh error maps to an error object, stay with the project.
 */
export { serve } from "./server.ts";
export type { Call, Connection, Method, MethodTable, ParamsIssue, ServeOptions, Server } from "./server.ts";
export { surfaceMethods } from "./surface.ts";
export type { SurfaceMethodsOptions } from "./surface.ts";
export { codes, RpcError } from "./envelope.ts";
export type { ErrorObject } from "./envelope.ts";
