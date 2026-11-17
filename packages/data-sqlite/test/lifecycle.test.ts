// The lifecycle domain suite (./domain/lifecycle.ts) on an in-memory SQLite database; data-postgres runs the same suite.
import { lifecycleSuite } from "./domain/lifecycle.ts";
import { sqliteDomain } from "./domain/sqlite.ts";

lifecycleSuite(sqliteDomain);
