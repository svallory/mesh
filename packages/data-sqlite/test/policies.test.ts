// The policies domain suite (./domain/policies.ts) on an in-memory SQLite database; data-postgres runs the same suite.
import { policiesSuite } from "./domain/policies.ts";
import { sqliteDomain } from "./domain/sqlite.ts";

policiesSuite(sqliteDomain);
