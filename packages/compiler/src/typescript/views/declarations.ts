import { attributeTypeInfo, type CommandDeclaration, type EventDeclaration } from "@meshfw/model";
import type { EmitInput } from "../emit.ts";
import { classNameOf } from "../../model/class-name.ts";
import { globalsImport, type GlobalsImport } from "./globals.ts";
import { entityFileComment } from "./types.ts";
import { baseType, entityLocal, entityPath, propertyName, valueType } from "./inputs.ts";
import { fieldSchema, ruleTable } from "./validators.ts";

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
  /**
   * What the constructor takes for it, as printed: `type`, except that a date is `$DeepReadonly<$Date>`, the `Date`
   * without its setters that a function reads off its scope (`&paidAt`) and off a record an action returned. A `Date`
   * fits it too, so a caller hands over either; the constructor stores a fresh `$Date` of the same instant (see
   * `assignment`), so the property really is the `$Date` it is typed as, never the read-only view.
   */
  readonly parameterType: string;
  /** The instance property's type: an optional command field also admits `undefined`; an event field never does. */
  readonly instanceType: string;
  /** True for an explicitly optional command instance property. */
  readonly instanceOptional: boolean;
  /** True when the constructor may leave it out: a nullable or optional field, kept undefined on a command and null on an event. */
  readonly optional: boolean;
  /** The Zod expression the constructor checks it with, as printed in a validator. */
  readonly schema: string;
  /**
   * What the constructor assigns: `$checked.invoiceId`; an optional event field adds `?? null`. A date is copied,
   * `new $Date($checked.paidAt.getTime())`, so the instance never holds the read-only view a caller may pass (which
   * `structuredClone` refuses); a nullable or optional date keeps its null or undefined (an event's turns into null).
   */
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
  /** True when a field holds a date: the file imports the type `DeepReadonly` as `$DeepReadonly`, which a `parameterType` names. */
  readonly deepReadonly: boolean;
  /**
   * The `$ruled` table of the fields' line rules as printed (see `InputSchema.rules` in `validators.ts`), or `null` when
   * no field has one: the file then declares no `$ruled` helper and prints the schema unwrapped.
   */
  readonly rules: string | null;
  /** The globals the file names (`$Date`, `$RegExp`), from `$globals.ts`; null when it names none. */
  readonly globals: GlobalsImport | null;
}

/** True for a field whose values are a `Date`: `date`, `datetime` and `timestamp`. */
const holdsDate = (field: Pick<Declaration["fields"][number], "type">): boolean => attributeTypeInfo(field.type).tsType === "Date";

/** What the constructor assigns to a field read as `read` off the checked fields (see `DeclarationField.assignment`). */
function assignmentOf(read: string, date: boolean, optional: boolean, kind: Declaration["kind"]): string {
  const absent = kind === "event" ? "null" : read;
  if (date) return optional ? `${read} == null ? ${absent} : new $Date(${read}.getTime())` : `new $Date(${read}.getTime())`;
  return optional && kind === "event" ? `${read} ?? null` : read;
}

/** The view of one event or command. Pure and synchronous. */
export function declarationView(declaration: Declaration): DeclarationView {
  const name = className(declaration);
  const fields = declaration.fields.map((field): DeclarationField => {
    const optional = field.nullable || (declaration.kind === "command" && field.optional === true);
    const type = valueType(field);
    return {
      name: field.name,
      key: propertyName(field.name),
      access: IDENTIFIER.test(field.name) ? `.${field.name}` : `[${JSON.stringify(field.name)}]`,
      type,
      parameterType: holdsDate(field) ? `$DeepReadonly<${baseType(field)}>${field.nullable ? " | null" : ""}` : type,
      instanceType: type + (optional && declaration.kind === "command" ? " | undefined" : ""),
      instanceOptional: declaration.kind === "command" && field.optional === true,
      optional,
      schema: fieldSchema(field, optional),
      assignment: assignmentOf(`$checked${IDENTIFIER.test(field.name) ? `.${field.name}` : `[${JSON.stringify(field.name)}]`}`, holdsDate(field), optional, declaration.kind),
    };
  });
  const view = {
    file: entityFileComment(declaration),
    kind: declaration.kind,
    className: name,
    fqnLiteral: JSON.stringify(declaration.fqn),
    kindLiteral: JSON.stringify(declaration.kind),
    fields,
    datesLiteral: JSON.stringify(declaration.fields.filter(holdsDate).map((field) => field.name)),
    json: declaration.fields.some((field) => field.type === "json"),
    deepReadonly: declaration.fields.some(holdsDate),
    rules: ruleTable(declaration.fields),
  };
  // The template prints `$Object.freeze` itself.
  return { ...view, globals: globalsImport(declarationPath(declaration), view, ["Object"]) };
}
