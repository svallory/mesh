import { defineConfig } from "@meshfw/runtime";
import { sqlite } from "@meshfw/data-sqlite";

export default defineConfig({
  domain: "src/domain",
  output: ".mesh",
  data: sqlite({ file: "hyper.db" }),
});
