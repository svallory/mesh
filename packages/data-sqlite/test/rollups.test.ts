// The rollups domain suite (./domain/rollups.ts) on an in-memory SQLite database; data-postgres runs the same suite.
import { rollupsSuite } from "./domain/rollups.ts";
import { sqliteDomain } from "./domain/sqlite.ts";

rollupsSuite(sqliteDomain);
