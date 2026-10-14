// Compile-time checks of how a method table is typed. This file is never run: `bun run typecheck` (part of
// `bun run verify`) compiles it, and an `@ts-expect-error` line fails the check when its error goes away.
import type { StandardSchemaV1 } from "@meshfw/runtime";
import { z } from "zod";
import { serve, type Call, type Method, type MethodTable } from "../src/index.ts";

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
type Assert<T extends true> = T;

interface Context {
  actor: string;
}
const context = (): Context => ({ actor: "ana" });
const socket = "/run/example.sock";

/** A helper that builds entries apart from the table, as an application's own `command(...)` would. */
function command<P>(params: StandardSchemaV1<unknown, P>, run: Method<Context, P>["run"]): Method<Context, P> {
  return { params, run };
}

/** A helper whose `run` takes the schema's output type itself. */
function typedCommand<P>(params: StandardSchemaV1<unknown, P>, run: (params: P, context: Context, call: Call) => unknown): Method<Context, P> {
  return { params, run: (value, context, call) => run(value as P, context, call) };
}

export function inlineEntries() {
  return serve({
    socket,
    context,
    methods: {
      // With a schema, `run` receives the schema's output.
      typed: {
        params: z.object({ n: z.number() }),
        run: (params, context) => {
          type Received = Assert<Equal<typeof params, { n: number }>>;
          type ContextType = Assert<Equal<typeof context, Context>>;
          return params.n + 1;
        },
      },
      // A transform's output, not its input.
      transformed: {
        params: z.object({ n: z.string() }).transform(({ n }) => ({ length: n.length })),
        run: (params) => {
          type Received = Assert<Equal<typeof params, { length: number }>>;
          return params.length;
        },
      },
      // Without a schema, the object as sent.
      plain: {
        run: (params, _context, call) => {
          type Received = Assert<Equal<typeof params, Readonly<Record<string, unknown>>>>;
          type CallType = Assert<Equal<typeof call, Call>>;
          return params;
        },
      },
      // A `run` written for another shape than the schema outputs is refused.
      // @ts-expect-error `{ n: string }` is not what `z.object({ n: z.number() })` outputs
      mismatched: { params: z.object({ n: z.number() }), run: (params: { n: string }) => params.n },
      // A `run` that expects another context than the factory builds is refused.
      // @ts-expect-error the context factory builds `Context`, which has no `tenant`
      otherContext: { run: (_params, context: { tenant: string }) => context.tenant },
      helped: command(z.object({ id: z.string() }), (params) => {
        type Received = Assert<Equal<typeof params, { id: string }>>;
        return params.id;
      }),
      typedHelper: typedCommand(z.object({ id: z.uuid() }), (params) => params.id),
    },
  });
}

export function prebuiltTable() {
  // A table built apart from `serve` takes entries of any schema, helper-built or inline.
  const methods: MethodTable<Context> = {
    helped: command(z.object({ id: z.string() }), (params) => params.id),
    inline: { run: (params, context) => [params, context.actor] },
    typed: { params: z.object({ n: z.number() }), run: (params) => params },
  };
  return serve({ socket, context, methods });
}

export function noSchemaTypes() {
  type DefaultRun = Parameters<Method<Context>["run"]>;
  type DefaultParams = Assert<Equal<DefaultRun[0], Readonly<Record<string, unknown>>>>;
  type TableEntry = Assert<Equal<Parameters<MethodTable<Context>[string]["run"]>[0], Readonly<Record<string, unknown>>>>;
  type SchemaRun = Assert<Equal<Parameters<Method<Context, { id: string }>["run"]>[0], { id: string }>>;
}
