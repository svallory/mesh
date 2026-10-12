import { entity } from "../../src/index.ts";

/** Another project's `work.Task`: same FQN, another value. A binding of `fake.ts` does not bind it. */
export const Task = entity("work.Task", () => Object.freeze({ async open() { return "other"; } }), null, (call) => ({
  open(input: { readonly title: string }): Promise<string> {
    return call("open", input, []);
  },
}));
