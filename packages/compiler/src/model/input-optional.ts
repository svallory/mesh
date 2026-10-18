import type { ActionType } from "@meshfw/model";

/**
 * Whether a caller may leave an input out: a member input of an update or a destroy (the caller sends the ones it
 * changes), and any input whose attribute or argument is nullable or has a default. The one rule behind the generated
 * input type (`entityInputs` in `typescript/views/inputs.ts`) and the `MESH_COMMAND_INPUT` check (`model/commands.ts`), so
 * that the two cannot drift.
 */
export function inputOptional(action: ActionType, input: "member" | "argument", field: { nullable: boolean; default?: unknown }): boolean {
  return (input === "member" && action !== "create") || field.nullable || field.default !== undefined;
}
