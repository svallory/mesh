import type { ActionContext, ContextArgument } from "@meshfw/runtime";

declare module "@meshfw/runtime" {
  interface ActionContext {
    actor: { id: string };
  }
}

const alice = { id: "alice" };
const action: (input: unknown, context: ActionContext) => void = () => {};
action({}, { actor: alice });
// @ts-expect-error the project's required actor must be supplied
action({}, {});
// @ts-expect-error actor.id has the type declared by the project
action({}, { actor: { id: 42 } });

// A generated action spreads ContextArgument: once a key is required, so is the context.
declare function generated(input: { title: string }, ...[context]: ContextArgument): Promise<void>;
void generated({ title: "a" }, { actor: alice });
// @ts-expect-error a call without the context is a type error when ActionContext has a required key
void generated({ title: "a" });
// @ts-expect-error the context is checked against the merged interface
void generated({ title: "a" }, {});
