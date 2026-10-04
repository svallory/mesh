import type { ModelDocument, Spanned } from "../src/index.ts";
import { positionOf } from "./source.ts";

export const postFile = "resources/post.mx";

/** The reduced `post.mx` of M1 (concise syntax): every type, the four action kinds. */
export const postSource = `resource="post" table="posts" domain="blog"
  attributes
    uuid-primary-key="id"
    attribute="title" type="string" allow-nil=false public
    attribute="body" type="string" public
    attribute="views" type="integer" default=0
    attribute="rating" type="float"
    attribute="featured" type="boolean" default=false
    attribute="token" type="uuid"
    attribute="publishedAt" type="datetime"
    attribute="state" type="atom" constraints={ one_of: ["draft", "published"] } default="draft"
    create-timestamp="insertedAt"
    update-timestamp="updatedAt"

  actions defaults=["read", "destroy"]
    create="create" accept=["title", "body"]
    update="publish" accept=["state"]
    destroy="archive" accept=[]
    read="published"
`;

const at = (needle: string, nth = 0) => positionOf(postSource, postFile, needle, nth);

/** A name or value as `Spanned` expects: positioned at its own first character. */
const sp = <T>(value: T, needle: string, nth = 0): Spanned<T> => ({
  value,
  position: at(needle, nth),
});

/** Same, for a value inside a longer text, such as `default="draft"`: `"draft"` inside it. */
const within = <T>(value: T, whole: string, inner: string): Spanned<T> => {
  const p = at(whole);
  const d = whole.indexOf(inner);
  return { value, position: { ...p, column: p.column + d, offset: p.offset + d } };
};

/** What a correct builder produces for `postSource`. */
export const postDocument: ModelDocument = {
  resources: [
    {
      name: sp("post", '"post"'),
      table: sp("posts", '"posts"'),
      domain: sp("blog", '"blog"'),
      position: at('resource="post"'),
      attributes: [
        {
          name: sp("id", '"id"'),
          source: "uuid-primary-key",
          type: "uuid",
          allowNil: false,
          public: true,
          writable: false,
          primaryKey: true,
          default: null,
          constraints: null,
          position: at("uuid-primary-key"),
        },
        {
          name: sp("title", '"title"'),
          source: "attribute",
          type: "string",
          allowNil: false,
          public: true,
          writable: true,
          primaryKey: false,
          default: null,
          constraints: null,
          position: at('attribute="title"'),
        },
        {
          name: sp("body", '"body"'),
          source: "attribute",
          type: "string",
          allowNil: true,
          public: true,
          writable: true,
          primaryKey: false,
          default: null,
          constraints: null,
          position: at('attribute="body"'),
        },
        {
          name: sp("views", '"views"'),
          source: "attribute",
          type: "integer",
          allowNil: true,
          public: false,
          writable: true,
          primaryKey: false,
          default: within(0, "default=0", "0"),
          constraints: null,
          position: at('attribute="views"'),
        },
        {
          name: sp("rating", '"rating"'),
          source: "attribute",
          type: "float",
          allowNil: true,
          public: false,
          writable: true,
          primaryKey: false,
          default: null,
          constraints: null,
          position: at('attribute="rating"'),
        },
        {
          name: sp("featured", '"featured"'),
          source: "attribute",
          type: "boolean",
          allowNil: true,
          public: false,
          writable: true,
          primaryKey: false,
          default: within(false, "default=false", "false"),
          constraints: null,
          position: at('attribute="featured"'),
        },
        {
          name: sp("token", '"token"'),
          source: "attribute",
          type: "uuid",
          allowNil: true,
          public: false,
          writable: true,
          primaryKey: false,
          default: null,
          constraints: null,
          position: at('attribute="token"'),
        },
        {
          name: sp("publishedAt", '"publishedAt"'),
          source: "attribute",
          type: "datetime",
          allowNil: true,
          public: false,
          writable: true,
          primaryKey: false,
          default: null,
          constraints: null,
          position: at('attribute="publishedAt"'),
        },
        {
          name: sp("state", '"state"'),
          source: "attribute",
          type: "atom",
          allowNil: true,
          public: false,
          writable: true,
          primaryKey: false,
          default: within("draft", 'default="draft"', '"draft"'),
          constraints: {
            oneOf: [
              sp("draft", '"draft"'),
              sp("published", '"published"'),
            ],
          },
          position: at('attribute="state"'),
        },
        {
          name: sp("insertedAt", '"insertedAt"'),
          source: "create-timestamp",
          type: "datetime",
          allowNil: false,
          public: false,
          writable: false,
          primaryKey: false,
          default: null,
          constraints: null,
          position: at("create-timestamp"),
        },
        {
          name: sp("updatedAt", '"updatedAt"'),
          source: "update-timestamp",
          type: "datetime",
          allowNil: false,
          public: false,
          writable: false,
          primaryKey: false,
          default: null,
          constraints: null,
          position: at("update-timestamp"),
        },
      ],
      defaults: {
        kinds: [
          sp("read", '"read"'),
          sp("destroy", '"destroy"'),
        ],
        position: at("defaults="),
      },
      actions: [
        {
          kind: "create",
          name: sp("create", '"create"'),
          accept: [
            sp("title", '"title"', 1),
            sp("body", '"body"', 1),
          ],
          position: at('create="create"'),
        },
        {
          kind: "update",
          name: sp("publish", '"publish"'),
          accept: [sp("state", '"state"', 1)],
          position: at('update="publish"'),
        },
        { kind: "destroy", name: sp("archive", '"archive"'), accept: [], position: at('destroy="archive"') },
        { kind: "read", name: sp("published", '"published"', 1), position: at('read="published"') },
      ],
    },
  ],
};

/** A resource with every optional value absent. */
export const bareDocument: ModelDocument = {
  resources: [
    {
      name: { value: "tag", position: { file: "resources/tag.mx", line: 1, column: 10, offset: 10 } },
      table: null,
      domain: null,
      position: { file: "resources/tag.mx", line: 1, column: 0, offset: 0 },
      attributes: [],
      actions: [],
      defaults: null,
    },
  ],
};
