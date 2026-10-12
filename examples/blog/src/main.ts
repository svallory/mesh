import { connect, disconnect } from "#mesh";
import { Post, User } from "#mesh/domain/blog";
import { alice } from "./context";

await connect();

const author = await User.create({ name: "Alice" }, { actor: alice });
const post = await Post.create({ title: "Hello, Mesh", author: author.id }, { actor: alice });
console.log(post.state, (await Post.read({}, { actor: alice })).length);

// Only the post's author may publish, archive or destroy it (the `:owner` policy of post.mesh.mx).
const published = await Post.publish({ id: post.id }, { actor: { id: author.id } });
console.log(published.state);

await Post.destroy({ id: post.id }, { actor: { id: author.id } });
try {
  await Post.publish({ id: post.id }, { actor: { id: author.id } });
} catch (error) {
  // Every Mesh error carries a `code`, so the program needs no import beyond the generated ones to tell them apart.
  if (!(error instanceof Error && "code" in error && error.code === "not_found")) throw error;
  console.log(error.code);
}

await disconnect();
