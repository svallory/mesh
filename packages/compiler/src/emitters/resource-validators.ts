import type { Attribute, AttributeTypeName } from "@mesh/model";
import type { Emitter } from "../emit.ts";
import { formatTypescript } from "../format.ts";
import { emitError, EmitError } from "../emit-error.ts";
import { orderedResources, outputPrefix, pathSegment } from "./order.ts";
import { header, propertyName, resourceInputs } from "./resource-types.ts";

/** Exhaustive over the model registry; a new registered type must have a mapping. */
export const VALIDATOR_TYPES = {
  string: "z.string()",
  integer: "z.int()",
  float: "z.number()",
  boolean: "z.boolean()",
  uuid: "z.uuid()",
  datetime: "z.date()",
  atom: "z.string()",
} as const satisfies Record<AttributeTypeName, string>;

function schemaFor(attribute: Attribute, optional: boolean): string {
  const values = attribute.type === "atom" ? attribute.constraints?.oneOf ?? [] : [];
  const base = values.length ? `z.enum([${values.map((value) => JSON.stringify(value.value)).join(", ")}])` : VALIDATOR_TYPES[attribute.type];
  return base + (attribute.allowNil ? ".nullable()" : "") + (optional ? ".optional()" : "");
}

/** Text only: the compiler does not load Zod while building a project. */
export const resourceValidatorsEmitter: Emitter = {
  name: "resource-validators",
  requires: ["zod"],
  async emit({ document, config }) {
    return Promise.all(orderedResources(document).map(async (resource) => {
      const segment = pathSegment(resource.name);
      const domain = resource.domain ? `${pathSegment(resource.domain)}/` : "";
      const inputs = resourceInputs(resource);
      const parts = [header(resource)];
      if (inputs.length) {
        parts.push('import { z } from "zod";', `import type { ${inputs.map((input) => input.name).join(", ")} } from ${JSON.stringify(`./${segment}.types`)};`,
          // Compare keys too: mutual assignability alone permits optional-key drift.
          // Empty inputs deliberately use a never index signature in types.
          "type Keys<T> = T extends Record<string, never> ? never : keyof T;",
          "type SameShape<A, B> = [Keys<A>] extends [Keys<B>] ? ([Keys<B>] extends [Keys<A>] ? ([A] extends [B] ? ([B] extends [A] ? true : false) : false) : false) : false;",
          "type Assert<T extends true> = T;");
        for (const input of inputs) {
          const name = input.name.charAt(0).toLowerCase() + input.name.slice(1);
          parts.push(`export const ${name} = z.strictObject({\n${input.fields.map(({ attribute, optional }) => `  ${propertyName(attribute.name.value)}: ${schemaFor(attribute, optional)},`).join("\n")}\n}) satisfies z.ZodType<${input.name}>;`,
            `export type ${input.name}Shape = Assert<SameShape<z.output<typeof ${name}>, ${input.name}>>;`);
        }
      }
      try {
        return { path: `${outputPrefix(config)}/${domain}${segment}.validators.ts`, contents: await formatTypescript(parts.join("\n\n")) };
      } catch (cause) {
        if (cause instanceof EmitError) throw cause;
        throw emitError("MESH_EMIT_VALIDATORS", `Cannot generate validators for resource "${resource.name.value}": ${cause instanceof Error ? cause.message : String(cause)}`, resource.name.position, "Report this emitter bug");
      }
    }));
  },
};
