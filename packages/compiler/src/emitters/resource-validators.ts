import type { AttributeType } from "@mesh/model";
import type { Emitter } from "../emit.ts";
import { formatTypescript } from "../format.ts";
import { orderedEntities, outputPrefix } from "./order.ts";
import {
  entityInputs,
  entityPath,
  entitySegment,
  header,
  propertyName,
  type FieldShape,
} from "./resource-types.ts";

export const VALIDATOR_TYPES = {
  string: "z.string()",
  integer: "z.int()",
  float: "z.number()",
  decimal: "z.number()",
  boolean: "z.boolean()",
  uuid: "z.uuid()",
  date: "z.date()",
  datetime: "z.date()",
  timestamp: "z.date()",
  enum: "z.string()",
} as const satisfies Record<AttributeType, string>;
function schemaFor(field: FieldShape, optional: boolean): string {
  let base =
    field.type === "enum"
      ? `z.enum([${(field.values ?? []).map((v) => JSON.stringify(v.value)).join(", ")}])`
      : VALIDATOR_TYPES[field.type];
  if (field.min !== undefined) base += `.min(${field.min})`;
  if (field.max !== undefined) base += `.max(${field.max})`;
  if (field.match)
    base += `.regex(new RegExp(${JSON.stringify(field.match.pattern)}, ${JSON.stringify(field.match.flags)}))`;
  return (
    base +
    (field.nullable ? ".nullable()" : "") +
    (optional ? ".optional()" : "")
  );
}
/** Text only: never loads Zod while building. Legacy id changes in round 3. */
export const entityValidatorsEmitter: Emitter = {
  name: "resource-validators",
  requires: ["zod"],
  async emit({ document, config }) {
    return Promise.all(
      orderedEntities(document).map(async (entity) => {
        const inputs = entityInputs(entity, document);
        const parts = [header(entity)];
        if (inputs.length) {
          parts.push(
            'import { z } from "zod";',
            `import type { ${inputs.map((i) => i.name).join(", ")} } from ${JSON.stringify(`./${entitySegment(entity)}.types`)};`,
            "type Keys<T> = T extends Record<string, never> ? never : keyof T;",
            "type SameShape<A, B> = [Keys<A>] extends [Keys<B>] ? ([Keys<B>] extends [Keys<A>] ? ([A] extends [B] ? ([B] extends [A] ? true : false) : false) : false) : false;",
            "type Assert<T extends true> = T;",
          );
          for (const input of inputs) {
            const name = input.name[0]!.toLowerCase() + input.name.slice(1);
            parts.push(
              `export const ${name} = z.strictObject({\n${input.fields.map(({ attribute, optional }) => `${propertyName(attribute.name)}: ${schemaFor(attribute, optional)},`).join("\n")}\n}) satisfies z.ZodType<${input.name}>;`,
              `export type ${input.name}Shape = Assert<SameShape<z.output<typeof ${name}>, ${input.name}>>;`,
            );
          }
        }
        return {
          path: `${outputPrefix(config)}/${entityPath(entity)}.validators.ts`,
          contents: await formatTypescript(parts.join("\n\n")),
        };
      }),
    );
  },
};
