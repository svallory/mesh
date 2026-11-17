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
  // The generated `run` calls the entity value synchronously, and the entity value calls `dispatch` in `entity.ts`
  // synchronously, so the marker is up exactly while that call starts: there a quiet call chain (a handler of a kind an
  // extension contributes, ADR-0094) refuses it before the action runs anything.
  const outer = dispatching.command;
  dispatching.n++;
  dispatching.command = declaration.fqn;
  try {
    return answer.run(command as never, context);
  } catch (error) {
    // The quiet chain's refusal (and any other synchronous throw of the call's start) rejects like every other dispatch
    // failure: `dispatch` promises a rejection, so `dispatch(cmd, ctx).catch(report)` must reach its `.catch`.
    return Promise.reject(error);
  } finally {
    dispatching.n--;
    dispatching.command = outer;
  }
}

/** Raised by `dispatchCommand` around the synchronous start of the answering action, with the command's FQN. */
export const dispatching: { n: number; command: string | undefined } = { n: 0, command: undefined };

/**
 * What an action's call resolves with, as the generated `DispatchResult` reads it from the entity value's method
 * (`$ActionResult<typeof Invoice.payInvoice>`): the generated file spells no global type of its own: a new
 * alias in `GLOBAL_ALIASES` would change every project's `$globals.ts` and the corpus golden.
 */
export type ActionResult<Call> = Call extends (...args: never[]) => Promise<infer Result> ? Result : never;
