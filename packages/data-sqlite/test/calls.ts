import { isEntityValue, type Binding } from "@meshfw/runtime";

/** One entity call: the input, then the context. */
type Call = (input?: unknown, ...context: unknown[]) => Promise<unknown>;

/**
 * What `callsOf` returns. `any`: the generated project is imported at run time, so neither the calls nor the binding's
 * `run` and `transaction` have types the tests can name, as `bind`'s result had none before.
 */
export type Calls = { readonly [name: string]: any };

/**
 * A generated project's entity calls under the names the `actions` handle gives them, the action followed by the
 * entity's export name (`openTask` for `Task.open`), each made inside `run()` of `binding`:
 * `callsOf(binding, domain).openTask(input, context)` is `binding.run(() => domain.Task.open(input, context))`, with
 * `domain` the project's root barrel (`.mesh/domain/index.ts`). These tests pin what an action does, not how it is
 * called (packages/compiler/test/index.test.ts, the blog and Hyper pin the call itself), so each call keeps one short
 * name. `run` and `transaction` are the binding's own.
 */
export function callsOf(binding: Binding, domain: object): Calls {
  const calls: Record<string, Call> = {};
  const walk = (namespace: object) => {
    for (const [name, value] of Object.entries(namespace)) {
      if (isEntityValue(value))
        for (const [action, method] of Object.entries(value as unknown as Record<string, Call>))
          calls[`${action}${name}`] = (...args) => binding.run(() => method(...args));
      else if (Object.prototype.toString.call(value) === "[object Module]") walk(value as object);
    }
  };
  walk(domain);
  return Object.freeze({ ...calls, run: binding.run, transaction: binding.transaction });
}
