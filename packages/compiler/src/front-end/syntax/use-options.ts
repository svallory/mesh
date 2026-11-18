import type { LoweredUnit } from "@mxlang/core";

/**
 * `use` includes what its parent includes: a preset in the architecture file (`use preset=MeshRecommended`), a mixin in an
 * entity file (`use mixin=Timestamps`). The contract takes both options as optional, since a contract is per tag and an
 * `analyze` hook does not see the parent; this check reads the parent as `checkFieldOptions` does, requires the parent's
 * option (`MESH_MISSING_OPTION`) and refuses the other parent's (`MESH_UNKNOWN_OPTION`, at the option).
 */
const OPTION_OF: Readonly<Record<string, { option: string; example: string; other: string; refusal: string }>> = {
  architecture: {
    option: "preset",
    example: "`use preset=MeshRecommended`",
    other: "mixin",
    refusal: "`mixin` is not an option of `use` in the architecture file: an entity includes a mixin, and the architecture file includes a preset with `use preset=Name`",
  },
  entity: {
    option: "mixin",
    example: "`use mixin=Timestamps`",
    other: "preset",
    refusal: "`preset` is not an option of `use` in an entity file: an entity includes a mixin with `use mixin=Name`",
  },
};

export function checkUseOptions(unit: LoweredUnit): void {
  for (const call of unit.calls) {
    if (call.tag !== "use") continue;
    const own = OPTION_OF[call.ancestors.at(-2)?.tag ?? ""];
    if (!own) continue; // MX already refused the parent
    const other = call.attrs.find((a) => !("spread" in a) && a.name === own.other);
    if (other && !("spread" in other))
      unit.fail(own.refusal, {
        code: "MESH_UNKNOWN_OPTION",
        ...(other.nameSpan ? { at: other.nameSpan } : {}),
      });
    if (!call.attrs.some((a) => !("spread" in a) && a.name === own.option))
      unit.fail(`\`use\` names what it includes: ${own.example}`, {
        code: "MESH_MISSING_OPTION",
        ...(call.nameSpan ? { at: call.nameSpan } : {}),
      });
  }
}
