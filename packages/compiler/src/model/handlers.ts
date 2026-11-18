import type { HandlerDeclaration, ModelDocument } from "@meshfw/model";

/** Every handler a `handlers` section declares, an entity's or an aggregate's, in the model's order. */
export const sectionHandlers = (document: ModelDocument): readonly HandlerDeclaration[] =>
  [...document.entities, ...(document.aggregates ?? [])].flatMap((owner) => owner.handlers ?? []);
