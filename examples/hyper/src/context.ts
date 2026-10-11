import "@meshfw/runtime";

declare module "@meshfw/runtime" {
  interface ActionContext {
    actor: { id: string };
    /**
     * Set only by `review.accept` on its nested `task.complete`, as Hyper's engine passes the completion through
     * the changeset context (`tasks/review/changes/review.ex:25-31`): the Completion then records rule
     * `review-accepted` and names the accepted submission.
     */
    completion?: { readonly rule: "review-accepted"; readonly submissionId: string };
  }
}
