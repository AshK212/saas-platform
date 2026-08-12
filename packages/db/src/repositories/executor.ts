import type { DatabaseClient } from '../client.js';

/**
 * Database executor types.
 *
 * WHY THIS EXISTS
 * ---------------
 * Later enforcement (ledger commits, precheck decisions, atomic receipt+block
 * creation) must run repository operations inside the SAME PostgreSQL
 * transaction that locks the ledger row. If repositories only accepted the
 * top-level client, that would be impossible and the data layer would have to
 * be rewritten at the ledger step.
 *
 * So every repository takes a `DatabaseExecutor`, which is satisfied by both
 * the pooled client and a transaction handle:
 *
 *   const repo = createAgentRepository(db, scope);            // pooled
 *   await db.transaction(async (tx) => {
 *     const repo = createAgentRepository(tx, scope);          // transactional
 *   });
 *
 * The transaction type is DERIVED from the client's own `transaction` signature
 * rather than imported from a deep Drizzle path, so it cannot drift out of sync
 * with the driver and does not depend on Drizzle's internal module layout.
 */

/** The handle Drizzle passes into a `transaction(...)` callback. */
export type DatabaseTransaction = Parameters<Parameters<DatabaseClient['transaction']>[0]>[0];

/**
 * Anything capable of running a query: the pooled client or a transaction.
 * Repositories depend on this, never on the concrete client.
 */
export type DatabaseExecutor = DatabaseClient | DatabaseTransaction;
