/** Projects declare the flat context for each action call by merging this interface. */
export interface ActionContext {
  /**
   * Reserved (ADR-0071): the application sets it on a call it makes on its own behalf. Mesh skips no policy for it; a
   * policy admits such a call by testing `isSystem(context)`.
   */
  system?: boolean;
}
/**
 * The second parameter of every generated action, spread as a rest tuple:
 * `createPost(input, ...[context]: ContextArgument)`. Optional while every key the
 * project merged into `ActionContext` is optional (or none is declared), required
 * once one key is required (ADR-0059).
 */
export type ContextArgument = {} extends ActionContext ? [context?: ActionContext] : [context: ActionContext];

export { MeshError, InvalidInputError, NotFoundError, ForbiddenError, FrameworkError } from "./errors.ts";
export type { DenialReason, Issue, IssueSource, PolicyCheck, PolicyDenial } from "./errors.ts";
export { parseInput } from "./input.ts";
export type { StandardSchemaV1 } from "./standard-schema.ts";
export type { Row, Key, TableHandle, Scalar, Comparison, Filter, Sort, Query, DataOperations, DataLayer } from "./data-layer.ts";
export { CAPABILITIES, defineCapabilities, validateCapabilityManifest } from "./capabilities.ts";
export type { Capability, CapabilityManifest } from "./capabilities.ts";
export { uuidv7 } from "./uuid.ts";
export type { DataAdapter } from "./data-adapter.ts";
export { defineConfig, type MeshConfig, type ExtensionDescriptor } from "./config.ts";
export { expr, pinClock, rescope, scope, systemClock } from "./expr.ts";
export { checkScope, runCheck } from "./lifecycle.ts";
export { authorizer, isSystem, type Authorizer, type PolicyCheckSpec, type PolicySpec } from "./policy.ts";
export type { BindOptions, CheckSpec, SharedInput } from "./lifecycle.ts";
export type { Clock, Scope } from "./expr.ts";
export { loadRows, loadInto, unloadFrom, guarded, readOnlyRecord, cloneValue, type DeepReadonly, type Writable, rejectComputedQuery, CHUNK } from "./load.ts";
export { castInput, checkUnchanged, composer, composed, failJoined, noteWrite, writeCount } from "./compose.ts";
export type { CastOutput } from "./compose.ts";
export type { Composer, Composition } from "./compose.ts";
export type { LoadPlan, EntityPlan, RelationPlan, BelongsToPlan, HasPlan, ComputedPlan, LoadOptions } from "./load.ts";
export { recordWrite, runAction, wantsChanges } from "./seams.ts";
export type { AfterCommitEvent, AfterWriteEvent, BeforeTransactionEvent, Change, SeamContext, SeamDb, SeamTarget, Seams } from "./seams.ts";
export { BIND, BIND_READS, ENTITY, bindDomain, bindingInScope, connectBinding, entity, isEntityValue, releaseBinding, settled } from "./entity.ts";
export type { AsyncFrame, Binding, EntityBind, EntityCall, EntityReadsBind, EntityValue } from "./entity.ts";
