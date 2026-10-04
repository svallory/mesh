import type { Actor, Scope } from "@mesh/runtime";

declare module "@mesh/runtime" {
  interface Register {
    actor: { id: string };
  }
}

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
type Assert<T extends true> = T;
type RegisteredActor = Assert<Equal<Scope["actor"], { id: string }>>;
type ActorAlias = Assert<Equal<Actor, { id: string }>>;
const scope: Scope = { actor: { id: "alice" } };
// @ts-expect-error registered actor must have a string id
const wrong: Scope = { actor: { id: 42 } };
// @ts-expect-error actor remains required after augmentation
const missing: Scope = {};
