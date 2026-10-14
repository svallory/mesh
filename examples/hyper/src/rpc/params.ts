// The parameters of each method the engine serves, as zod schemas. They mirror the spec's `Methods`
// (`conformance/schemas/protocol.ts:376-705`, copied from the spec at commit `ccc00f9`), written by hand; the
// conformance cases check the mirror. A schema keeps the spec's field names: the methods in `methods.ts` turn them into
// the inputs of the port's actions.
import { z } from "zod";

/** An engine-generated identifier (`Id`). Clients never parse it, so any non-empty string is well formed. */
const Id = z.string().min(1);
const NonEmpty = z.string().min(1);
const Role = z.enum(["owner", "member", "guest"]);
const CollaboratorKind = z.enum(["human", "agent"]);
const Reason = z.string().optional();

/** The fields every command carries beside its payload (`PROTOCOL.md:73-91`). */
const envelope = {
  commandId: z.string().min(1).max(200),
  actor: Id,
  caller: NonEmpty,
  expectedVersion: z.number().int().min(1).optional(),
};

/** A command's params: the envelope, and `payload`, an object (`{}` when the command has no fields). */
const command = <P extends z.ZodRawShape>(payload: P) => z.object({ ...envelope, payload: z.object(payload) });

export const params = {
  "workspace.create": command({ name: z.string().optional() }),
  "workspace.rename": command({ name: NonEmpty }),
  "collaborator.register": command({ kind: CollaboratorKind, name: NonEmpty }),
  "collaborator.update": command({ collaboratorId: Id, name: NonEmpty.optional(), kind: CollaboratorKind.optional() }),
  "collaborator.retire": command({ collaboratorId: Id, reason: Reason }),
  "membership.grant": command({ collaboratorId: Id, role: Role }),
  "membership.change-role": command({ collaboratorId: Id, role: Role }),
  "membership.revoke": command({ collaboratorId: Id, reason: Reason }),
  "task.create": command({
    title: NonEmpty,
    intent: z.string().nullable().optional(),
    parentId: Id.nullable().optional(),
    priority: z.number().int().nullable().optional(),
  }),
} as const;
