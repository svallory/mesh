import type { ActionContext } from "@meshfw/runtime";

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
