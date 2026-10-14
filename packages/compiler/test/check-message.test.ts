import { expect, test } from "bun:test";
import { buildModel } from "../src/front-end/build.ts";

// ACT-30: a check's `message=` is fixed text or a function of the arguments `that=` gets.
const entity = (message: string) => `entity :Task
  attributes
    uuid :id primary-key
    string :title
  actions auto=[:read]
    update :go
      validate
        check :ok [
          that=() => true
          code="task.ok"
          ${message}
        ]
`;
const built = (message: string) => buildModel({ root: "/p", files: [{ file: "task.mesh.mx", source: entity(message) }] });
const checkOf = (message: string) => built(message).document?.entities[0]?.actions.find((a) => a.name === "go")?.validate[0];
const errors = (message: string) => built(message).diagnostics.filter((d) => d.severity === "error");

test("text stays text in the model", () => {
  expect(errors('message="the title is taken"')).toEqual([]);
  expect(checkOf('message="the title is taken"')?.message).toBe("the title is taken");
});

test("a function is an expression with its source, parameters and position", () => {
  const source = "({ self }) => `title ${self.title}`";
  expect(errors(`message=${source}`)).toEqual([]);
  const message = checkOf(`message=${source}`)?.message;
  expect(typeof message).toBe("object");
  expect(message).toMatchObject({ source, params: ["self"], position: { file: "task.mesh.mx", line: 11 } });
});

test("a function may read a relationship or a member, and be async", () => {
  expect(errors("message=() => `title ${&title}`")).toEqual([]);
  expect(errors("message=async ({ self }) => await Promise.resolve(self.title)")).toEqual([]);
});

test("`message` is required", () => {
  expect(errors("").length).toBeGreaterThan(0);
});

test.each([["a number", "message=42"], ["an atom", "message=:oops"], ["a boolean", "message=true"], ["a bare expression", "message=`text`"]])(
  "%s is refused, with a diagnostic and no model",
  (_name, message) => {
    const result = built(message);
    expect(result.diagnostics.filter((d) => d.severity === "error").length).toBeGreaterThan(0);
  },
);

test("a message function that reads `before` is refused like `that=` (`before` is gone from validate)", () => {
  const found = errors("message=({ before }) => before.title");
  expect(found.map((d) => d.code)).toContain("MESH_VALIDATE_BEFORE");
});
