# Mesh's golden parse corpus

Every entity file and every `mx` doc block of Mesh at one point in time, with the
whole `lowerSource` result of each recorded in `__golden__/golden.json`. The test is
`../../mesh-corpus.test.ts`. It pins what `MESH_DIALECT` lowers, so a change to the
rows or the hooks in `src/front-end/syntax/` shows as a golden diff.

The corpus was made by MX's repository (`packages/core/src/fixtures/syntax/mesh-corpus/`
at MX commit `750c80ec1`) from Mesh's `main` at commit
`583150be044289d991e75312577727f8dca99405` (2026-10-09), and moved here when Mesh took
ownership of its syntax (the operator's ruling of 2026-10-10 14:09). The golden is MX's
file unchanged, which is the proof that Mesh's ported dialect lowers as MX's reference
module did.

## Source

- Licence: MIT, Mesh's own, copied unchanged into `LICENSE`.
- `entities/<path in Mesh>`: the 41 `.mesh.mx` files under Mesh's
  `examples/blog/src/domain/blog/` and `packages/compiler/test/fixtures/`, byte for byte.
- `docs/<page under apps/docs/docs>.<n>.mesh.mx`: the 22 `mx` fences of Mesh's docs,
  numbered in page order from 1 and dedented.
- `contracts.ts`: a frozen copy of Mesh's closed contracts of that commit (not the live
  ones), so the golden does not move when the contracts do. `model.ts`: the two lists
  those contracts read from `@meshfw/model`.
- `__golden__/golden.json`: the whole result of every file, lowered as `parseEntitySource`
  parses (`MESH_DIALECT`, the contracts above, `structural: "reject"`,
  `unknownTags: "reject"`, `imports: "pass"`), under the virtual path
  `/mesh-corpus/<file>`. The IR's `loc` is dropped (every `span` restates it), and each
  Babel node keeps its shape and the `mx*` marks on its `extra` but not its offsets.

## Updating

Regenerate the golden after a deliberate change to the syntax, and review its diff:

```sh
MESH_CORPUS_UPDATE=1 bun test packages/compiler/test/mesh-corpus.test.ts
```
