import { FrameworkError, type ActionContext, type ContextArgument, type Surface } from "@meshfw/runtime";
import type { Method, MethodTable } from "./server.ts";

/** Options of `surfaceMethods`. */
export interface SurfaceMethodsOptions {
  /** The method name of one action line, from its expose line's name and the action's; `<exposed>.<action>` unless set. */
  name?: (exposed: string, action: string) => string;
}

const byDot = (exposed: string, action: string): string => `${exposed}.${action}`;

/**
 * A method table from a surface's manifest: one method per action line, named `<exposed name>.<action>` unless `name`
 * says otherwise. Each method passes `params` to the action as its input and the call's context as its context, so the
 * action's own cast refuses a bad input (`InvalidInputError`, which the server's `error` option maps) and its policies
 * decide. No `params` schema is set: the action validates. Throws `FrameworkError` when two actions get one method
 * name, or a name starts with `rpc.`, which JSON-RPC 2.0 reserves.
 */
export function surfaceMethods<C extends ActionContext = ActionContext>(
  surface: Surface,
  options: SurfaceMethodsOptions = {},
): MethodTable<C> {
  if (typeof surface !== "object" || surface === null || typeof surface.expose !== "object" || surface.expose === null) {
    throw new FrameworkError("surfaceMethods needs a surface's manifest, the `surface` a `#mesh/surfaces/<name>` module exports");
  }
  const name = options.name ?? byDot;
  const methods = new Map<string, { line: string; method: Method<C> }>();
  for (const [exposed, exposure] of Object.entries(surface.expose)) {
    for (const [action, entry] of Object.entries(exposure.actions)) {
      const line = byDot(exposed, action);
      const method: unknown = name(exposed, action);
      if (typeof method !== "string" || method === "") {
        const shown = typeof method === "string" ? JSON.stringify(method) : String(method);
        throw new FrameworkError(`surfaceMethods: \`name\` must return a non-empty string; it returned ${shown} for ${line}`);
      }
      if (method.startsWith("rpc.")) {
        throw new FrameworkError(
          `surfaceMethods: method name ${method} starts with \`rpc.\`, which JSON-RPC 2.0 reserves for the protocol; rename the expose line or pass \`name\``,
        );
      }
      const taken = methods.get(method);
      if (taken) {
        throw new FrameworkError(
          `surfaceMethods: \`name\` gives ${taken.line} and ${line} the one method name \`${method}\`; method names must differ`,
        );
      }
      const run = entry.run;
      methods.set(method, { line, method: { run: (params, context) => run(params, ...([context] as ContextArgument)) } });
    }
  }
  // Object.fromEntries defines own properties, so a method named `__proto__` is a method, never the prototype.
  return Object.fromEntries([...methods].map(([method, { method: entry }]) => [method, entry]));
}
