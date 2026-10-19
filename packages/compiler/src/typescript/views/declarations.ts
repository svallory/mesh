import { attributeTypeInfo, type CommandDeclaration, type EventDeclaration } from "@meshfw/model";
import type { EmitInput } from "../emit.ts";
import { classNameOf } from "../../model/class-name.ts";
import { globalsImport, type GlobalsImport } from "./globals.ts";
import { entityFileComment } from "./types.ts";
import { entityLocal, entityPath, propertyName, valueType } from "./inputs.ts";
import { fieldSchema } from "./validators.ts";

const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/** What an event or a command is to the generators: the same plain data, told apart by its kind. */
export type Declaration = EventDeclaration & { readonly kind: "event" | "command" };

/** Every event and command of the model, events first, each in the order of its file path, the fixed order of the other generators. */
export function declarationsOf(document: EmitInput["document"]): Declaration[] {
  const byFile = (a: { file: string }, b: { file: string }) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0);
  return [
    ...[...(document.events ?? [])].sort(byFile).map((declaration) => ({ ...declaration, kind: "event" as const })),
    ...[...(document.commands ?? [])].sort(byFile).map((declaration) => ({ ...declaration, kind: "command" as const })),
  ];
}

/** The file's name beside its module's barrel: `domain/billing/invoicePaid.event.ts` is written `<segment>.event.ts`. */
export const declarationFile = (declaration: Pick<Declaration, "kind">): string => `.${declaration.kind}`;
/** A declaration's generated file below the output directory, without its extension: `domain/billing/invoicePaid.event`. */
export const declarationPath = (declaration: Declaration): string => `${entityPath(declaration)}${declarationFile(declaration)}`;
/** The name of the class: the declared name with its first letter in upper case (`invoicePaid` and `invoice_paid` are `InvoicePaid`; `model/class-name.ts`). */
export const className = (declaration: Pick<Declaration, "name">): string => classNameOf(declaration.name);
/** The local another generated file imports the class under: `$billing$InvoicePaid$class`, by the rule every entity local follows. */
export const classLocal = (declaration: Pick<Declaration, "module" | "name" | "position">): string => entityLocal({ ...declaration, name: className(declaration) }, "class");

/** One field of the generated class. */
export interface DeclarationField {
  /** The declared name. */
  readonly name: string;
  /** The property key as printed. */
  readonly key: string;
  /** How code reads or sets the property: `.invoiceId`, or `["a-b"]` for a name that is no identifier. */
  readonly access: string;
  /** What the property holds, as printed: `string`, or `string | null`. */
  readonly type: string;
  /** The instance property's type: an optional command field also admits `undefined`; an event field never does. */
  readonly instanceType: string;
  /** True when the constructor may leave it out: a nullable field, kept undefined on a command and null on an event. */
  readonly optional: boolean;
  /** The Zod expression the constructor checks it with, as printed in a validator. */
  readonly schema: string;
  /** What the constructor assigns: `$checked.invoiceId`; only an optional event field adds `?? null`. */
  readonly assignment: string;
}

/**
 * What `declaration.ts.jig` renders for one event or command: a class whose constructor checks every field against the
 * declaration and freezes the instance, an ES private field making it nominal. Every string is final; the template prints,
 * loops and branches on these fields and computes nothing. A project's own `declaration.ts.jig` depends on this shape.
 */
export interface DeclarationView {
  /** The event or command file this file is generated from, project-relative, line terminators escaped as `\uXXXX`. */
  readonly file: string;
  /** `event` or `command`. */
  readonly kind: "event" | "command";
  /** The class's name, e.g. `InvoicePaid`. */
  readonly className: string;
  /** The FQN as a quoted string literal, e.g. `"billing.InvoicePaid"`. */
  readonly fqnLiteral: string;
  /** The kind as a quoted string literal, `"event"` or `"command"`. */
  readonly kindLiteral: string;
  readonly fields: readonly DeclarationField[];
  /** The names of the fields that hold a date, as an array literal (`["paidAt"]`): stored as text in JSON, revived by `readEvents`. */
  readonly datesLiteral: string;
  /** True when a field is `json`: the file imports `jsonValue` as `$jsonValue`. */
  readonly json: boolean;
  /** The globals the file names (`$Date`, `$RegExp`), from `$globals.ts`; null when it names none. */
  readonly globals: GlobalsImport | null;
}

/** The view of one event or command. Pure and synchronous. */
export function declarationView(declaration: Declaration): DeclarationView {
  const name = className(declaration);
  const fields = declaration.fields.map((field): DeclarationField => {
    const optional = field.nullable;
    const type = valueType(field);
    return {
      name: field.name,
      key: propertyName(field.name),
      access: IDENTIFIER.test(field.name) ? `.${field.name}` : `[${JSON.stringify(field.name)}]`,
      type,
      instanceType: type + (optional && declaration.kind === "command" ? " | undefined" : ""),
      optional,
      schema: fieldSchema(field, optional),
      assignment: `$checked${IDENTIFIER.test(field.name) ? `.${field.name}` : `[${JSON.stringify(field.name)}]`}${optional && declaration.kind === "event" ? " ?? null" : ""}`,
    };
  });
  const view = {
    file: entityFileComment(declaration),
    kind: declaration.kind,
    className: name,
    fqnLiteral: JSON.stringify(declaration.fqn),
    kindLiteral: JSON.stringify(declaration.kind),
    fields,
    datesLiteral: JSON.stringify(declaration.fields.filter((field) => attributeTypeInfo(field.type).tsType === "Date").map((field) => field.name)),
    json: declaration.fields.some((field) => field.type === "json"),
  };
  // The template prints `$Object.freeze` itself.
  return { ...view, globals: globalsImport(declarationPath(declaration), view, ["Object"]) };
}
