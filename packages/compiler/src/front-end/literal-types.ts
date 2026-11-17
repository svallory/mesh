import type { Atom, Attribute, ConceptDeclaration, Literal } from "@meshfw/model";

type LiteralField = Pick<Attribute, "type" | "nullable" | "values" | "concept">;
/** The concept an FQN names, for the literal of a concept member; `undefined` when the build has none of that FQN. */
export type ConceptResolver = (fqn: string) => ConceptDeclaration | undefined;
const uuid = /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$/i;
function date(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === value;
}
function datetime(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.test(value)
    && date(value.slice(0, 10)) && Number.isFinite(Date.parse(value));
}

/**
 * Tells an atom the author wrote (`:x`) from an object literal of the same shape (`{ value: "x" }`); `isAtomLiteral`
 * while the build runs. Without it, an atom is read by its shape.
 */
export type AtomTest = (value: unknown) => boolean;
const byShape: AtomTest = (value) => typeof value === "object" && value !== null && !Array.isArray(value)
  && Object.keys(value).length === 1 && "value" in value;

/**
 * Static compatibility only; function bodies are never evaluated. A concept member (`field.concept`) takes an object
 * literal whose keys are exactly the concept's fields, each value fitting its field (an enum field an atom of its values,
 * a nested concept recursively, a json field anything but an atom), and needs `concepts` to see them; without it, or for
 * a concept the build has not, the literal does not fit. With `isAtom`, an atom and an object literal are told apart
 * by what the author wrote: an enum field takes only an atom, a concept only an object, and a json field no atom at any
 * depth (as a `json` member, `MESH_SET_VALUE`).
 */
export function literalFits(value: Literal | Atom, field: LiteralField, concepts?: ConceptResolver, isAtom?: AtomTest): boolean {
  if (value === null) return field.nullable;
  switch (field.type) {
    case "concept": {
      const concept = field.concept === undefined ? undefined : concepts?.(field.concept);
      if (!concept || typeof value !== "object" || Array.isArray(value) || isAtom?.(value)) return false;
      const keys = Object.keys(value);
      return keys.length === concept.fields.length
        && concept.fields.every((each) => Object.hasOwn(value, each.name)
          && literalFits((value as Record<string, Literal | Atom>)[each.name]!, each, concepts, isAtom));
    }
    case "enum": return (isAtom ?? byShape)(value)
      && field.values?.some((atom) => atom.value === (value as Atom).value) === true;
    case "integer": return typeof value === "number" && Number.isFinite(value) && Number.isInteger(value);
    case "float":
    case "decimal": return typeof value === "number" && Number.isFinite(value);
    case "boolean": return typeof value === "boolean";
    case "string": return typeof value === "string";
    case "json": return isAtom === undefined || !holdsAtom(value, isAtom);
    case "uuid": return typeof value === "string" && uuid.test(value);
    case "date": return typeof value === "string" && date(value);
    case "datetime":
    case "timestamp": return typeof value === "string" && datetime(value);
  }
}

/** True when `value` is an atom or holds one in a list or object at any depth. */
export function holdsAtom(value: Literal | Atom, isAtom: AtomTest): boolean {
  if (isAtom(value)) return true;
  if (Array.isArray(value)) return value.some((each) => holdsAtom(each, isAtom));
  if (typeof value === "object" && value !== null) return Object.values(value).some((each) => holdsAtom(each as Literal, isAtom));
  return false;
}
