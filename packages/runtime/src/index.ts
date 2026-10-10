/** Projects declare the flat context for each action call by merging this interface. */
export interface ActionContext {}
/**
 * The second parameter of every generated action, spread as a rest tuple:
 * `createPost(input, ...[context]: ContextArgument)`. Optional while every key the
 * project merged into `ActionContext` is optional (or none is declared), required
 * once one key is required (ADR-0059).
 */
export type ContextArgument = {} extends ActionContext ? [context?: ActionContext] : [context: ActionContext];

export { MeshError, InvalidInputError, NotFoundError, ForbiddenError, FrameworkError } from "./errors.ts";
export type { Issue, IssueSource, PolicyCheck } from "./errors.ts";
export { parseInput } from "./input.ts";
export type { StandardSchemaV1 } from "./standard-schema.ts";
export type { Row, Key, TableHandle, Scalar, Comparison, Filter, Sort, Query, DataOperations, DataLayer } from "./data-layer.ts";
export { CAPABILITIES, defineCapabilities, validateCapabilityManifest } from "./capabilities.ts";
export type { Capability, CapabilityManifest } from "./capabilities.ts";
export { uuidv7 } from "./uuid.ts";
export type { DataAdapter } from "./data-adapter.ts";
export { defineConfig, type MeshConfig, type ExtensionDescriptor } from "./config.ts";
