import type { LoweredUnit } from "@mxlang/core";

/**
 * `use` includes what its parent includes: a preset in the architecture file (`use preset=MeshRecommended`). The contract
 * takes the option as optional, since `use` is shared with the mixins an entity includes (`use mixin=Timestamps`), a
 * contract is per tag and an `analyze` hook does not see the parent; this check reads the parent as `checkFieldOptions`
 * does and requires the parent's option. The mixins unit adds the entity's entry (`entity: "mixin"`) and refuses the
 * other parent's option here.
 */
const OPTION_OF: Readonly<Record<string, { option: string; example: string }>> = {
  architecture: { option: "preset", example: "`use preset=MeshRecommended`" },
};

export function checkUseOptions(unit: LoweredUnit): void {
  for (const call of unit.calls) {
    if (call.tag !== "use") continue;
    const own = OPTION_OF[call.ancestors.at(-2)?.tag ?? ""];
    if (!own) continue; // MX already refused the parent
    if (!call.attrs.some((a) => !("spread" in a) && a.name === own.option))
      unit.fail(`\`use\` names what it includes: ${own.example}`, {
        code: "MESH_MISSING_OPTION",
        ...(call.nameSpan ? { at: call.nameSpan } : {}),
      });
  }
}
