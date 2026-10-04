import type { ModelDocument } from "../src/index.ts";
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

/** What a correct builder produces for `postSource`. */
export const postDocument: ModelDocument = {
  resources: [
    {
      name: "post",
      table: "posts",
      domain: "blog",
      position: at('resource="post"'),
      attributes: [
        {
          name: "id",
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
          name: "title",
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
          name: "body",
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
          name: "views",
          source: "attribute",
          type: "integer",
          allowNil: true,
          public: false,
          writable: true,
          primaryKey: false,
          default: { value: 0, position: at("default=0") },
          constraints: null,
          position: at('attribute="views"'),
        },
        {
          name: "rating",
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
          name: "featured",
          source: "attribute",
          type: "boolean",
          allowNil: true,
          public: false,
          writable: true,
          primaryKey: false,
          default: { value: false, position: at("default=false") },
          constraints: null,
          position: at('attribute="featured"'),
        },
        {
          name: "token",
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
          name: "publishedAt",
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
          name: "state",
          source: "attribute",
          type: "atom",
          allowNil: true,
          public: false,
          writable: true,
          primaryKey: false,
          default: { value: "draft", position: at('default="draft"') },
          constraints: {
            oneOf: [
              { value: "draft", position: at('"draft"') },
              { value: "published", position: at('"published"') },
            ],
          },
          position: at('attribute="state"'),
        },
        {
          name: "insertedAt",
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
          name: "updatedAt",
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
          { value: "read", position: at('"read"') },
          { value: "destroy", position: at('"destroy"') },
        ],
        position: at("defaults="),
      },
      actions: [
        {
          kind: "create",
          name: "create",
          accept: [
            { value: "title", position: at('"title"', 1) },
            { value: "body", position: at('"body"', 1) },
          ],
          position: at('create="create"'),
        },
        {
          kind: "update",
          name: "publish",
          accept: [{ value: "state", position: at('"state"', 1) }],
          position: at('update="publish"'),
        },
        { kind: "destroy", name: "archive", accept: [], position: at('destroy="archive"') },
        { kind: "read", name: "published", position: at('read="published"') },
      ],
    },
  ],
};

/** A resource with every optional value absent. */
export const bareDocument: ModelDocument = {
  resources: [
    {
      name: "tag",
      table: null,
      domain: null,
      position: { file: "resources/tag.mx", line: 1, column: 0, offset: 0 },
      attributes: [],
      actions: [],
      defaults: null,
    },
  ],
};
