/**
 * Drizzle schema barrel.
 *
 * INTENTIONALLY EMPTY THROUGH STEP 2
 * ----------------------------------
 * This file marks *where* the schema lives, nothing more. No domain tables are
 * defined yet.
 *
 * Step 2 delivered the database *infrastructure* - driver, pooling, migration
 * mechanism, readiness probing - deliberately without any domain modelling.
 * `drizzle-kit generate` therefore reports `0 tables` and produces no SQL
 * migration, which is the accurate outcome rather than a manufactured one.
 *
 * The Credit-phase domain schema (workspaces, memberships, API keys, agents,
 * events, policies, ledger entries, receipts, blocks, share links) is created
 * in Step 3 and in the feature steps that own each table.
 *
 * When tables are added, export each table module from here so that
 * `drizzle-kit` and `createDatabaseClient` see a single, complete schema.
 */

// Intentionally no exports yet. Adding one before Step 3 is out of scope.
export {};
