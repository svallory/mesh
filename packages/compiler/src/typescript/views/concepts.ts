import type { ConceptDeclaration } from "@meshfw/model";
import type { EmitInput } from "../emit.ts";
import { compareText } from "../emitters/order.ts";
import { globalsImport, type GlobalsImport } from "./globals.ts";
import { entityPath, entitySegment, propertyName, schemaName, typeName, valueType } from "./inputs.ts";
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
 * What `concept.ts.jig` renders for one concept (ADR-0089): `<output>/domain/<module>/<name>.concept.ts`, which exports the
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
  /**
   * Each concept a field holds: its type and schema locals and the relative specifier. Always empty until a concept
   * field may hold a concept.
   */
  readonly typeImports: readonly { readonly type: string; readonly schema: string; readonly fromLiteral: string }[];
  /** True when a field is `json`: the file imports `jsonValue` from `@meshfw/runtime` as `$jsonValue` (`ValidatorsView.json`). */
  readonly json: boolean;
  /** The `$globals` aliases the fields use (`$RegExp` for a `match`), from `$globals.ts`; null when they use none. */
  readonly globals: GlobalsImport | null;
}

/** The view of one concept. Pure and synchronous; a name that makes no type is an `EmitError`. */
export function conceptView(concept: ConceptDeclaration): ConceptView {
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
    typeImports: [],
    json: concept.fields.some((field) => field.type === "json"),
  };
  return { ...view, globals: globalsImport(conceptPath(concept), view) };
}
