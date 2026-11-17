// The key-types domain suite (./domain/key-types.ts) on an in-memory SQLite database; data-postgres runs the same suite.
import { keyTypesSuite } from "./domain/key-types.ts";
import { sqliteDomain } from "./domain/sqlite.ts";

keyTypesSuite(sqliteDomain);
