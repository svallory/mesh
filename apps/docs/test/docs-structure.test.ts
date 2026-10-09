import { expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const docs = new URL("../docs/docs/", import.meta.url).pathname;
const page = (name: string) => readFileSync(join(docs, `${name}.md`), "utf8");
const config = JSON.parse(readFileSync(new URL("../docmd.config.json", import.meta.url), "utf8"));

test("Docs navigation follows the structural review with a nested first-project group", () => {
  const nav = config.navigation.find((item: { title: string }) => item.title === "Docs").children;
  expect(nav.map((item: { title: string }) => item.title)).toEqual([
    "Introduction", "Quick start", "Working with AI agents", "Tutorial: a todo list",
    "Your first project", "Command line", "Customising generated code",
  ]);
  expect(nav[4].children).toEqual([
    { title: "Project structure", path: "/docs/project-structure/" },
    { title: "Entities", path: "/docs/entities/" },
    { title: "Using your domain", path: "/docs/using-your-domain/" },
    { title: "Testing", path: "/docs/testing/" },
    { title: "Configuration", path: "/docs/configuration/" },
  ]);
  expect(config.title).toBe("Mesh");
  // No image logo: docmd's text-title branch links to the site root.
  expect(config.logo).toBeUndefined();
});

test("user pages retain one release note and only the approved local-binary exception", () => {
  const names = readdirSync(docs).filter((name) => name.endsWith(".md"));
  expect(names).toHaveLength(11);
  for (const name of names) {
    const text = readFileSync(join(docs, name), "utf8");
    expect(text.match(/Mesh is not released yet\. These pages describe Mesh 1\.0\./g)).toHaveLength(1);
    expect(text).not.toMatch(/@meshfw\/cli|bun create meshfw|calling-actions/);
    expect(text.match(/bunx mesh/g) ?? []).toHaveLength(name === "quick-start.md" ? 1 : 0);
  }
  expect(existsSync(join(docs, "calling-actions.md"))).toBe(false);
});

test("Quick start is requirements, installation, running and a short domain call", () => {
  const quick = page("quick-start");
  expect([...quick.matchAll(/^## (.+)$/gm)].map((match) => match[1])).toEqual([
    "Requirements", "Install", "Run it", "Use your domain",
  ]);
  expect(quick).not.toContain("```mx");
  expect(quick).toContain("bun create mesh todo-app");
  expect(quick).toContain("mesh build\nmesh db push\nbun run demo");
  expect(quick).toContain('import { connect, createList, disconnect } from "#mesh"');
  const prompt = /Let an agent check[\s\S]*?```text\n([\s\S]*?)```/.exec(quick)![1]!;
  expect(prompt.trim().split("\n").length).toBeLessThanOrEqual(6);
  for (const requirement of ["Bun 1.3.14", "Git 2.x", "Visual Studio Code", "Verify", "Install", "Report"]) {
    expect(prompt).toContain(requirement);
  }
  expect(page("tutorial")).toContain("Replace the starter's `src/domain/todo/list.mesh.mx`");
  expect(page("tutorial")).toContain("Add `src/domain/todo/todo.mesh.mx`");
});

test("project configuration and command reference stay separate", () => {
  const project = page("configuration");
  expect(project).toContain('import { defineConfig } from "@meshfw/runtime"');
  expect(project).not.toContain('from "meshfw"');
  expect(project).toContain("## src/context.ts");
  expect(project).toContain("## Environment");
  expect(project).not.toContain("## The guard");
  const commands = page("command-line");
  for (const heading of ["init", "build", "The guard", "inspect", "explain", "Migrations"]) {
    expect(commands).toContain(`## ${heading}`);
  }
  expect(commands).toContain("mesh export generators");
  expect(commands).toContain("Exit codes: `0` success, `1` errors were found, `2` usage error.");
});

test("integration snippets are explicitly excerpts rather than claimed type-checked files", () => {
  const integrations = page("using-your-domain").split("## From a command line")[1]!;
  expect(integrations).toContain("## Over HTTP");
  expect(integrations).toContain("## In a web app");
  expect([...integrations.matchAll(/^```ts [^\n]*\(excerpt\)"$/gm)]).toHaveLength(3);
  expect(integrations).toContain("status(400");
  expect(integrations).toContain("status(403");
  expect(integrations).toContain('"use server";');
  const solidStartSection = integrations.split("## In a web app")[1]!;
  const solidStart = /```ts[^\n]*\n([\s\S]*?)```/.exec(solidStartSection)![1]!;
  expect(solidStart).toContain('return { data: await createList({ name }, { actor }) };');
  for (const error of ["InvalidInputError", "ForbiddenError"]) {
    expect(solidStart).toContain(`if (error instanceof ${error}) return { error: { code: error.code } };`);
  }
  expect(solidStart).not.toMatch(/return[^\n]*(?:issues|breakdown|source)/);
});
