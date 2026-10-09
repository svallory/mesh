// Acceptance test 5: `src/context.ts` declares a required `actor`, so the context is required.
import { createPost, readPost } from "#mesh";
import { alice } from "../src/context";

void readPost({}, { actor: alice });
// @ts-expect-error a call without the action context is a type error
void readPost({});
// @ts-expect-error the context must carry the declared actor
void createPost({ title: "Hello", author: alice.id }, {});
