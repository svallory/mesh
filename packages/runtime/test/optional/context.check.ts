import type { ContextArgument } from "@meshfw/runtime";

// Only optional keys merged: the context stays optional, and a supplied one is still checked.
declare module "@meshfw/runtime" {
  interface ActionContext {
    locale?: string;
  }
}

declare function generated(input: { title: string }, ...[context]: ContextArgument): Promise<void>;
void generated({ title: "a" });
void generated({ title: "a" }, { locale: "en-GB" });
// @ts-expect-error locale has the declared type
void generated({ title: "a" }, { locale: 42 });
