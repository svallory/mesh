// The concepts domain suite (./domain/concepts.ts) on an in-memory SQLite database; data-postgres runs the same suite.
import { conceptsSuite } from "./domain/concepts.ts";
import { sqliteDomain } from "./domain/sqlite.ts";

conceptsSuite(sqliteDomain);
