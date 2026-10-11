import "@meshfw/runtime";

declare module "@meshfw/runtime" {
  interface ActionContext {
    actor: { id: string };
    /**
     * Set only by `review.accept` on its nested `task.complete`, as Hyper's engine passes the completion through
     * the changeset context (`tasks/review/changes/review.ex:25-31`): the Completion then records rule
     * `review-accepted` and names the accepted submission. Nothing stops another caller from setting it, so Task
     * `complete` reads the submission through `tx` and throws a `FrameworkError` unless it is an accepted submission
     * of that Task that no completion names yet (`acceptedSubmissionOf` in `src/domain/work/work.helpers.ts`).
     */
    completion?: { readonly rule: "review-accepted"; readonly submissionId: string };
  }
}
