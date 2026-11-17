import type { ModelDocument } from "@meshfw/model";
import { conceptByFqn, conceptPath, specifierFrom } from "./views/concepts.ts";
import { conceptLocal } from "./views/inputs.ts";

/**
 * How a generated file at `fromFile` (output-relative: `schema.ts`, `domain/billing/invoice.types`) names the concept
 * `fqn`: the local it imports the concept's type under, and the relative specifier of the concept's generated file.
 * The import is type-only: `import type { Money as $Money$concept } from "./domain/money.concept"`. Every generated file
 * follows this one naming rule, the data adapters' schema views included (ADR-0092): an adapter that types a concept
 * column prints `local` and imports it from `specifier`. A concept the model lacks is an `EmitError`.
 *
 * `conceptTypeImport(doc, "Money", "schema.ts")` gives `{ local: "$Money$concept", specifier: "./domain/money.concept" }`.
 */
export function conceptTypeImport(document: Pick<ModelDocument, "concepts">, fqn: string, fromFile: string): { local: string; specifier: string } {
  const concept = conceptByFqn(document, fqn);
  return { local: conceptLocal(concept.fqn, "concept"), specifier: specifierFrom(fromFile, conceptPath(concept)) };
}
