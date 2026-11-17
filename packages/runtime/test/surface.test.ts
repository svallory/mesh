// What a surface's generated manifest calls (surfaces design, section 5 "Run time"; ruling D41, OD11 and OD12):
// `project` keeps only the properties an expose line lets leave, `checkRead` refuses a read input that filters, sorts or
// loads by anything else (R14a), and `defineSurface` freezes the manifest. The type tests at the end are checked by the
// package's `typecheck` script.
import { describe, expect, test } from "bun:test";
import { InvalidInputError, checkRead, defineSurface, project, type NarrowedFilter, type NarrowedSort, type Projected, type Surface, type SurfaceAction, type SurfaceReadInput } from "@meshfw/runtime";

const issuesOf = (run: () => void) => {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(InvalidInputError);
    return (error as InvalidInputError).issues.map(({ path, code, message }) => [path, code, message]);
  }
  throw new Error("checkRead did not throw");
};

describe("project", () => {
  const post = { id: "p1", title: "Hello", body: "secret", authorId: "u1" };
  test("copies the listed properties of a record and leaves the rest", () => {
    expect(project(post, ["id", "title"])).toEqual({ id: "p1", title: "Hello" });
  });
  test("projects each record of an array", () => {
    expect(project([post, { ...post, id: "p2" }], ["id"])).toEqual([{ id: "p1" }, { id: "p2" }]);
  });
  test("undefined and null pass through: a destroy returns nothing", () => {
    expect(project(undefined, ["id"])).toBeUndefined();
    expect(project(null, ["id"])).toBeNull();
  });
  test("a listed property the record does not hold (a computed field not loaded) is left out, not set to undefined", () => {
    const projected = project(post, ["id", "excerpt"]);
    expect(projected).toEqual({ id: "p1" });
    expect(Object.hasOwn(projected, "excerpt")).toBe(false);
  });
  test("a loaded relationship that is not listed stays behind, and an inherited property never leaves", () => {
    const loaded = Object.assign(Object.create({ inherited: 1 }), { ...post, comments: [{ id: "c1", body: "x" }] });
    expect(project(loaded, ["id"])).toEqual({ id: "p1" });
    expect(project(loaded, ["inherited"])).toEqual({});
  });
  test("an empty field list leaves an empty record", () => {
    expect(project(post, [])).toEqual({});
  });
  test("the copy is frozen, the array too, and the record it came from is untouched", () => {
    const one = project(post, ["id"]);
    expect(Object.isFrozen(one)).toBe(true);
    const many = project([post], ["id"]);
    expect(Object.isFrozen(many)).toBe(true);
    expect(Object.isFrozen(many[0])).toBe(true);
    expect(Object.isFrozen(post)).toBe(false);
  });
});

describe("checkRead", () => {
  const fields = ["id", "title", "state", "authorId", "excerpt"] as const;
  const loadable = ["excerpt"] as const;
  test("a read that names only listed fields passes, as does an empty one", () => {
    expect(() => checkRead({}, fields, loadable)).not.toThrow();
    expect(() => checkRead({
      filter: { and: [{ title: { eq: "a" } }, { or: [{ state: { eq: "draft" } }, { authorId: { nil: true } }] }] },
      sort: ["-title", "id"], load: ["excerpt"], limit: 3, offset: 1,
    }, fields, loadable)).not.toThrow();
  });
  test("a filter key not listed is refused, at the top and inside and/or, with its path", () => {
    expect(issuesOf(() => checkRead({ filter: { body: { gte: "m" } } }, fields, loadable))).toEqual([
      [["filter", "body"], "not_exposed", "`body` is not a field of this surface: filter by one of id, title, state, authorId, excerpt"],
    ]);
    expect(issuesOf(() => checkRead({ filter: { and: [{ title: { eq: "a" } }, { or: [{ body: { eq: "x" } }] }] } }, fields, loadable))).toEqual([
      [["filter", "and", 1, "or", 0, "body"], "not_exposed", "`body` is not a field of this surface: filter by one of id, title, state, authorId, excerpt"],
    ]);
  });
  test("a filter key given as undefined is left out, as the data layer leaves it out", () => {
    expect(() => checkRead({ filter: { body: undefined, title: { eq: "a" } } }, fields, loadable)).not.toThrow();
  });
  test("a sort key not listed is refused with and without its leading -", () => {
    expect(issuesOf(() => checkRead({ sort: ["title", "body", "-views"] }, fields, loadable))).toEqual([
      [["sort", 1], "not_exposed", "`body` is not a field of this surface: sort by one of id, title, state, authorId, excerpt"],
      [["sort", 2], "not_exposed", "`views` is not a field of this surface: sort by one of id, title, state, authorId, excerpt"],
    ]);
  });
  test("load takes only the listed computed fields: a relationship and an unlisted computed field are refused", () => {
    expect(issuesOf(() => checkRead({ load: ["excerpt", "comments", "commentCount"] }, fields, loadable))).toEqual([
      [["load", 1], "not_exposed", "`comments` is not a computed field this surface lists: load one of excerpt"],
      [["load", 2], "not_exposed", "`commentCount` is not a computed field this surface lists: load one of excerpt"],
    ]);
    expect(issuesOf(() => checkRead({ load: ["author"] }, fields, []))).toEqual([
      [["load", 0], "not_exposed", "`author` is not a computed field this surface lists, and it lists none to load"],
    ]);
  });
  test("every refused name is reported at once, filter, then sort, then load", () => {
    expect(issuesOf(() => checkRead({ load: ["comments"], sort: ["body"], filter: { body: { eq: "x" }, views: { gt: 1 } } }, fields, loadable)).map(([path]) => path)).toEqual([
      ["filter", "body"], ["filter", "views"], ["sort", 0], ["load", 0],
    ]);
  });
  test("an expose line with no fields= refuses every filter and sort key", () => {
    expect(issuesOf(() => checkRead({ filter: { id: { eq: "a" } }, sort: ["id"] }, [], []))).toEqual([
      [["filter", "id"], "not_exposed", "`id` is not a field of this surface, which lets no field leave"],
      [["sort", 0], "not_exposed", "`id` is not a field of this surface, which lets no field leave"],
    ]);
  });
  test("an own __proto__ key (as JSON.parse makes one) is refused like any unlisted key", () => {
    expect(issuesOf(() => checkRead(JSON.parse('{"filter":{"__proto__":{"eq":1}}}'), fields, loadable)).map(([path]) => path)).toEqual([["filter", "__proto__"]]);
  });
  test("an input that is not an object, and a malformed filter, sort or load, are left to the action's own cast", () => {
    for (const input of [undefined, null, 1, "x", [], { filter: "x" }, { filter: [1] }, { filter: { and: "x" } }, { sort: "body" }, { sort: [1] }, { load: "comments" }, { load: [1] }])
      expect(() => checkRead(input, fields, loadable)).not.toThrow();
  });
});

describe("defineSurface", () => {
  test("freezes the manifest deeply and returns it", () => {
    const run = async () => undefined;
    const manifest = { name: "admin", expose: { tasks: { entity: "work.Task", label: "Tasks", fields: ["id"], actions: { read: { kind: "read", run } } } }, publishes: [] } as const;
    const surface = defineSurface(manifest);
    expect(surface).toBe(manifest);
    expect(Object.isFrozen(surface)).toBe(true);
    expect(Object.isFrozen(surface.expose)).toBe(true);
    expect(Object.isFrozen(surface.expose.tasks)).toBe(true);
    expect(Object.isFrozen(surface.expose.tasks.fields)).toBe(true);
    expect(Object.isFrozen(surface.expose.tasks.actions.read)).toBe(true);
    expect(Object.isFrozen(surface.publishes)).toBe(true);
    // A function is not walked into.
    expect(Object.isFrozen(run)).toBe(false);
  });
});

// ---- types ------------------------------------------------------------------------------------------------------
// A copy of the blog's generated `PostFilter` and `PostSort`, cut to four fields.
type Comparison<T> = { eq?: T; ne?: T; gt?: T; nil?: boolean };
type PostFilter =
  | { and: readonly PostFilter[] }
  | { or: readonly PostFilter[] }
  | { id?: Comparison<string> | undefined; title?: Comparison<string> | undefined; body?: Comparison<string> | undefined; views?: Comparison<number> | undefined };
type PostSort = readonly ("id" | "-id" | "title" | "-title" | "body" | "-body" | "views" | "-views")[];
type ReadPostInput = { filter?: PostFilter | undefined; sort?: PostSort | undefined; limit?: number | undefined };
type Listed = "id" | "title";

const filter: NarrowedFilter<PostFilter, Listed> = { and: [{ title: { eq: "a" } }, { or: [{ id: { eq: "b" } }] }] };
// @ts-expect-error an unlisted field is not a filter key
const filterBody: NarrowedFilter<PostFilter, Listed> = { body: { eq: "x" } };
// @ts-expect-error not inside `and` either
const filterNested: NarrowedFilter<PostFilter, Listed> = { and: [{ body: { eq: "x" } }] };
const sort: NarrowedSort<PostSort, Listed> = ["-title", "id"];
// @ts-expect-error an unlisted field is not a sort key
const sortBody: NarrowedSort<PostSort, Listed> = ["body"];
// @ts-expect-error descending neither
const sortBodyDesc: NarrowedSort<PostSort, Listed> = ["-body"];
const input: SurfaceReadInput<ReadPostInput, Listed> = { filter: { title: { eq: "a" } }, sort: ["id"], limit: 2 };
// @ts-expect-error the read input narrows its filter
const inputBody: SurfaceReadInput<ReadPostInput, Listed> = { filter: { body: { eq: "x" } } };
// A narrowed input is still an input of the read itself, so the manifest can hand it over.
const widened: ReadPostInput = input;

type Post = { id: string; title: string; body: string | null };
const projected: Projected<Post, Listed> = { id: "a", title: "b" };
// @ts-expect-error an unlisted property is not on a projected record
void projected.body;
// @ts-expect-error a projected record is read-only
projected.id = "c";
const projectedMany: Projected<Post[], Listed> = [projected];
const projectedNothing: Projected<void, Listed> = undefined;
const typed: Projected<Post, "id"> = project({ id: "a", title: "b", body: null } as Post, ["id"]);
// A computed field a write may not have loaded stays optional: `project` leaves it out rather than setting `undefined`.
type Maybe = { id: string; excerpt?: string };
const maybeAbsent: Projected<Maybe, "id" | "excerpt"> = { id: "x" };
const maybePresent: Projected<Maybe, "id" | "excerpt"> = { id: "x", excerpt: "y" };
// @ts-expect-error a required property stays required
const maybeNoId: Projected<Maybe, "id" | "excerpt"> = { excerpt: "y" };
// `null` and `undefined` as members of a union pass through, as `project` passes them at run time.
const projectedNull: Projected<Post | null, "id"> = null;
const projectedNullRecord: Projected<Post | null, "id"> = { id: "a" };
const projectedUndefined: Projected<Post | undefined, "id"> = undefined;
// @ts-expect-error the record member of the union is still projected
void (projectedNullRecord as Projected<Post | null, "id"> & object).title;

const action: SurfaceAction<{ id: string }, Projected<Post, Listed>> = { kind: "update", run: async () => projected };
// @ts-expect-error an action's kind is one of the four action types
const badKind: SurfaceAction = { kind: "rename", run: async () => undefined };
const manifest: Surface = { name: "s", expose: { posts: { entity: "blog.Post", label: "Posts", fields: ["id"], actions: { publish: action } } }, publishes: [] };
void [filter, filterBody, filterNested, sort, sortBody, sortBodyDesc, inputBody, widened, projectedMany, projectedNothing, typed, maybeAbsent, maybePresent, maybeNoId, projectedNull, projectedUndefined, badKind, manifest];
