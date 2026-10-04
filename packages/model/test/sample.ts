import type { ModelDocument, SourcePosition } from "../src/index.ts";

const file = "resources/post.mx";
const at = (line: number, column: number, offset: number): SourcePosition => ({
  file,
  line,
  column,
  offset,
});

/** The reduced `post.mx` of M1 as a model document. */
export const postDocument: ModelDocument = {
  resources: [
    {
      name: "post",
      table: "posts",
      domain: "blog",
      position: at(1, 0, 0),
      primaryKey: { name: "id", type: "uuid", position: at(3, 4, 60) },
      attributes: [
        {
          name: "title",
          type: "string",
          allowNil: false,
          public: true,
          default: null,
          constraints: null,
          position: at(4, 4, 88),
        },
        {
          name: "body",
          type: "string",
          allowNil: true,
          public: true,
          default: null,
          constraints: null,
          position: at(5, 4, 140),
        },
        {
          name: "views",
          type: "integer",
          allowNil: true,
          public: false,
          default: 0,
          constraints: null,
          position: at(6, 4, 180),
        },
        {
          name: "state",
          type: "atom",
          allowNil: true,
          public: false,
          default: "draft",
          constraints: { oneOf: ["draft", "published"] },
          position: at(7, 4, 220),
        },
      ],
      createTimestamp: { name: "insertedAt", position: at(8, 4, 300) },
      updateTimestamp: { name: "updatedAt", position: at(9, 4, 340) },
      defaults: { kinds: ["read", "destroy"], position: at(11, 2, 380) },
      actions: [
        {
          kind: "create",
          name: "create",
          accept: ["title", "body"],
          position: at(13, 4, 420),
        },
        { kind: "read", name: "published", accept: [], position: at(14, 4, 470) },
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
      position: at(1, 0, 0),
      primaryKey: null,
      attributes: [],
      createTimestamp: null,
      updateTimestamp: null,
      actions: [],
      defaults: null,
    },
  ],
};
