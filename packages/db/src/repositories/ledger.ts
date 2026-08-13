import { and, eq, sql, type SQL } from 'drizzle-orm';

import { addMicros, MoneyError, normalizeUsd, parseUsdToMicros } from '../accounting/money.js';
import type { UtcAccountingDay } from '../accounting/utc-day.js';
import { agents } from '../schema/agents.js';
import { ledgerDaily } from '../schema/ledger.js';
import type { DatabaseExecutor } from './executor.js';
import type { WorkspaceScope } from './workspace-scope.js';

/**
 * The authoritative UTC-day ledger.
 *
 * THE PLANE IS THE LEDGER; THE PLUGIN IS THE HANDS. This is the single
 * authoritative record of what has been committed. There is exactly one row per
 * `(workspace_id, agent_id, day)` and no second ledger anywhere - not for
 * prechecks, not for events, not for the UI.
 *
 * ─── PRIMITIVES, NOT DECISIONS ────────────────────────────────────────────
 *
 * Nothing here decides whether an action is allowed. These operations record
 * what a caller has already decided to commit. The decision - comparing a cap
 * to committed usage - belongs to the Step 15 precheck engine, which composes
 * these primitives inside its own transaction alongside the receipt it writes.
 *
 * This module therefore imports NO policy table, NO receipt table, NO block
 * table and NO event table. A guardrail test enforces each of those.
 *
 * ─── TRANSACTION COMPOSITION ──────────────────────────────────────────────
 *
 * Every primitive takes the caller's `DatabaseExecutor`. This module NEVER
 * opens a transaction of its own. If it did, a decision service holding a lock
 * would find its ledger write committing on a different connection - the row
 * lock would protect nothing, and the receipt could commit while the debit
 * rolled back. A guardrail test asserts `db.transaction(` never appears here.
 *
 * ─── THE INTENDED STEP 15 SHAPE ───────────────────────────────────────────
 *
 *   BEGIN
 *     load policy (caps, mode)
 *     lockOrCreate(agent, day)        <- serializes this agent/day
 *     decide against the locked usage
 *     if allowed: commitSpend / commitPublish
 *     write the receipt
 *     maybe write a block
 *   COMMIT
 */

/** The scope predicate every ledger query is anchored on. */
export function ledgerScopePredicate(scope: WorkspaceScope): SQL {
  return eq(ledgerDaily.workspaceId, scope.workspaceId);
}

/** One authoritative agent/day row, normalised for application use. */
export interface DailyLedgerState {
  readonly workspaceId: string;
  /** Internal agent UUID. */
  readonly agentId: string;
  readonly day: UtcAccountingDay;
  /** Canonical decimal string, always six fractional digits. Never a number. */
  readonly spendCommittedUsd: string;
  readonly publishCountCommitted: number;
}

/**
 * A capability granting mutation of ONE serialized agent/day row.
 *
 * ─── WHY A CAPABILITY AND NOT PLAIN METHODS ───────────────────────────────
 *
 * The mutation functions do not exist until the row lock has been acquired.
 * That is the whole point: an earlier revision exposed
 * `commitSpend(agentId, day, amount)` on the repository, which could be called
 * without ever locking - performing a read-modify-write with no serialization,
 * which is precisely the lost-update race this module exists to prevent.
 *
 * Correct sequencing must not rest on developer discipline. Here the unsafe
 * call is not merely discouraged, it is unspeakable: there is no object to call
 * it on until `lockDailyLedger` has returned.
 *
 * ─── THE KEY IS BOUND, NOT PASSED ─────────────────────────────────────────
 *
 * No mutation method takes a workspace, agent or day. The capability closes
 * over exactly the row it locked, so `locked.commitSpend(...)` cannot be
 * pointed at a different agent or a different day than the one serialized -
 * removing an entire class of mismatched-key bugs.
 *
 * ─── VALID ONLY INSIDE THE ACQUIRING TRANSACTION ──────────────────────────
 *
 * The lock lives until that transaction commits or rolls back. Holding this
 * object past the transaction leaves a handle whose lock is gone; it is a
 * transaction-local value and is never stored or returned across one.
 *
 * ─── NO POLICY ────────────────────────────────────────────────────────────
 *
 * It knows nothing of modes, caps, policy versions or allow/deny. It owns
 * serialized accounting mutation and nothing else. Step 15 evaluates policy
 * against `current` and decides.
 */
export interface LockedDailyLedger {
  /**
   * Committed state, reflecting every mutation made through this capability
   * so far in this transaction.
   *
   * Step 15 reads this to decide, and reads it again after committing to
   * record receipt evidence - with no unlocked re-read, which would both waste
   * a query and reintroduce a stale-read hazard.
   */
  readonly current: DailyLedgerState;

  /**
   * Adds to committed spend on the locked row. NOT a cap decision.
   *
   * @throws {LedgerCapacityError} when the total would exceed `numeric(14,6)`.
   */
  commitSpend(amountUsd: string): Promise<DailyLedgerState>;

  /** Adds to the committed publish count on the locked row. NOT a decision. */
  commitPublish(count?: number): Promise<DailyLedgerState>;
}

/**
 * Query builders.
 *
 * Separated from execution so architecture tests can render the emitted SQL
 * and prove the workspace, agent and day predicates are all present.
 */
export const ledgerQueries = {
  /**
   * Reads one agent/day row WITHOUT locking it.
   *
   * For reporting only. A decision must never read through this: the value
   * would be stale the instant it returned, which is precisely the race
   * `lockForUpdate` exists to close.
   */
  find: (
    executor: DatabaseExecutor,
    scope: WorkspaceScope,
    agentId: string,
    day: UtcAccountingDay,
  ) =>
    executor
      .select()
      .from(ledgerDaily)
      .where(
        and(
          ledgerScopePredicate(scope),
          eq(ledgerDaily.agentId, agentId),
          eq(ledgerDaily.day, day),
        ),
      )
      .limit(1),

  /**
   * Reads one agent/day row AND locks it for the rest of the transaction.
   *
   * THE CORE CONCURRENCY PRIMITIVE. Without it:
   *
   *   cap = $25, committed = $20
   *   request A wants $4    reads 20, thinks it fits
   *   request B wants $4    reads 20, thinks it fits
   *   both commit           final = $28, over a $25 cap
   *
   * `FOR UPDATE` makes the second transaction wait until the first commits,
   * then read $24 and be denied. Step 15 owns the denial; this owns the
   * serialization that makes a correct denial possible.
   */
  lockForUpdate: (
    executor: DatabaseExecutor,
    scope: WorkspaceScope,
    agentId: string,
    day: UtcAccountingDay,
  ) =>
    executor
      .select()
      .from(ledgerDaily)
      .where(
        and(
          ledgerScopePredicate(scope),
          eq(ledgerDaily.agentId, agentId),
          eq(ledgerDaily.day, day),
        ),
      )
      .for('update')
      .limit(1),

  /**
   * Creates the agent's row for a day if it does not exist yet.
   *
   * `ON CONFLICT DO NOTHING` on the composite primary key. The first action of
   * a UTC day can arrive concurrently, and a bare `SELECT absent -> INSERT`
   * would let both requests insert - one crashing on the primary key, or worse,
   * two rows if the key were ever relaxed. Here the loser inserts nothing and
   * then reads the winner's committed row.
   *
   * Usage starts at zero, never null: null would make "no spend yet"
   * indistinguishable from "unknown", and every later addition would need a
   * coalesce that could silently mask a missing row.
   */
  insertIfAbsent: (
    executor: DatabaseExecutor,
    scope: WorkspaceScope,
    agentId: string,
    day: UtcAccountingDay,
  ) =>
    executor
      .insert(ledgerDaily)
      .values({
        // Workspace from the SCOPE, never from caller input.
        workspaceId: scope.workspaceId,
        agentId,
        day,
        spendCommittedUsd: '0.000000',
        publishCountCommitted: 0,
      })
      .onConflictDoNothing({
        target: [ledgerDaily.workspaceId, ledgerDaily.agentId, ledgerDaily.day],
      }),

  /** Confirms the agent belongs to this workspace before a row is created. */
  findScopedAgent: (executor: DatabaseExecutor, scope: WorkspaceScope, agentId: string) =>
    executor
      .select({ id: agents.id })
      .from(agents)
      .where(and(eq(agents.workspaceId, scope.workspaceId), eq(agents.id, agentId)))
      .limit(1),
} as const;

export interface LedgerRepository {
  /**
   * Reads committed usage WITHOUT locking. Observability only.
   *
   * NOT VALID FOR READ-COMPARE-WRITE GOVERNANCE DECISIONS. The value is stale
   * the instant it returns, so deciding against it would let two concurrent
   * requests both believe they fit under a cap. Enforcement uses
   * `lockDailyLedger`; this exists for reporting surfaces that only display a
   * number.
   *
   * @returns null when the agent has no activity on that day. A caller must
   *   treat that as zero usage, not as an error.
   */
  findDailyLedger(agentId: string, day: UtcAccountingDay): Promise<DailyLedgerState | null>;

  /**
   * Creates the row if needed, locks it, and returns the ONLY handle through
   * which it can be mutated.
   *
   * Must be called inside a transaction: outside one the lock is released
   * immediately and guarantees nothing.
   *
   * @returns null when the agent is not in this workspace - indistinguishable
   *   from an agent that does not exist. No row is created in that case.
   */
  lockDailyLedger(
    agentId: string,
    day: UtcAccountingDay,
  ): Promise<LockedDailyLedger | null>;
}

/** Raised when a ledger mutation targets a row that does not exist. */
export class LedgerRowMissingError extends Error {
  public constructor() {
    // No ids: this may reach a log, and the HTTP layer collapses it anyway.
    super('Ledger row missing; lockOrCreate must run first.');
    this.name = 'LedgerRowMissingError';
  }
}

/** Normalises a raw row so driver numeric behaviour never escapes this module. */
function toLedgerRow(row: typeof ledgerDaily.$inferSelect): DailyLedgerState {
  return {
    workspaceId: row.workspaceId,
    agentId: row.agentId,
    // Already 'YYYY-MM-DD': the column is mapped in string mode so it never
    // passes through a Date and cannot be shifted by a local zone.
    day: row.day as UtcAccountingDay,
    // PostgreSQL may render `0` or `25.0`; the canonical form is always six
    // fractional digits, so callers never see two shapes for one amount.
    spendCommittedUsd: normalizeUsd(row.spendCommittedUsd),
    publishCountCommitted: row.publishCountCommitted,
  };
}

export function createLedgerRepository(
  executor: DatabaseExecutor,
  scope: WorkspaceScope,
): LedgerRepository {
  /**
   * The row predicate, bound once per capability.
   *
   * Built from the locked key, so a mutation can only ever address the row
   * that was serialized.
   */
  function rowPredicate(agentId: string, day: UtcAccountingDay): SQL | undefined {
    return and(
      ledgerScopePredicate(scope),
      eq(ledgerDaily.agentId, agentId),
      eq(ledgerDaily.day, day),
    );
  }

  /**
   * Builds the mutation capability for an already-LOCKED row.
   *
   * Module-private and reachable only from `lockDailyLedger`, after the lock
   * has been acquired. `agentId` and `day` are captured here and never appear
   * in a method signature, so the caller cannot retarget another agent, day or
   * workspace.
   */
  function createLockedLedger(
    agentId: string,
    day: UtcAccountingDay,
    initial: DailyLedgerState,
  ): LockedDailyLedger {
    // Tracks committed state across mutations so `current` always reflects
    // this transaction, and Step 15 never needs an unlocked re-read.
    let state = initial;

    return {
      get current(): DailyLedgerState {
        return state;
      },

      async commitSpend(amountUsd: string): Promise<DailyLedgerState> {
        // Capacity is checked in exact micro-dollars BEFORE the write, so the
        // caller gets a typed error rather than a PostgreSQL numeric overflow.
        // The column precision remains defense in depth.
        addMicros(parseUsdToMicros(state.spendCommittedUsd), parseUsdToMicros(amountUsd));

        const updated = await executor
          .update(ledgerDaily)
          .set({
            // Added in SQL against the locked row rather than written back
            // from a JavaScript-computed total. PostgreSQL `numeric` addition
            // is exact, and doing it in the database means the statement is
            // atomic on its own - defense in depth behind the row lock.
            spendCommittedUsd: sql`${ledgerDaily.spendCommittedUsd} + ${amountUsd}::numeric`,
            updatedAt: sql`now()`,
          })
          .where(rowPredicate(agentId, day))
          .returning();

        const row = updated[0];
        if (row === undefined) {
          throw new LedgerRowMissingError();
        }
        // A spend NEVER touches the publish counter.
        state = toLedgerRow(row);
        return state;
      },

      async commitPublish(count = 1): Promise<DailyLedgerState> {
        // A publish delta is always at least one. Zero would be a silent no-op
        // that still looked like a recorded publish, and a negative would be a
        // hidden credit.
        if (!Number.isSafeInteger(count) || count < 1) {
          throw new MoneyError('Publish delta must be a positive whole number.');
        }

        const updated = await executor
          .update(ledgerDaily)
          .set({
            publishCountCommitted: sql`${ledgerDaily.publishCountCommitted} + ${count}`,
            updatedAt: sql`now()`,
          })
          .where(rowPredicate(agentId, day))
          .returning();

        const row = updated[0];
        if (row === undefined) {
          throw new LedgerRowMissingError();
        }
        // A publish NEVER touches committed spend.
        state = toLedgerRow(row);
        return state;
      },
    };
  }

  return {
    async findDailyLedger(
      agentId: string,
      day: UtcAccountingDay,
    ): Promise<DailyLedgerState | null> {
      const rows = await ledgerQueries.find(executor, scope, agentId, day);
      const row = rows[0];
      return row === undefined ? null : toLedgerRow(row);
    },

    async lockDailyLedger(
      agentId: string,
      day: UtcAccountingDay,
    ): Promise<LockedDailyLedger | null> {
      // The agent must belong to THIS workspace. A globally unique UUID is not
      // authorization: without this, holding another tenant's agent id would
      // create a ledger row for them. The composite FK to
      // `agents(workspace_id, id)` would also refuse the insert, but that
      // surfaces as an opaque driver error rather than a clean "not found".
      const found = await ledgerQueries.findScopedAgent(executor, scope, agentId);
      if (found[0] === undefined) {
        return null;
      }

      // Conflict-safe: concurrent first-actions of a day both reach here and
      // exactly one insert takes effect.
      await ledgerQueries.insertIfAbsent(executor, scope, agentId, day);

      const locked = await ledgerQueries.lockForUpdate(executor, scope, agentId, day);
      const row = locked[0];
      if (row === undefined) {
        // Unreachable: the insert above guarantees the row exists, and the
        // agent check guarantees the FK is satisfiable.
        throw new LedgerRowMissingError();
      }

      // The lock is now held for the rest of the CALLER's transaction. Only
      // from here does a mutation capability exist at all.
      return createLockedLedger(agentId, day, toLedgerRow(row));
    },
  };
}
