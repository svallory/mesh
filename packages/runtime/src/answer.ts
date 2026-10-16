import type { DataLayer, DataOperations } from "./data-layer.ts";
import type { PolicyCheck } from "./errors.ts";

/**
 * How `Mesh.checkPolicies` asks a call for its decision without letting it go further. The runtime runs the
 * call itself, on a layer made here for that one question (`answeringLayer`); the authorizer the call builds sees that
 * layer in `before` or `filter` (`answers`) and, once the policies have decided, throws an `Answer` carrying the
 * decision instead of resolving or throwing `ForbiddenError`. Neither is exported by the package (its `exports` map
 * names `index.ts` and `testing.ts` only), so user code cannot make a layer that answers, throw an `Answer` or tell
 * whether a layer answers.
 */

/** What `Mesh.checkPolicies` resolves to: whether the call would be allowed, and one entry per check that ran (ADR-0022). */
export interface Decision {
  readonly allowed: boolean;
  readonly breakdown: readonly PolicyCheck[];
}

/** Thrown by the authorizer of a call made on an answering layer, once its policies have decided. */
export class Answer {
  constructor(readonly decision: Decision) {}
}

const answering = new WeakSet<DataLayer>();

/** A layer that runs everything on `layer` and makes the authorizer of a call made on it answer instead of deciding. */
export function answeringLayer(layer: DataLayer): DataLayer {
  const answer: DataLayer = Object.freeze({
    transaction: <T>(run: (tx: DataOperations) => Promise<T>) => layer.transaction(run),
    refuseIfFailed: () => layer.refuseIfFailed(),
    close: () => layer.close(),
  });
  answering.add(answer);
  return answer;
}

/** True for a layer `answeringLayer` made. */
export function answers(layer: DataLayer): boolean {
  return answering.has(layer);
}
