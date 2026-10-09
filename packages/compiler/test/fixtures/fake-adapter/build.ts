// A data adapter's build half for compiler tests: no dependency on packages/data-*.
import { relative, resolve } from "node:path";
import type { AdapterBuild, Generator } from "../../../src/index.ts";

export interface FakeView { readonly names: readonly string[] }

export const fakeGenerator: Generator<FakeView> = {
  name: "fake-tables",
  template: "fake.ts.jig",
  templateDir: resolve(import.meta.dir, "templates"),
  requires: [],
  views({ document, config }) {
    const prefix = relative(config.root, config.output).split("\\").join("/");
    return [{ path: `${prefix}/fake.ts`, view: { names: document.entities.map((entity) => entity.name).sort() } }];
  },
};

export const calls: string[][] = [];

const build: AdapterBuild = {
  generators: [fakeGenerator],
  commands: {
    "db push": async ({ args, stdout, config }) => {
      calls.push([...args]);
      stdout(`fake push ${config.data.name} ${args.join(" ")}\n`);
      return args.includes("--fail") ? 1 : 0;
    },
  },
};
export default build;
