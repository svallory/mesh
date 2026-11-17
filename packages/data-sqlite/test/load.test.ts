// The load domain suite (./domain/load.ts) on an in-memory SQLite database; data-postgres runs the same suite.
import { loadSuite } from "./domain/load.ts";
import { sqliteDomain } from "./domain/sqlite.ts";

loadSuite(sqliteDomain);
