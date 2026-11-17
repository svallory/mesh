// The reads-load domain suite (./domain/reads-load.ts) on an in-memory SQLite database; data-postgres runs the same suite.
import { readsLoadSuite } from "./domain/reads-load.ts";
import { sqliteDomain } from "./domain/sqlite.ts";

readsLoadSuite(sqliteDomain);
