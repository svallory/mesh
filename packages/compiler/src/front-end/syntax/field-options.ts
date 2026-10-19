import type { LoweredUnit } from "@mxlang/core";

/** `optional` belongs only to a command field, though field kinds share their contracts with attributes. */
export function checkFieldOptions(unit: LoweredUnit): void {
  for (const call of unit.calls) {
    const optional = call.attrs.find((attr) => !("spread" in attr) && attr.name === "optional");
    if (!optional || "spread" in optional || call.ancestors.at(-2)?.tag === "command") continue;
    unit.fail("`optional` is only an option of a command's field: an event field may be left out only when it is `nullable`", {
      code: "MESH_UNKNOWN_OPTION",
      ...(optional.nameSpan ? { at: optional.nameSpan } : {}),
    });
  }
}
