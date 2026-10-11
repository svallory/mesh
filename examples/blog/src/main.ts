import { connect, disconnect } from "#mesh";
import { createPost, createUser, destroyPost, publishPost, readPost } from "#mesh/domain/blog";
import { alice } from "./context";

await connect();

const author = await createUser({ name: "Alice" }, { actor: alice });
const post = await createPost({ title: "Hello, Mesh", author: author.id }, { actor: alice });
console.log(post.state, (await readPost({}, { actor: alice })).length);

// Only the post's author may publish or destroy it (the `:owner` policy of post.mesh.mx).
const published = await publishPost({ id: post.id }, { actor: { id: author.id } });
console.log(published.state);

await destroyPost({ id: post.id }, { actor: { id: author.id } });
try {
  await publishPost({ id: post.id }, { actor: { id: author.id } });
} catch (error) {
  // Every Mesh error carries a `code`, so the program needs no import beyond the generated ones to tell them apart.
  if (!(error instanceof Error && "code" in error && error.code === "not_found")) throw error;
  console.log(error.code);
}

await disconnect();
