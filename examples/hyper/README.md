# Hyper on Mesh

Hyper's 18 entities as `.mesh.mx` files, in four modules under `src/domain/`: `identity`, `work`, `execution` and `audit`. They hold what Mesh builds today; [PORTING.md](./PORTING.md) lists each construct left out, with the milestone that delivers it.

```sh
bun install
mesh build        # writes .mesh/
mesh db push      # creates the 18 tables in hyper.db
bun test          # round-trips a row of every entity through its generated functions
```
