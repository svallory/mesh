// The caller-computed domain suite (./domain/caller-computed.ts) on an in-memory SQLite database; data-postgres runs the same suite.
import { callerComputedSuite } from "./domain/caller-computed.ts";
import { sqliteDomain } from "./domain/sqlite.ts";

callerComputedSuite(sqliteDomain);
