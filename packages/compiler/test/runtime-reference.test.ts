import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const repo = resolve(import.meta.dir, "../../..");
const tsc = join(repo, "node_modules/.bin/tsc");
function compile(args: string[], cwd: string) {
  const result = Bun.spawnSync([tsc, "--ignoreConfig", "--strict", "--target", "es2022", "--module", "esnext", "--moduleResolution", "bundler", "--allowImportingTsExtensions", "--skipLibCheck", ...args], { cwd });
  return { code: result.exitCode, output: result.stdout.toString() + result.stderr.toString() };
}

test("every documented runtime instance/type satisfies the emitted real declarations", async () => {
  const root = await mkdtemp(join(tmpdir(), "mesh-runtime-reference-"));
  try {
    const reference = await readFile(join(repo, "apps/docs/samples/mesh-api.d.ts"), "utf8");
    const start = reference.indexOf('declare module "@meshfw/runtime" {');
    const end = reference.indexOf('declare module "@meshfw/data-sqlite" {', start);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    // A distinct module name prevents the sample's ambient declarations from
    // shadowing the real runtime. Compare actual emitted .d.ts, not a local copy.
    const section = reference.slice(start, end).replace('"@meshfw/runtime"', '"mesh-runtime-reference"');
    await writeFile(join(root, "reference.d.ts"), section);
    const emitted = compile(["--declaration", "--emitDeclarationOnly", "--outDir", join(root, "actual"), join(repo, "packages/runtime/src/index.ts")], root);
    expect(emitted).toEqual({ code: 0, output: "" });
    const names = [...section.matchAll(/export (?:interface|class) (\w+)/g)].map((match) => match[1]!);
    expect(names).toEqual([
      "EventsConfig", "EventsModule", "EventBusCapabilities", "BusManifest", "EventBus", "BusOptions", "EventBusInstance", "RegisteredHandler", "OutboxRow",
      "OutboxPage", "SubscriptionFilter", "LiveSubscription", "BusCore", "HandlerTools", "Handler", "Delivery", "SubscribeQuery", "Subscription",
      "EventMetadata", "EventRecord", "MetadataFunction", "ReadEventsQuery", "ReadEventsPage", "ActionContext", "Issue", "PolicyCheck", "MeshError",
      "InvalidInputError", "NotFoundError", "ForbiddenError", "FrameworkError", "DatabaseBusyError", "EventsDeletedError", "CursorAheadError",
      "EventUndeclaredError", "EventsConfigError", "HandlerOptionError", "ClaimHolder", "DelivererTakenError", "DelivererLostError",
      "SubscriptionOverflowError", "StoppedHandler", "HandlerStoppedError",
    ]);
    // Check every documented member. Real errors additionally expose entity/key;
    // that extra API is not promised by the sample's deliberately smaller shape.
    const probe = `import type * as Docs from "mesh-runtime-reference";\nimport type * as Actual from "./actual/index";\n${names.map((name) => `declare const ${name}: Docs.${name};\n${name} satisfies Pick<Actual.${name}, keyof Docs.${name}>;`).join("\n")}
// Data contracts must also reject widening, optional metadata and extra required fields.
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
type Assert<T extends true> = T;
type IssueParity = Assert<Same<Docs.Issue, Actual.Issue>>;
type PolicyParity = Assert<Same<Docs.PolicyCheck, Actual.PolicyCheck>>;
// The events configuration and the metadata function: \`Pick\` of a callable interface checks nothing, so both are compared whole.
type EventsConfigParity = Assert<Same<Docs.EventsConfig, Actual.EventsConfig>>;
type MetadataFunctionParity = Assert<Same<Docs.MetadataFunction, Actual.MetadataFunction>>;
// The event-bus contract an adapter implements, compared whole, readonly modifiers included, and the closed capability lists.
type EventBusParity = Assert<Equal<Docs.EventBus, Actual.EventBus>>;
type BusCoreParity = Assert<Equal<Docs.BusCore, Actual.BusCore>>;
type InstanceParity = Assert<Equal<Docs.EventBusInstance, Actual.EventBusInstance>>;
type LiveSubscriptionParity = Assert<Equal<Docs.LiveSubscription, Actual.LiveSubscription>>;
type BusCapabilityParity = Assert<Equal<Docs.BusCapability, Actual.BusCapability>>;
type CapabilityParity = Assert<Equal<Docs.Capability, Actual.Capability>>;
type HandlerParity = Assert<Same<Docs.Handler, Actual.Handler>>;
type SubscriptionParity = Assert<Equal<Docs.Subscription, Actual.Subscription>>;
type SubscribeQueryParity = Assert<Same<Docs.SubscribeQuery, Actual.SubscribeQuery>>;
type BindingDeliveryParity = Assert<Same<Pick<Docs.Binding, "deliver" | "startDelivery">, Pick<Actual.Binding, "deliver" | "startDelivery">>>;
type MetadataFunctionOfParity = Assert<Same<Docs.MetadataFunction<{ n: number }>, Actual.MetadataFunction<{ n: number }>>>;
// @ts-expect-error a metadata function that may return undefined must fail parity
type LooseMetadata = Assert<Same<Docs.MetadataFunction, (...args: Parameters<Actual.MetadataFunction>) => Actual.EventMetadata | undefined>>;
// Negative tripwires pin both directions of the comparator.
// @ts-expect-error optional Issue metadata must fail parity
type OptionalIssue = Assert<Same<Docs.Issue, Omit<Actual.Issue, "label"> & { label?: string | null }>>;
// @ts-expect-error optional PolicyCheck members must fail parity
type OptionalPolicy = Assert<Same<Docs.PolicyCheck, Omit<Actual.PolicyCheck, "decisive"> & { decisive?: boolean }>>;
// @ts-expect-error extra required runtime members must fail parity
type ExtraIssue = Assert<Same<Docs.Issue, Actual.Issue & { extra: string }>>;
// the answer, the action function type and Mesh's members match the runtime's, readonly modifiers included,
// which mutual assignability ignores. \`Mesh.privileged\` and \`Mesh.isSystem\` are compared by name only: the sample's
// \`EntityValue\` is deliberately smaller, and it types \`isSystem\`'s context as an \`ActionContext\`, which the runtime takes as \`unknown\`.
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
type DecisionParity = Assert<Equal<Docs.Decision, Actual.Decision>>;
type ActionFunctionParity = Assert<Equal<Docs.ActionFunction, Actual.ActionFunction>>;
type ActionFunctionInputParity = Assert<Equal<Docs.ActionFunction<{ id: string }>, Actual.ActionFunction<{ id: string }>>>;
type MeshKeys = Assert<Same<keyof typeof Docs.Mesh, keyof typeof Actual.Mesh>>;
type CheckPoliciesParity = Assert<Equal<typeof Docs.Mesh.checkPolicies, typeof Actual.Mesh.checkPolicies>>;
type CanParity = Assert<Equal<typeof Docs.Mesh.can, typeof Actual.Mesh.can>>;
// @ts-expect-error a Decision whose member is not readonly must fail parity
type MutableDecision = Assert<Equal<Docs.Decision, Omit<Actual.Decision, "allowed"> & { allowed: boolean }>>;
// @ts-expect-error a checkPolicies that takes any input must fail parity
type LooseCheck = Assert<Equal<typeof Docs.Mesh.checkPolicies, <A extends Actual.ActionFunction>(action: A, input: unknown, context: Actual.ActionContext) => Promise<Actual.Decision>>>;
`;
    await writeFile(join(root, "probe.ts"), probe);
    expect(compile(["--noEmit", "reference.d.ts", "probe.ts"], root)).toEqual({ code: 0, output: "" });
    // Tripwire: the comparator must not silently resolve both sides to Docs.
    await writeFile(join(root, "probe.ts"), probe + '\ndeclare const broken: Omit<Docs.Issue, "message">;\nbroken satisfies Actual.Issue;\n');
    const broken = compile(["--noEmit", "reference.d.ts", "probe.ts"], root);
    expect(broken.code).not.toBe(0);
    expect(broken.output).toContain("message");
  } finally { await rm(root, { recursive: true, force: true }); }
}, 30_000);
