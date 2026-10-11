# Hyper on Mesh

Hyper's 18 entities as `.mesh.mx` files, in four modules under `src/domain/`: `identity`, `work`, `execution` and `audit`. They hold what Mesh builds today: the data, the actions with Hyper's rules, and each command's effects inside its own aggregate. The commands whose effects reach another aggregate, or whose result adds `warnings` or a late result, are plain functions in `src/domain/<module>/<module>.commands.ts` (`taskComplete`, `taskCancel`, `submissionSubmit`, `reviewAccept`, `membershipRevoke`, `collaboratorRetire`, `attemptStart`, `sessionRecord`); call those, not the generated action of the same command, which skips that part. [PORTING.md](./PORTING.md) lists each construct left out, with the milestone that delivers it, and where each of Hyper's 13 effects lives.

```sh
bun install
mesh build        # writes .mesh/
mesh db push      # creates the 18 tables in hyper.db
bun test          # the rules, the effects, the relationships and a round-trip of every entity
```
