import "@meshfw/runtime";

declare module "@meshfw/runtime" {
  interface ActionContext {
    /** A child policy reads it, so a test can tell the child call got the caller's context. */
    deny?: boolean;
  }
}
