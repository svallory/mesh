// Bootstrap (PROTOCOL.md:40-48): an engine that starts on a database with no workspace creates it, with one
// collaborator named `owner` that holds the first owner membership, in one transaction. On a database that has its
// workspace it does nothing, so a restart on the same `--db` never bootstraps twice. It emits `collaborator.registered`
// (seq 1), `workspace.created` (seq 2) and `membership.granted` (seq 3), as the engine, with the cause
// `{ kind: "rule", rule: "workspace.bootstrap" }` (PROTOCOL.md:48).
import type { ActionContext } from "@meshfw/runtime";
import { Mesh } from "meshfw";
import { Collaborator, Membership, Workspace } from "#mesh/domain/identity";
import { engineRule } from "../rpc/context";

/** What bootstrap found or made: the workspace and its first owner, and whether this start created them. */
export interface Bootstrapped {
  readonly workspaceId: string;
  readonly created: boolean;
}

/** Runs bootstrap on `binding` (the one `bind(layer)` returns): the workspace, its first owner and the owner membership. */
export async function bootstrap(binding: { transaction<T>(fn: () => Promise<T>): Promise<T> }): Promise<Bootstrapped> {
  return binding.transaction(async () => {
    const [existing] = await Mesh.privileged(Workspace).read({ limit: 1 });
    if (existing) return { workspaceId: existing.id, created: false };
    const engine = engineRule("workspace.bootstrap");
    const owner = await Collaborator.register({ kind: "human", name: "owner" }, engine);
    const workspace = await Workspace.create({ name: null, location: "local", firstOwner: owner.id }, engine);
    // The engine grants the first owner, recorded as granted by that owner (PROTOCOL.md:48): the grant acts as the owner,
    // with `system` set, as the engine's nested calls do (ADR-0071).
    const asOwner: ActionContext = { ...engine, actor: { id: owner.id, role: null } };
    await Membership.grant({ collaborator: owner.id, role: "owner" }, asOwner);
    return { workspaceId: workspace.id, created: true };
  });
}
