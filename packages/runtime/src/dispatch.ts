import { DECLARATION, type Declaration } from "./declarations.ts";
import { FrameworkError } from "./errors.ts";
import type { ActionContext } from "./index.ts";

/**
 * What the generated `dispatch` knows of the action that answers one command: how to run it. The generated entry is typed
 * (`(command: PayInvoice, context) => Invoice.payInvoice({ id: command.id, paidAt: command.paidAt }, context)`), so the
 * project's type check finds a command field the action's input does not take, or takes as another type.
 */
export interface CommandAction {
  readonly run: (command: never, context: ActionContext) => Promise<unknown>;
}

/**
 * `dispatch(command, context)` (`notes/spec/events-and-commands.md`, "`dispatch`"): runs the action whose `on=` names the
 * command's class, with the command's fields as its input and the context it is given. The action is an ordinary call of an
 * entity value, so it joins the transaction running in this async frame (a `process` handler's, a top-level
 * `transaction()`'s) or opens its own, exactly as `Invoice.pay(input, context)` does. `table` maps a command's FQN to its
 * action; the generated `#mesh` holds it. A value that is not an instance of a generated command class is a
 * `FrameworkError`, and so is a command no action answers, which only a build older than the command's declaration (a stale
 * `.mesh/`) can reach, since `dispatch` is typed to the commands an action answers.
 */
export function dispatchCommand(table: Readonly<Record<string, CommandAction>>, command: unknown, context: ActionContext): Promise<unknown> {
  const declaration = (command as { constructor?: { [DECLARATION]?: Declaration } } | null | undefined)?.constructor?.[DECLARATION];
  if (declaration === undefined || declaration.kind !== "command" || !declaration.is(command))
    return Promise.reject(new FrameworkError("dispatch takes an instance of a command class that `mesh build` generated (`dispatch(new PayInvoice({ ... }), context)`), and this is not one"));
  const answer = Object.hasOwn(table, declaration.fqn) ? table[declaration.fqn] : undefined;
  if (answer === undefined)
    return Promise.reject(new FrameworkError(`dispatch: no action answers the command ${declaration.fqn}. The \`.mesh/\` folder is out of date, or no action's \`on=\` names the command: run \`mesh build\``));
  return answer.run(command as never, context);
}

/**
 * What an action's call resolves with, as the generated `DispatchResult` reads it from the entity value's method
 * (`$ActionResult<typeof Invoice.payInvoice>`): the generated file spells no global type of its own: a new
 * alias in `GLOBAL_ALIASES` would change every project's `$globals.ts` and the corpus golden.
 */
export type ActionResult<Call> = Call extends (...args: never[]) => Promise<infer Result> ? Result : never;
