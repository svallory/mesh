import { defineConfig } from "@meshfw/runtime";
import { sqlite } from "@meshfw/data-sqlite";

export default defineConfig({
  domain: "src/domain",
  surfaces: "src/surfaces",
  output: ".mesh",
  data: sqlite({ file: "blog.db" }),
});
