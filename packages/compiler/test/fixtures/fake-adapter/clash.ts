import { relative } from "node:path";
import { fakeGenerator } from "./build.ts";
import type { AdapterBuild } from "../../../src/index.ts";

// Writes model.json, which the core emitter owns.
export default {
  generators: [{ ...fakeGenerator, name: "clashing", views: ({ config }) =>
    [{ path: `${relative(config.root, config.output).split("\\").join("/")}/model.json`, view: { names: [] } }] }],
} satisfies AdapterBuild;
