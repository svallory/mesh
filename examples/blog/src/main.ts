import { connect, createPost, createUser, destroyPost, disconnect, publishPost, readPost } from "#mesh";
import { alice } from "./context";

await connect();

const author = await createUser({ name: "Alice" }, { actor: alice });
const post = await createPost({ title: "Hello, Mesh", author: author.id }, { actor: alice });
console.log(post.state, (await readPost({}, { actor: alice })).length);

const published = await publishPost({ id: post.id }, { actor: alice });
console.log(published.state);

await destroyPost({ id: post.id }, { actor: alice });
try {
  await publishPost({ id: post.id }, { actor: alice });
} catch (error) {
  // Every Mesh error carries a `code`, so the program needs nothing but #mesh to tell them apart.
  if (!(error instanceof Error && "code" in error && error.code === "not_found")) throw error;
  console.log(error.code);
}

await disconnect();
