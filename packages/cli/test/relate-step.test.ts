// The `relate` step end to end (ADR-0100, "The relate step"). The fixture (`fixtures/relate-step/domain/music/`) relates an
// album's tracks from a create and three updates, each naming other actions of Track, and a playlist's entries (an
// `integer` key) from a create. Track has a read policy that hides some rows, a check and two write policies, one of
// which reads the caller's context. The project is built by the real `mesh` command on the SQLite adapter,
// type-checked by tsc under the strictest flags, and run on SQLite in memory.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { mesh, project, removeProjects, repo } from "./project.ts";

const fixture = join(import.meta.dir, "fixtures/relate-step");

let root: string;
beforeAll(async () => {
  root = await project({ prefix: "relate-step-", name: "relate-step", domain: join(fixture, "domain"), files: { "context.ts": await readFile(join(fixture, "context.ts"), "utf8") } });
  expect(mesh(root, "build")).toEqual({ code: 0, stdout: "", stderr: "0 errors, 0 warnings\n" });
}, 30_000);
afterAll(removeProjects);

interface Track { id: string; name: string; hidden: boolean; albumId: string }
interface Album { id: string; title: string }
type Call<R> = (input: Record<string, unknown>, context?: object) => Promise<R>;
interface Issue { label: string | null; code: string | null; path: unknown[]; message: string; source: { file: string; line: number; column: number } | null; details: unknown }

/** The error a call rejects with; fails the test when it resolves. */
async function failureOf(call: Promise<unknown>): Promise<{ name: string; issues?: Issue[]; cause?: unknown }> {
  const error = await call.then(() => undefined, (e: unknown) => e);
  expect(error).toBeDefined();
  return error as { name: string; issues?: Issue[] };
}

describe("the relate step", () => {
  test("tsc type-checks the generated tree under the strictest flags", async () => {
    const files = (await readdir(join(root, ".mesh"), { recursive: true })).filter((name) => name.endsWith(".ts")).map((name) => join(".mesh", name));
    const child = Bun.spawnSync([
      join(repo, "node_modules/.bin/tsc"), "--ignoreConfig", "--noEmit", "--strict", "--noUncheckedIndexedAccess",
      "--module", "esnext", "--moduleResolution", "bundler", "--target", "es2022", "--skipLibCheck", "--noUnusedLocals", "--noUnusedParameters",
      "--exactOptionalPropertyTypes", "--verbatimModuleSyntax", "--isolatedModules", "--allowImportingTsExtensions", "--types", "bun",
      "mesh.config.ts", "context.ts", ...files,
    ], { cwd: root });
    expect(child.stdout.toString() + child.stderr.toString()).toBe("");
    expect(child.exitCode).toBe(0);
  }, 30_000);

  test("on SQLite the children follow the caller's list", async () => {
    const app = await import(join(root, ".mesh/index.ts"));
    const domain = await import(join(root, ".mesh/domain/index.ts"));
    const { sqlite, createSchema } = await import(Bun.resolveSync("@meshfw/data-sqlite", root));
    const layer = sqlite({ file: ":memory:" });
    await createSchema(layer, app.tables);
    // Every child write, in order, through the afterWrite seam.
    const writes: string[] = [];
    const binding = app.bind(layer, { seams: { afterWrite: (_db: unknown, change: { entity: string; action: string; before: Track | null; after: Track | null }) => {
      if (change.entity === "music.Track") writes.push(`${change.action} ${(change.after ?? change.before)!.name}`);
    } } });
    const { Album, Track, Playlist, Entry } = domain.music as {
      Album: { make: Call<Album>; edit: Call<Album>; keep: Call<Album>; pick: Call<Album> };
      Track: { add: Call<Track>; addHidden: Call<Track>; read: (input: object) => Promise<Track[]> };
      Playlist: { make: Call<{ id: number; name: string }> };
      Entry: { read: (input: object) => Promise<{ title: string; playlistId: number }[]> };
    };
    const names = async (album: string) => (await binding.run(() => Mesh.privileged(Track).read({ filter: { albumId: { eq: album } }, sort: ["name"] }))).map((track: Track) => track.name);
    const { Mesh } = await import(Bun.resolveSync("@meshfw/runtime", root));
    const relateIssue = (code: string, index: number, id: string, message: string): Issue =>
      ({ label: "relate", code, path: ["tracks", index, "id"], message, source: { file: "domain/music/album.mesh.mx", line: 22, column: 9 }, details: { id } });
    try {
      // A create relates its children after its row is written: each is created through Track.add with the album's key.
      const album = await binding.run(() => Album.make({ title: "A", tracks: [{ name: "one" }, { name: "two" }] }));
      expect(await names(album.id)).toEqual(["one", "two"]);
      expect(writes.splice(0)).toEqual(["add one", "add two"]);
      const [one, two] = (await binding.run(() => Track.read({ filter: { albumId: { eq: album.id } }, sort: ["name"] }))) as Track[];

      // The field left out changes no child.
      await binding.run(() => Album.edit({ id: album.id, title: "A2" }));
      expect(writes.splice(0)).toEqual([]);

      // destroy, then update, then create; the result is the row read again after the relate.
      const edited = await binding.run(() => Album.edit({ id: album.id, title: "A3", tracks: [{ name: "three" }, { id: one!.id, name: "uno" }] }));
      expect(edited).toEqual({ id: album.id, title: "A3" });
      expect(writes.splice(0)).toEqual(["remove two", "rename uno", "add three"]);
      expect(await names(album.id)).toEqual(["three", "uno"]);
      void two;

      // An upper-case uuid names its child; a keyed item without other fields keeps it unchanged.
      const current = (await binding.run(() => Track.read({ filter: { albumId: { eq: album.id } }, sort: ["name"] }))) as Track[];
      await binding.run(() => Album.edit({ id: album.id, tracks: current.map((track) => ({ id: track.id.toUpperCase() })) }));
      expect(writes.splice(0)).toEqual(["rename three", "rename uno"]);

      // Unknown and repeated keys are reported together, before any child call.
      const stranger = (await binding.run(() => Album.make({ title: "B", tracks: [{ name: "other" }] })));
      writes.length = 0;
      const [foreign] = (await binding.run(() => Track.read({ filter: { albumId: { eq: stranger.id } } }))) as Track[];
      const refused = await failureOf(binding.run(() => Album.edit({ id: album.id, title: "never", tracks: [{ id: foreign!.id }, { id: current[0]!.id }, { id: current[0]!.id }] })));
      expect(refused.name).toBe("InvalidInputError");
      expect(refused.issues).toEqual([
        relateIssue("not_related", 0, foreign!.id, `id ${foreign!.id} is not one of the tracks of this record (music.Album#tracks)`),
        relateIssue("duplicate", 2, current[0]!.id, `id ${current[0]!.id} is given twice in tracks`),
      ]);
      expect(writes).toEqual([]);
      // The parent's write rolled back with it.
      expect((await binding.run(() => Mesh.privileged(Album).read({ filter: { id: { eq: album.id } } })))[0].title).toBe("A3");

      // A malformed item fails the parent's cast at the bad field's path, keyed and new alike, and an item's line rule
      // keeps its code and its line in Track's file.
      const cast = await failureOf(binding.run(() => Album.edit({ id: album.id, tracks: [{ id: current[0]!.id, name: 3 }, { name: "" }, { name: "x", extra: 1 }] })));
      expect(cast.issues?.map(({ path, code, source }) => [path, code, source?.line ?? null])).toEqual([
        [["tracks", 0, "name"], null, null],
        [["tracks", 1, "name"], "too_short", 5],
        [["tracks", 2], null, null],
      ]);
      // Without update= a keyed item is the key alone: another field is refused, not dropped.
      expect((await failureOf(binding.run(() => Album.pick({ id: album.id, tracks: [{ id: current[0]!.id, name: "x" }] })))).issues?.map((issue) => issue.path)).toEqual([["tracks", 0]]);
      // Without create= no item may be new.
      expect((await failureOf(binding.run(() => Album.pick({ id: album.id, tracks: [{ name: "x" }] })))).issues?.map((issue) => [issue.path, issue.message])).toEqual([[["tracks", 0], "an item needs id: this list takes no new item"]]);
      // Without destroy= an empty list keeps every child; with it, it destroys them.
      writes.length = 0;
      await binding.run(() => Album.keep({ id: album.id, tracks: [] }));
      expect(writes.splice(0)).toEqual([]);
      await binding.run(() => Album.pick({ id: album.id, tracks: [{ id: current[1]!.id }] }));
      expect(writes.splice(0)).toEqual([`remove ${current[0]!.name}`]);

      // A child the caller cannot read is neither listed nor destroyed, and its key is not_related.
      const hidden = await binding.run(() => Track.addHidden({ name: "secret", album: album.id }));
      writes.length = 0;
      await binding.run(() => Album.pick({ id: album.id, tracks: [] }));
      expect(writes.splice(0)).toEqual([`remove ${current[1]!.name}`]);
      expect(await names(album.id)).toEqual(["secret"]);
      expect((await failureOf(binding.run(() => Album.edit({ id: album.id, tracks: [{ id: hidden.id }] })))).issues?.map((issue) => issue.code)).toEqual(["not_related"]);

      // A child's check failure and a child's policy denial reach the caller unwrapped, and nothing is stored.
      const before = (await binding.run(() => Mesh.privileged(Album).read({}))).length;
      const bad = await failureOf(binding.run(() => Album.make({ title: "C", tracks: [{ name: "fine" }, { name: "bad" }] })));
      expect([bad.name, bad.issues?.map((issue) => issue.code)]).toEqual(["InvalidInputError", ["bad-name"]]);
      expect((await failureOf(binding.run(() => Album.make({ title: "C", tracks: [{ name: "forbidden" }] })))).name).toBe("ForbiddenError");
      expect((await binding.run(() => Mesh.privileged(Album).read({}))).length).toBe(before);
      // The child call gets the caller's context: a policy that reads it refuses the child, not the album.
      expect((await failureOf(binding.run(() => Album.make({ title: "C", tracks: [{ name: "fine" }] }, { deny: true })))).name).toBe("ForbiddenError");
      expect(await binding.run(() => Album.make({ title: "C" }, { deny: true }))).toMatchObject({ title: "C" });

      // The parent's checks run before the write, on the children as they were: the relate may push the count past them.
      const full = await binding.run(() => Album.make({ title: "D", tracks: [{ name: "a" }, { name: "b" }] }));
      await binding.run(() => Album.edit({ id: full.id, tracks: [{ name: "c" }, { name: "d" }, { name: "e" }] }));
      expect(await names(full.id)).toEqual(["c", "d", "e"]);
      expect((await failureOf(binding.run(() => Album.edit({ id: full.id, title: "E" })))).issues?.map((issue) => issue.code)).toEqual(["few-tracks"]);

      // An integer-keyed parent: each child gets the key the write gave.
      const playlist = await binding.run(() => Playlist.make({ name: "P", entries: [{ title: "x" }, { title: "y" }] }));
      expect(typeof playlist.id).toBe("number");
      expect(((await binding.run(() => Entry.read({ sort: ["title"] }))) as { title: string; playlistId: number }[]).map((entry) => [entry.title, entry.playlistId])).toEqual([["x", playlist.id], ["y", playlist.id]]);
    } finally {
      await layer.close();
    }
  }, 30_000);
});
