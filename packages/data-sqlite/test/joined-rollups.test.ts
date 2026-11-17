// The joined-route rollups domain suite (./domain/joined-rollups.ts) on an in-memory SQLite database; data-postgres runs the same suite.
import { joinedRollupsSuite } from "./domain/joined-rollups.ts";
import { sqliteDomain } from "./domain/sqlite.ts";

joinedRollupsSuite(sqliteDomain);
