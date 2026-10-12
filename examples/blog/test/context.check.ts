// Acceptance test 5: `src/context.ts` declares a required `actor`, so the context is required.
import { Post } from "#mesh/domain/blog";
import { alice } from "../src/context";

void Post.read({}, { actor: alice });
// @ts-expect-error a call without the action context is a type error
void Post.read({});
// @ts-expect-error the context must carry the declared actor
void Post.create({ title: "Hello", author: alice.id }, {});
