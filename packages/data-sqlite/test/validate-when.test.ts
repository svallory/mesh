// The validate-when domain suite (./domain/validate-when.ts) on an in-memory SQLite database; data-postgres runs the same suite.
import { validateWhenSuite } from "./domain/validate-when.ts";
import { sqliteDomain } from "./domain/sqlite.ts";

validateWhenSuite(sqliteDomain);
