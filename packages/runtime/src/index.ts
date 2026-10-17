/** Projects declare the flat context for each action call by merging this interface. */
export interface ActionContext {
  /**
   * Reserved (ADR-0071): the application sets it on a call it makes on its own behalf. Mesh skips no policy for it; a
   * policy admits such a call by testing `Mesh.isSystem(context)`.
   */
  system?: boolean;
}
/**
 * What the project's `metadata` function returns for each published event, stored as the event's `metadata`. Projects
 * declare its keys by merging this interface, in `src/context.ts` as for `ActionContext`.
 */
export interface EventMetadata {}

/**
 * The second parameter of every generated action, spread as a rest tuple:
 * `createPost(input, ...[context]: ContextArgument)`. Optional while every key the
 * project merged into `ActionContext` is optional (or none is declared), required
 * once one key is required (ADR-0059).
 */
export type ContextArgument = {} extends ActionContext ? [context?: ActionContext] : [context: ActionContext];

export { MeshError, InvalidInputError, NotFoundError, ForbiddenError, FrameworkError, DatabaseBusyError, EventsDeletedError, CursorAheadError, EventUndeclaredError } from "./errors.ts";
export type { DenialReason, Issue, IssueSource, MeshErrorOptions, PolicyCheck, PolicyDenial } from "./errors.ts";
export { parseInput } from "./input.ts";
export { DECLARATION, checkFields, fqnOf, type Declaration, type Declared } from "./declarations.ts";
export { jsonValue, type JsonContext } from "./json.ts";
export type { StandardSchemaV1 } from "./standard-schema.ts";
export type { Row, Key, TableHandle, Scalar, Comparison, Filter, Sort, Query, DataOperations, DataLayer, OutboxAppend, OutboxOperations, OutboxPage, OutboxRow } from "./data-layer.ts";
export { CAPABILITIES, defineCapabilities, validateCapabilityManifest } from "./capabilities.ts";
export type { Capability, CapabilityManifest } from "./capabilities.ts";
export { uuidv7 } from "./uuid.ts";
export { CORE_TABLES, CORE_TABLE_NAMES, OUTBOX_STATE_TABLE, OUTBOX_TABLE, coreTablesFor } from "./core-tables.ts";
export type { CoreColumn, CoreColumnType, CoreTable } from "./core-tables.ts";
export type { DataAdapter } from "./data-adapter.ts";
export { defineConfig, type MeshConfig, type ExtensionDescriptor } from "./config.ts";
export { expr, pinClock, rescope, scope, systemClock } from "./expr.ts";
export { checkScope, runCheck } from "./lifecycle.ts";
export { authorizer, type Authorizer, type PolicyCheckSpec, type PolicySpec } from "./policy.ts";
export type { BindOptions, CheckSpec, SharedInput } from "./lifecycle.ts";
export type { Clock, Scope } from "./expr.ts";
export { loadRows, loadInto, unloadFrom, guarded, readOnlyRecord, cloneValue, type DeepReadonly, type Writable, rejectComputedQuery, CHUNK } from "./load.ts";
export { castInput, checkUnchanged, failJoined, noteWrite, writeCount } from "./compose.ts";
export type { CastOutput } from "./compose.ts";
export type { LoadPlan, EntityPlan, RelationPlan, BelongsToPlan, HasPlan, ComputedPlan, LoadOptions } from "./load.ts";
export { recordWrite, runAction, wantsChanges } from "./seams.ts";
export { Mesh, type ActionFunction, type Decision, type MeshFunctions } from "./mesh.ts";
export type { AfterCommitEvent, AfterWriteEvent, BeforeTransactionEvent, Change, SeamContext, SeamDb, SeamTarget, Seams } from "./seams.ts";
export { BIND, BIND_READS, ENTITY, NO_FRAME, bindDomain, bindingInScope, connectBinding, entity, isEntityValue, published, readEvents, releaseBinding, settled } from "./entity.ts";
export { KEEP_VALUES, loadEvents, publishEvent, rows } from "./events.ts";
export type { EventClass, EventRecord, EventsConfig, EventsModule, MetadataArguments, MetadataFunction, PublishTarget, ReadEventsPage, ReadEventsQuery } from "./events.ts";
export type { ActionFrame, AsyncFrame, Binding, EntityBind, EntityCall, EntityReadsBind, EntityValue, Privileged } from "./entity.ts";
