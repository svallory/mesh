import { dirname, posix } from "node:path";
import type { ConceptDeclaration, ModelDocument, SourcePosition } from "@meshfw/model";
import type { EmitInput } from "../emit.ts";
import { emitError } from "../emit-error.ts";
import { compareText } from "../emitters/order.ts";
import { globalsImport, type GlobalsImport } from "./globals.ts";
import { conceptLocal, conceptsUsed, entityPath, entitySegment, propertyName, schemaName, typeName, valueType } from "./inputs.ts";
import { entityFileComment } from "./types.ts";
import { fieldSchema } from "./validators.ts";

/** Every concept of the model, in the order of its file path, the fixed order of the other generators. */
export function conceptsOf(document: EmitInput["document"]): ConceptDeclaration[] {
  return [...(document.concepts ?? [])].sort((a, b) => compareText(a.file, b.file));
}

/** A concept's generated file below the output directory, without its extension: `domain/billing/money.concept`. */
export const conceptPath = (concept: ConceptDeclaration): string => `${entityPath(concept)}.concept`;
/** The file beside its module's barrel, as the barrel imports it: `./money.concept`. */
export const conceptFile = (concept: ConceptDeclaration): string => `./${entitySegment(concept)}.concept`;
/** The exported type: the concept's name (`Money`). */
export const conceptTypeName = (concept: ConceptDeclaration): string => typeName(concept.name, concept.position);
/** The exported Zod schema: `moneySchema`, by the rule every validator follows (`schemaName`). */
export const conceptSchemaName = (concept: ConceptDeclaration): string => schemaName(conceptTypeName(concept));

/** The concept of a model by its FQN; a member naming a concept the model lacks was not checked by the build. */
export function conceptByFqn(document: Pick<ModelDocument, "concepts">, fqn: string, position?: SourcePosition): ConceptDeclaration {
  const concept = document.concepts?.find((candidate) => candidate.fqn === fqn);
  if (!concept)
    throw emitError("MESH_UNKNOWN_ENTITY", `The concept ${fqn} is not in the model`, position ?? { file: "model.json", line: 1, column: 0, offset: 0 });
  return concept;
}

/** The specifier that a generated file at `fromFile` (output-relative, with or without its extension) imports `target` by. */
export function specifierFrom(fromFile: string, target: string): string {
  const path = posix.relative(dirname(fromFile), target);
  return path.startsWith(".") ? path : `./${path}`;
}

/** What a generated file imports to name one concept: its type and its schema under their locals, and from where. */
export interface ConceptImport {
  /** The type as imported: `Money as $Money$concept` (a type-only import where the file names only the type). */
  readonly type: string;
  /** The schema as imported: `moneySchema as $Money$schema`. */
  readonly schema: string;
  /** The concept's generated file, relative to the importing file, as a quoted literal: `"../money.concept"`. */
  readonly fromLiteral: string;
}
/** The imports a generated file at `fromFile` (output-relative) needs for the concepts `fqns` names, in that order. */
export function conceptImports(document: Pick<ModelDocument, "concepts">, fqns: readonly string[], fromFile: string): ConceptImport[] {
  return fqns.map((fqn) => {
    const concept = conceptByFqn(document, fqn);
    return {
      type: `${conceptTypeName(concept)} as ${conceptLocal(fqn, "concept")}`,
      schema: `${conceptSchemaName(concept)} as ${conceptLocal(fqn, "schema")}`,
      fromLiteral: JSON.stringify(specifierFrom(fromFile, conceptPath(concept))),
    };
  });
}

/** One field of a concept's type and schema. */
export interface ConceptField {
  /** The declared name. */
  readonly name: string;
  /** The property key as printed: the name, JSON-quoted when it is not an identifier. */
  readonly key: string;
  /** The TypeScript type as printed: `string`, `"cash" | "card"`, `number | null`. */
  readonly type: string;
  /** The Zod expression as printed, `.nullable()` included: `z.int().min(0)`. */
  readonly zod: string;
}

/**
 * What `concept.ts.jig` renders for one concept (ADR-0092): `<output>/domain/<module>/<name>.concept.ts`, which exports the
 * concept's type (`Money`, every member `readonly`, since a concept value has no identity and is replaced whole) and its
 * Zod schema (`moneySchema`, a strict object that `satisfies z.ZodType<Money>`). Every string is final; the template
 * prints, loops and branches on these fields and computes nothing. A project's own `concept.ts.jig` depends on this shape.
 */
export interface ConceptView {
  /** The concept file this file is generated from, project-relative, line terminators escaped as `\uXXXX`. */
  readonly file: string;
  /** `Money`: the exported type. */
  readonly name: string;
  /** `moneySchema`: the exported Zod schema. */
  readonly schema: string;
  /** In written order. */
  readonly fields: readonly ConceptField[];
  /** Each concept a field holds, sorted by FQN: its type and schema under their locals and the relative specifier. */
  readonly typeImports: readonly ConceptImport[];
  /** True when a field is `json`: the file imports `jsonValue` from `@meshfw/runtime` as `$jsonValue` (`ValidatorsView.json`). */
  readonly json: boolean;
  /** The `$globals` aliases the fields use (`$RegExp` for a `match`), from `$globals.ts`; null when they use none. */
  readonly globals: GlobalsImport | null;
}

/**
 * The view of one concept. Pure and synchronous; a name that makes no type, or a field holding a concept `document`
 * lacks, is an `EmitError`.
 */
export function conceptView(concept: ConceptDeclaration, document: Pick<ModelDocument, "concepts">): ConceptView {
  const view = {
    file: entityFileComment(concept),
    name: conceptTypeName(concept),
    schema: conceptSchemaName(concept),
    fields: concept.fields.map((field): ConceptField => ({
      name: field.name,
      key: propertyName(field.name),
      type: valueType(field),
      zod: fieldSchema(field, false),
    })),
    typeImports: conceptImports(document, conceptsUsed(concept.fields), conceptPath(concept)),
    json: concept.fields.some((field) => field.type === "json"),
  };
  return { ...view, globals: globalsImport(conceptPath(concept), view) };
}
