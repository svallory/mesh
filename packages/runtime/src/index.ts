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

export { MeshError, InvalidInputError, NotFoundError, ForbiddenError, FrameworkError, DatabaseBusyError, EventsDeletedError, CursorAheadError, EventUndeclaredError, EventsConfigError, HandlerOptionError, DelivererTakenError, DelivererLostError, HandlerLostError, SubscriptionOverflowError, HandlerStoppedError, PolicyGuardDenial, guardDenialOf } from "./errors.ts";
export type { ClaimHolder, DatabaseBusyOptions, DatabaseBusyReason, StoppedHandler, DenialReason, Issue, IssueSource, MeshErrorOptions, PolicyCheck, PolicyDenial } from "./errors.ts";
export { parseInput } from "./input.ts";
export { DECLARATION, checkFields, fqnOf, type Declaration, type Declared } from "./declarations.ts";
export { dispatchCommand, type ActionResult, type CommandAction } from "./dispatch.ts";
export { jsonValue, type JsonContext } from "./json.ts";
export type { StandardSchemaV1 } from "./standard-schema.ts";
export type { ClaimRenewalOptions, Row, Key, TableHandle, Scalar, Comparison, Filter, Sort, Query, RollupFn, RollupHop, RollupQuery, RollupRow, DataOperations, DataLayer, DelivererClaim, DeliveryOperations, DeliveryProcessRow, DeliveryState, FailureCursor, FailureOperations, FailureRow, HandlerLeaseRow, HandlerProgressRow, LockedDeliveryState, MultiProcessOperations, OutboxAppend, OutboxOperations, OutboxPage, OutboxRow, RawRow, RetentionOperations, RawStatement, RawValue, SubscriptionFilter, SubscriptionOwnerRow, SubscriptionProgressRow, TransactionOptions, WriteGuard } from "./data-layer.ts";
export { ROLLUP_ANCHORS } from "./data-layer.ts";
export { SQL_FUNCTION_ARITY, allOf, bindCondition, callerQuery, hasHop, orderOf, whereFor } from "./condition.ts";
export type { Bound, CallerComputed, CallerQuery, CallerSql, Condition, ConditionLiteral, ConditionNode, DeclaredKey, Hop, LiteralNode, Mark, OrderKey, ParamNode, SqlFunction, TableOf, ValueClass, Where } from "./condition.ts";
export { CAPABILITIES, defineCapabilities, validateCapabilityManifest } from "./capabilities.ts";
export type { Capability, CapabilityManifest } from "./capabilities.ts";
export { uuidv7 } from "./uuid.ts";
export { CORE_TABLES, CORE_TABLE_NAMES, DELIVERY_PROCESS_TABLE, FAILURES_TABLE, HANDLER_PROGRESS_TABLE, MULTI_PROCESS_CORE, OUTBOX_STATE_TABLE, OUTBOX_TABLE, SUBSCRIPTION_PROGRESS_TABLE, coreTablesFor } from "./core-tables.ts";
export type { CoreColumn, CoreColumnType, CoreTable } from "./core-tables.ts";
export type { DataAdapter } from "./data-adapter.ts";
export { defineConfig, type MeshConfig, type ExtensionDescriptor } from "./config.ts";
export { expr, pinClock, rescope, scope, systemClock } from "./expr.ts";
export { checkScope, runCheck } from "./lifecycle.ts";
export { authorizer, type Authorizer, type PolicyCheckSpec, type PolicySpec } from "./policy.ts";
export type { BindOptions, CheckSpec, SharedInput } from "./lifecycle.ts";
export type { Clock, Scope } from "./expr.ts";
export { loadRows, loadInto, unloadFrom, guarded, readOnlyRecord, cloneValue, type DeepReadonly, type Writable, CHUNK } from "./load.ts";
export { castInput, checkUnchanged, failJoined, noteWrite, writeCount } from "./compose.ts";
export { relateRows, type KeyedItem, type NewItem, type RelateSpec } from "./relate.ts";
export type { CastOutput, ReadCap } from "./compose.ts";
export type { LoadPlan, EntityPlan, RelationPlan, BelongsToPlan, HasPlan, ComputedPlan, LoadOptions } from "./load.ts";
export { recordWrite, runAction, wantsChanges } from "./seams.ts";
export { checkRead, defineSurface, project, type NarrowedFilter, type NarrowedSort, type Projected, type Surface, type SurfaceAction, type SurfaceActionKind, type SurfaceExposure, type SurfaceReadInput } from "./surface.ts";
export { Mesh, type ActionFunction, type Decision, type MeshFunctions } from "./mesh.ts";
export type { AfterCommitEvent, AfterWriteEvent, BeforeTransactionEvent, Change, SeamContext, SeamDb, SeamTarget, Seams } from "./seams.ts";
export { BIND, BIND_READS, ENTITY, NO_FRAME, bindDomain, bindingInScope, connectBinding, declaredEvents, entity, isEntityValue, makeQuery, published, readEvents, releaseBinding, settled } from "./entity.ts";
export { KEEP_VALUES, keepEventsProblems, keepProblem, loadEvents, MAX_KEEP_DAYS, mergeHandlers, publishEvent, rows } from "./events.ts";
export { renamedMap, renamedProblems, renamedShapeProblems, resolveEventName, storedToDeclared } from "./stored-names.ts";
export type { EventNameResolution, RenamedProblem } from "./stored-names.ts";
export type { EventClass, EventRecord, EventsConfig, EventsModule, Keep, KeepProblem, KeepRules, MetadataArguments, PerEventKeep, MetadataFunction, PublishTarget, ReadEventsPage, ReadEventsQuery, SectionHandlers } from "./events.ts";
export { BUS_CAPABILITIES, HANDLER_KIND, busProblem, checkedBus, handler } from "./bus.ts";
export type { BusCapability, BusCore, BusManifest, BusOptions, EventBus, EventBusCapabilities, EventBusInstance, Handler, HandlerKind, HandlerTools, KindHandler, ListedEvent, LiveSubscription, OnFailure, Registration, RegisteredHandler } from "./bus.ts";
export { adoptByName, adoptHandler, declaredHandlers, deliverRound, forgetByName, forgetHandler, forgetSubscription, isRetryable, keepByValue, listSubscriptions, markNoDeliver, resumeHandler, retryFailed, startDelivery, subscribe } from "./deliverer.ts";
export type { Delivery, Forgotten, RetryFailedResult, SubscribeQuery, Subscription, SubscriptionProgress } from "./deliverer.ts";
export type { Adopted, KeepChange } from "./multi-process.ts";
export { OPERATIONS, SERVICE, isServiceValue, service } from "./service.ts";
export type { OperationCall, OperationScope, OperationSpec, ServiceValue } from "./service.ts";
export type { ActionFrame, AsyncFrame, Binding, EntityBind, EntityCall, EntityReadsBind, EntityValue, Privileged, RawQuery } from "./entity.ts";
