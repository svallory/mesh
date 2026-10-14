/**
 * Shared setup for the conformance suite. Each test file starts its own
 * engine (fresh socket and database) from ENGINE_CMD. Without ENGINE_CMD the
 * whole suite is reported as skipped.
 */
import { afterAll, beforeAll, describe } from "bun:test";
import { ENGINE_CMD, type EngineOptions } from "../harness/engine.ts";
import { type Actor, World } from "../harness/world.ts";

export { E, expectRejected, hookFailures, newCommandId, phaseOf, types, until } from "../harness/world.ts";
export type { Actor } from "../harness/world.ts";
export { World };

/** `describe`, or `describe.skip` when no engine is configured. */
export const suite: typeof describe = (ENGINE_CMD ? describe : describe.skip) as typeof describe;

/** Starts one engine for the enclosing describe block; returns a getter. */
export function useWorld(opts: EngineOptions = {}): () => World {
  let world: World | undefined;
  beforeAll(async () => {
    world = await World.start(opts);
  }, 60_000);
  afterAll(async () => {
    await world?.dispose();
  });
  return () => {
    if (!world) throw new Error("engine did not start (see beforeAll error)");
    return world;
  };
}

/**
 * A lead with a parent Task and one child assigned to a worker.
 * The lead created both, so the lead is the child's reviewer (parent-creator).
 */
export async function leadWithChild(w: World, opts: { waiveReview?: boolean; intent?: string } = {}) {
  const lead = await w.add("lead");
  const worker = await w.add("worker");
  const parent = await lead.create("Parent", { intent: "ship it" });
  const child = await lead.create("Child", { parentId: parent.id, intent: opts.intent ?? "do the child" });
  await lead.do("task.assign", { taskId: child.id, assigneeId: worker.id, waiveReview: opts.waiveReview ?? false });
  return { lead, worker, parent, child };
}

/** Claims and submits; returns the claim fence and the submission. */
export async function claimAndSubmit(actor: Actor, taskId: string, summary = "done", evidence?: string[]) {
  const { claim } = await actor.do("claim.acquire", { taskId });
  const r = await actor.do("submission.submit", { taskId, fence: claim.fence, summary, evidence });
  if (r.outcome !== "submitted") throw new Error(`expected a submission, got ${r.outcome}`);
  return { fence: claim.fence, submission: r.submission };
}
