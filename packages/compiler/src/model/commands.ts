import type { Action, Diagnostic, Entity, Field, ModelDocument } from "@meshfw/model";
import { error } from "./diagnostics.ts";
import { inputOptional } from "./input-optional.ts";

/** An input as a caller supplies it: its value type, and whether the caller must give it a value. */
interface ActionInput {
  name: string;
  shape: Pick<Field, "type" | "nullable" | "values">;
  required: boolean;
  /** What the message calls it when it is required and missing. */
  what: string;
}

/**
 * The inputs an action takes: the key that selects the row of an update or a destroy, then each input line. A field is
 * optional when its attribute or argument is nullable or has a default, and every member input of an update or a destroy
 * is optional (a caller sends the ones it changes); this is the rule the generated input type applies
 * (`inputOptional`, shared with `entityInputs` in `typescript/views/inputs.ts`). An input that names no attribute or `belongs-to` is another check's
 * error and is left out here.
 */
function inputsOf(entity: Entity, action: Action): ActionInput[] {
  const inputs: ActionInput[] = [];
  const key = entity.attributes.find((attribute) => attribute.primaryKey);
  if (key && (action.kind === "update" || action.kind === "destroy"))
    inputs.push({ name: key.name, shape: key, required: true, what: `\`${key.name}\`, the key that selects the row of ${action.kind === "update" ? "an update" : "a destroy"}` });
  for (const input of action.input) {
    const shape = input.kind === "argument"
      ? input
      : entity.attributes.find((attribute) => attribute.name === input.ref.name)
        ?? entity.relationships.find((relation) => relation.name === input.ref.name && relation.kind === "belongs-to");
    if (!shape) continue;
    const name = input.kind === "argument" ? input.name : input.ref.name;
    const optional = inputOptional(action.kind, input.kind, shape);
    // Relationships take the referenced record's key, never the record. An unresolved key has its own diagnostic.
    if (!("type" in shape) && !shape.keyType) continue;
    const value = "type" in shape ? shape : { type: shape.keyType!, nullable: shape.nullable };
    inputs.push({ name, shape: value, required: !optional, what: `\`${name}\`` });
  }
  return inputs;
}

/** Command values must fit the input: exact scalar kind, an enum subset, and no extra null. Value constraints are not types. */
function accepts(input: ActionInput["shape"], field: Field): boolean {
  if (input.type !== field.type || (field.nullable && !input.nullable)) return false;
  if (field.type !== "enum") return true;
  const values = new Set(input.values?.map((atom) => atom.value));
  return (field.values ?? []).every((atom) => values.has(atom.value));
}

/** The model's type as the author writes it, for a mismatch message. */
function describeType(field: ActionInput["shape"]): string {
  return `${field.type}${field.type === "enum" ? ` values=[${(field.values ?? []).map((atom) => `:${atom.value}`).join(", ")}]` : ""}${field.nullable ? " nullable" : ""}`;
}

/**
 * The checks on commands and the actions that answer them (`notes/spec/events-and-commands.md`, "Answering a command"),
 * run once the model holds every entity and command:
 *
 * - `MESH_COMMAND_ANSWERED_TWICE`: a command answered by two actions anywhere in the project, reported at each `on=` after
 *   the first (an action answers at most one command, which the contract makes structural);
 * - `MESH_COMMAND_UNANSWERED` (a warning): a command no action answers, reported at the command, unless a file of the
 *   project could not be read (`complete` false): the action that answers it may be in that file;
 * - `MESH_COMMAND_INPUT`: a field that is no input, a required input absent or optional in the command, or a field whose
 *   values do not fit the input's type, reported at `on=`. The row-selecting key counts as an input.
 */
export function checkCommands(document: ModelDocument, diagnostics: Diagnostic[], complete = true): void {
  const commands = new Map((document.commands ?? []).map((command) => [command.fqn, command] as const));
  const answers = new Map<string, { entity: Entity; action: Action }>();
  for (const entity of document.entities) {
    for (const action of entity.actions) {
      const ref = action.command;
      if (!ref) continue;
      const command = commands.get(ref.fqn);
      if (!command) continue; // `on=` that resolves to no command is `MESH_UNKNOWN_COMMAND`, reported where it is written
      const first = answers.get(ref.fqn);
      if (first) {
        diagnostics.push(error("MESH_COMMAND_ANSWERED_TWICE",
          `Command ${ref.fqn} is answered by two actions: ${first.entity.fqn}#${first.action.name} (${first.action.command!.position.file}:${first.action.command!.position.line}) and ${entity.fqn}#${action.name}`,
          ref.position, "a command is answered by one action: give the second action a command of its own"));
        continue;
      }
      answers.set(ref.fqn, { entity, action });
      const inputs = inputsOf(entity, action);
      const named = new Map(inputs.map((input) => [input.name, input]));
      for (const field of command.fields) {
        const input = named.get(field.name);
        if (!input) {
          diagnostics.push(error("MESH_COMMAND_INPUT",
            `Command ${ref.fqn} has the field \`${field.name}\`, which is no input of ${entity.fqn}#${action.name}: every field of the command is an input of the action it answers`,
            ref.position, `add \`&${field.name}\` or an argument \`${field.name}\` to the input of the action, or remove the field`));
        } else if (input.required && field.nullable) {
          diagnostics.push(error("MESH_COMMAND_INPUT",
            `${entity.fqn}#${action.name} requires the input ${input.what}, but the field of ${ref.fqn} is optional: a nullable command field may be left out`,
            ref.position, `make the command field \`${field.name}\` required, or make the input optional`));
        } else if (!accepts(input.shape, field)) {
          diagnostics.push(error("MESH_COMMAND_INPUT",
            `Command ${ref.fqn} has the field \`${field.name}\` of type \`${describeType(field)}\`, which does not fit the input of ${entity.fqn}#${action.name} of type \`${describeType(input.shape)}\``,
            ref.position, `give the command field \`${field.name}\` the input's scalar kind, a subset of its enum values, and no null unless the input is nullable`));
        }
      }
      const fields = new Set(command.fields.map((field) => field.name));
      for (const input of inputs)
        if (input.required && !fields.has(input.name))
          diagnostics.push(error("MESH_COMMAND_INPUT",
            `${entity.fqn}#${action.name} requires the input ${input.what}, which is no field of ${ref.fqn}: every required input of the action is a field of the command it answers`,
            ref.position, `add the field \`${input.name}\` to the command, or make the input optional`));
    }
  }
  for (const command of complete ? document.commands ?? [] : [])
    if (!answers.has(command.fqn))
      diagnostics.push({ ...error("MESH_COMMAND_UNANSWERED",
        `Command ${command.fqn} is answered by no action: nothing runs when it is dispatched`,
        command.position, `answer it with an action's \`on=\`, as in \`update on=${command.fqn.split(".").pop()}\``), severity: "warning" });
}
