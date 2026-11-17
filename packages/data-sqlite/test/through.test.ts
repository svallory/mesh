// The through domain suite (./domain/through.ts) on an in-memory SQLite database; data-postgres runs the same suite.
import { throughSuite } from "./domain/through.ts";
import { sqliteDomain } from "./domain/sqlite.ts";

throughSuite(sqliteDomain);
