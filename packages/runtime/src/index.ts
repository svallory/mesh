/** Projects declare the flat context for each action call by merging this interface. */
export interface ActionContext {}

export { MeshError, InvalidInputError, NotFoundError, ForbiddenError, FrameworkError } from "./errors.ts";
export type { Issue, IssueSource, PolicyCheck } from "./errors.ts";
export { parseInput } from "./input.ts";
export type { StandardSchemaV1 } from "./standard-schema.ts";
export type { Row, Key, TableHandle, DataOperations, DataLayer } from "./data-layer.ts";
export type { DataAdapter } from "./data-adapter.ts";
export { defineConfig, type MeshConfig, type ExtensionDescriptor } from "./config.ts";
