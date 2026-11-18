import type { LoweredUnit } from "@mxlang/core";

/**
 * `optional` belongs only to a command field, though field kinds share their contracts with attributes. The `lock` step
 * takes a flag of that name too (`lock &version optional`, ADR-0100), which is its own and is left alone.
 */
export function checkFieldOptions(unit: LoweredUnit): void {
  for (const call of unit.calls) {
    const optional = call.attrs.find((attr) => !("spread" in attr) && attr.name === "optional");
    const parent = call.ancestors.at(-2)?.tag;
    if (!optional || "spread" in optional || parent === "command" || call.ancestors.at(-1)?.tag === "lock") continue;
    const message = "`optional` is only an option of a command's field";
    unit.fail(message + (parent === "event" ? ": an event field may be left out only when it is `nullable`" : ""), {
      code: "MESH_UNKNOWN_OPTION",
      ...(optional.nameSpan ? { at: optional.nameSpan } : {}),
    });
  }
}
