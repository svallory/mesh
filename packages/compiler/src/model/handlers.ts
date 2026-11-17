import type { Diagnostic, HandlerDeclaration, ModelDocument } from "@meshfw/model";
import { error } from "./diagnostics.ts";

/** Every handler a `handlers` section declares, an entity's or an aggregate's, in the model's order. */
export const sectionHandlers = (document: ModelDocument): readonly HandlerDeclaration[] =>
  [...document.entities, ...(document.aggregates ?? [])].flatMap((owner) => owner.handlers ?? []);

/**
 * Handlers declared in a `handlers` section are not generated yet, so a project that declares one would build handlers
 * that never run: until the generator exists, each line is `MESH_NOT_IMPLEMENTED` (the roadmap's "no silent fallback").
 * Temporary: it goes when the handlers are generated and registered.
 */
export function handlersNotGenerated(document: ModelDocument): Diagnostic[] {
  return sectionHandlers(document).map((handler) => error("MESH_NOT_IMPLEMENTED",
    `handlers are not generated yet: ${handler.kind} :${handler.name} would build and never run; they arrive with the next release`,
    handler.position, "register the handler in the events module (`src/events.ts`) for now"));
}
