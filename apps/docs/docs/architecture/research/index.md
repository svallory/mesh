---
title: "Research"
description: "Investigations that fed Mesh decisions: eleven documents on Ash, TypeScript prior art, durable engines, expression languages and validation libraries, with their fact-check reviews."
---

# Research

This area holds the investigations behind decisions: surveys of other frameworks and engines, comparisons, and experiments. Each document states its question and date, links every claim to a source, and says what it changed.

Research is evidence, not a commitment. A decision belongs in [Decisions](../decisions/index.md). A document belongs here when it answers a question about other systems or about options, cites sources for its claims, and has been checked against those sources by someone other than its author. A choice between options, with a status, belongs in a decision record.

## Documents, in reading order

Start with the synthesis, then read the document for the layer you care about. Word counts are for the page body. The verdict is the reviewer's final one; "Accept with fixes" means the document is usable once the reader applies the residual-error list at the end of the review.

| # | Document | What it answers | Words | Review verdict |
|---|---|---|---|---|
| 00 | [Research synthesis](./synthesis.md) | What do the seven research documents add up to, and what architecture do they suggest for Mesh? | 5,209 | No review file |
| 01 | [Ash core feature inventory](./ash-features.md) | What does Ash 3.x offer, feature by feature? | 10,575 | [Accept with fixes](./reviews/ash-features-review.md) |
| 02 | [Ash DSL and extension system](./ash-dsl-and-extensions.md) | How do Spark, extension authoring and Igniter let Ash define and extend its DSL? | 16,202 | [Accept](./reviews/ash-dsl-and-extensions-review.md) |
| 03 | [Ash run-time architecture](./ash-runtime-internals.md) | How does Ash run an action: lifecycle, data layer contract, expressions, policies and loading? | 16,049 | [Accept with fixes](./reviews/ash-runtime-internals-review.md) |
| 04 | [The Ash ecosystem packages](./ash-ecosystem-packages.md) | Which Ash ecosystem packages matter for domain work, and what do they do? | 16,756 | [Accept](./reviews/ash-ecosystem-packages-review.md) |
| 05 | [Ash strengths and weaknesses](./ash-strengths-weaknesses.md) | Where is Ash strongest and weakest, according to verified evidence? | 12,509 | [Accept](./reviews/ash-strengths-weaknesses-review.md) |
| 06 | [TypeScript prior art](./ts-prior-art.md) | Which TypeScript projects already try to "declare the model, derive the rest"? | 14,079 | [Accept with fixes](./reviews/ts-prior-art-review.md) |
| 07 | [Candidate foundation libraries](./ts-foundation-candidates.md) | Which libraries could Mesh build on, layer by layer? | 16,255 | [Accept with fixes](./reviews/ts-foundation-candidates-review.md) |
| 08 | [Durable workflow engines](./durable-engines.md) | Which durable workflow engines exist, and what adapter interface could Mesh offer them? | 10,588 | [Accept with fixes](./reviews/durable-engines-review.md) |
| 09 | [Expression language](./expression-language.md) | Can an existing project carry Mesh's expression language, in memory and as SQL? Decision: [ADR-0056](../decisions/0056-translated-expressions-are-one-expression-arrows.md) | 6,820 | [Corrected in place](./reviews/expression-language-review.md): conclusion rewritten (Greffon) |
| 10 | [Validation library](./validation-library.md) | Which validation library should Mesh generate validators with? Decision: [ADR-0062](../decisions/0062-direct-dependencies-zod-drizzle-opentelemetry.md) (keeps Zod, against the document's pick) | 4,609 | No review file |

## Reviews

Each review is an independent fact-check of one document against primary sources. They are moved here unchanged, so they refer to the original local file names (`notes/research/NN-topic.md`).

- [Review: Ash core feature inventory](./reviews/ash-features-review.md): Accept with fixes, 8,085 words.
- [Review: Ash DSL and extension system](./reviews/ash-dsl-and-extensions-review.md): Accept, 7,592 words.
- [Review: Ash run-time architecture](./reviews/ash-runtime-internals-review.md): Accept with fixes, 8,647 words.
- [Review: The Ash ecosystem packages](./reviews/ash-ecosystem-packages-review.md): Accept, 9,507 words.
- [Review: Ash strengths and weaknesses](./reviews/ash-strengths-weaknesses-review.md): Accept, 9,997 words.
- [Review: TypeScript prior art](./reviews/ts-prior-art-review.md): Accept with fixes, 11,365 words.
- [Review: Candidate foundation libraries](./reviews/ts-foundation-candidates-review.md): Accept with fixes, 11,041 words.
- [Review: Durable workflow engines](./reviews/durable-engines-review.md): Accept with fixes, 7,592 words.
- [Review: Expression language](./reviews/expression-language-review.md): the document was corrected in place after this review (47 claims confirmed, 15 corrected, 7 not verifiable), 2,041 words.
