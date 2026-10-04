import { stableJsonStringify } from "../stable-json.ts";
import type { Emitter, EmitInput, GeneratedFile } from "../emit.ts";
import { orderedDocument, outputPrefix } from "./order.ts";

/**
 * `generated/model.json`: the whole model document, one entry per resource, written
 * as plain data with Mesh's own stable serialiser (lexicographic keys, two spaces,
 * one trailing newline). It is committed and guarded, so nothing that varies per
 * machine, per run or per insertion order may reach it: not a timestamp, not an
 * absolute path, not a random id. Positions inside are project-relative by the time
 * the builder stores them.
 */
export const modelJsonEmitter: Emitter = {
  name: "model-json",
  emit({ document, config }: EmitInput): Promise<readonly GeneratedFile[]> {
    const path = `${outputPrefix(config)}/model.json`;
    return Promise.resolve([{ path, contents: `${stableJsonStringify(orderedDocument(document))}\n` }]);
  },
};