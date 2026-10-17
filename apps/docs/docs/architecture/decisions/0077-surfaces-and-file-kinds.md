---
title: "0077. A `surface` file lists what an audience may reach; the root tag decides a file's kind"
description: "Decision record 0077: the `surface` file kind, core's ownership of the surface format, fail-closed fields, the `publishes` line, the JSON-RPC adapter before the gate, and root-tag file kinds. Status: Accepted (DOM-02 in part, DOM-11, DOM-12, DOM-20, DOM-21, DOM-22)."
---

# 0077. A `surface` file lists what an audience may reach; the root tag decides a file's kind

## Status

Accepted. Supersedes [ADR-0035](./0035-meaning-of-public.md) (the `public` flag). Amends [ADR-0027](./0027-no-mcp-agent-surface.md) (the generated agent CLI reads a surface), [ADR-0051](./0051-mesh-mx-files-and-the-mesh-host.md) (every file is `.mesh.mx`; its root tag is its kind) and [ADR-0072](./0072-mesh-1-0-is-the-port-gate.md) (the JSON-RPC adapter is before the gate).

Rows: DOM-11, DOM-12, DOM-20, DOM-21, DOM-22 and the `publishes` half of DOM-02 (the `publish` half is in [ADR-0079](./0079-commands-events-and-the-outbox.md)). No row of this record is open.

## Date

2026-10-11

## Deciders

operator (Saulo Vallory), on 2026-10-10 (D1 of the [domain concepts study](../research/domain-concepts.md)) and 2026-10-11 (the rest). The study is the evidence; this record states the ruling.

## Context

A Mesh application has audiences: a command-line tool, a JSON-RPC socket, an HTTP API, an admin screen, an agent. Each should reach a chosen part of the domain, under its own names, and see only some fields. Mesh has no place to say that. [ADR-0005](./0005-core-interface-is-a-function-call.md) keeps core's interface a function call, [ADR-0038](./0038-elysia-is-not-core.md) keeps HTTP out of core, and [ADR-0035](./0035-meaning-of-public.md) left open what `public` on an attribute means "when the first transport is designed". The Hyper port needs a JSON-RPC server on a Unix socket, which is the first transport ([roadmap](../roadmap/roadmap.md), HA).

The [study](../research/domain-concepts.md) (sections 4 and 6) proposed one file per audience-specific entry point, and asked how files of several kinds are told apart now that Mesh will have more than one kind.

## Decision

1. **The file kind is `surface`** (DOM-11). One file per audience-specific entry point. It lists what that audience may call and see, under which names, with options per transport. Nothing is exposed unless listed. A surface declares no behaviour (no checks, steps or policies): it narrows what an audience can reach and never widens what policies allow.
2. **The root tag decides a file's kind, and every file keeps the `.mesh.mx` extension** (DOM-12). `entity :Task` and `surface :admin` are both `.mesh.mx` files. There is no `.surface.mesh.mx` suffix and no kind folder.
3. **Core owns the surface format, its view and its manifest** (DOM-21). Readers (Elysia, oclif, JSON-RPC, an admin UI) are adapters that read the generated manifest at run time; they import the generated folder and `@meshfw/runtime`, never the model ([ADR-0033](./0033-core-split-build-time-run-time.md)).
4. **Fields that leave through a surface fail closed** (DOM-22). A surface says `fields=[:title, :state]` or, explicitly, `fields=:all`. This replaces [ADR-0035](./0035-meaning-of-public.md)'s proposed per-attribute `public` flag. It is the rule that made policies fail closed ([ADR-0055](./0055-policies-are-core.md)).
5. **A surface lists the events it sends out** with a `publishes` section, one imported event identifier per child line (DOM-02, first half; the earlier `publishes events=[:completed, :updated]` is superseded, 2026-10-17). The events are declared once, in their own files, and raised with `publish` ([ADR-0079](./0079-commands-events-and-the-outbox.md)); `publishes` says which of them leave through this audience.
6. **`@meshfw/jsonrpc` comes before the gate** (DOM-20): newline-delimited JSON-RPC 2.0 over a Unix socket that takes a hand-written method table as plain data. Hyper's envelope mapping (`commandId`, `actor`, `caller`, phases) stays application code. After 1.0, surfaces generate that table.

An illustration of the shape (only the lines named above are ruled; the other options are the study's proposals, and each adapter contributes its own):

Updated 2026-10-17; the earlier form was `publishes events=[:completed]`.

```mx "src/surfaces/admin/admin.mesh.mx (illustration)"
import { Task } from "../../domain/work/task.mesh.mx"
import { TaskCompleted } from "../../domain/work/events/task-completed.mesh.mx"

surface :admin
  expose :tasks entity=Task label="Tasks" fields=[:title, :state]
    action :complete
  publishes
    TaskCompleted
```

## Options considered

**The name of the file kind** (D1 of the study):

| Name | For | Against |
|:--|:--|:--|
| `app` | The brief's working name | Clashes with the monorepo's `apps/`, with "your app" and with "one domain per app" ([ADR-0057](./0057-one-domain-modules-as-folders.md)) |
| **`surface`** (chosen) | Already the docs' loose word ("agent surface", "RPC surface"); no clash in TypeScript, DDD or the repository | Less familiar; abstract |
| `interface` | Accurate | TypeScript's `interface` keyword |
| `api` | Familiar | Implies HTTP |
| `port` | Hexagonal architecture's word | Clashes with "the Hyper port" and sits beside Mesh's "adapter" |

**How a file's kind is recognised** (D2): the root tag (chosen: one fact in one place, as [ADR-0057](./0057-one-domain-modules-as-folders.md) dropped `domain=`); a suffix such as `work.service.mesh.mx` (visible in a file list, but two sources for one fact); a folder (breaks modules as folders, [ADR-0057](./0057-one-domain-modules-as-folders.md)).

**The JSON-RPC adapter and surfaces** (D10): (a) both after 1.0, with Hyper writing its server and table in `examples/hyper`; (b) both before the gate; (c) the adapter before the gate with a hand-written table, surfaces after 1.0 (chosen). Hyper writes this server anyway, so packaging it costs about the same, and the table is hand-written, so it does not conflict with [ADR-0075](./0075-seams-use-the-extension-hosts-names.md)'s "no action manifest before 1.0".

**Who owns the format** (D11): core (chosen: the transport contract every transport adapter implements, [ADR-0001](./0001-three-rings.md)) or an extension.

**Fields** (D12): fail closed with `fields=` (chosen), or all attributes by default with an `omit=`.

## Trade-off analysis

A separate file per audience keeps exposure in one reviewable place, and it keeps domain files free of transport words. It costs a new kind of file and one more thing to read. Root-tag dispatch costs nothing a file name would give and avoids a second source for the kind. Fail-closed fields cost a line per surface and make a forgotten field invisible instead of leaked, the same trade that made policies deny by default.

## Consequences

- [ADR-0035](./0035-meaning-of-public.md) is Superseded by this record. Its `public` flag stays recorded in the model until a surface reads fields; nothing reads it today.
- [ADR-0027](./0027-no-mcp-agent-surface.md)'s "later a generated CLI" is a CLI generated from a surface (for example `surface :agent`), so it follows "nothing exposed unless listed". The generated rules file and test builders still read the whole model through `.mesh/model.json`: they are tooling, not exposure.
- [ADR-0051](./0051-mesh-mx-files-and-the-mesh-host.md) said entity and step files end in `.mesh.mx`: now every file does, and there are no step files ([ADR-0082](./0082-named-checks-and-mixins.md)).
- The roadmap changes: principle 8 ("how a program is exposed" is no longer wholly the application's business: core declares exposure as data and transports are adapters), the after-1.0 table (the admin interface and the command-line adapter read a surface), and HA (it keeps `@meshfw/jsonrpc` with a hand-written method table). [ADR-0072](./0072-mesh-1-0-is-the-port-gate.md) carries the matching note.
- Surfaces themselves are not built before the gate. Only the format and the adapters named above are ruled; the syntax inside a surface beyond the lines above is the study's proposal and gets its own design when the first adapter reads it.
- User docs: [Project structure](../../docs/project-structure.md) says "Mesh prescribes nothing under `src/`" and [Using your domain](../../docs/using-your-domain.md) shows hand-written command-line and HTTP integrations. Both need a section on surfaces when the construct is built.

## Action items

- [ ] Before the gate: `@meshfw/jsonrpc` with a hand-written method table (roadmap, HA).
- [ ] After 1.0: the surface contract, view and manifest emitter in core; the first adapter that reads it.
- [ ] When built: user-docs pages for surfaces, and the edits to Project structure and Using your domain named above.
