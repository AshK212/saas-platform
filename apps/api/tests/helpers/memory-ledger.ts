/**
 * The in-memory `ledger_daily`, SHARED by both accounting paths.
 *
 * ─── WHY THIS EXISTS ──────────────────────────────────────────────────────
 *
 * Production has exactly one `ledger_daily` table, and two paths write to it:
 *
 *   A. a precheck ALLOW for spend                     (Step 15)
 *   B. a NEW unprechecked `spend.recorded` event      (Step 19)
 *
 * The invariant that matters most is that the SAME economic action never uses
 * both. Step 18 reported an honest limitation here: the precheck fake owned a
 * ledger, the event fake owned none, so "the linked event did not debit" was
 * nearly true by construction and a mutation probe adding a debit to production
 * could only be caught by a source guard.
 *
 * One shared ledger closes that. Both fakes now mutate the same rows, so
 * `$4 not $8` is a real assertion in process and a double debit actually fails
 * a test.
 *
 * ─── WHAT IT STILL CANNOT PROVE ───────────────────────────────────────────
 *
 * It is single-threaded JavaScript. There is no row lock, because nothing here
 * can interleave. Whether `SELECT … FOR UPDATE` really serializes two
 * concurrent debits - the lost-update case Step 14 corrected - can only be
 * established by the live PostgreSQL suites.
 *
 * Keyed on the EXTERNAL agent id because that is the only identity both fakes
 * share; production keys on the internal uuid, and the composite foreign key
 * to `agents(workspace_id, id)` is what makes that safe there.
 */

export interface MemoryLedgerRow {
  workspaceId: string;
  agentExternalId: string;
  day: string;
  spendCommittedUsd: string;
  publishCountCommitted: number;
}

/** Mirrors `LockedDailyLedger`: the only handle through which a row mutates. */
export interface MemoryLockedLedger {
  readonly current: MemoryLedgerRow;
  commitSpend(amountUsd: string): void;
  commitPublish(count?: number): void;
}

export interface MemoryLedger {
  readonly rows: MemoryLedgerRow[];
  /** Reads without creating. An absent row is zero committed. */
  usageOf(workspaceId: string, agentExternalId: string, day: string): MemoryLedgerRow | undefined;
  /** Creates the row if needed and returns the mutation capability. */
  lockDay(workspaceId: string, agentExternalId: string, day: string): MemoryLockedLedger;
  /** Deep copy, for the fakes' transaction rollback. */
  snapshot(): MemoryLedgerRow[];
  restore(snapshot: MemoryLedgerRow[]): void;
}

/** Exact micro-dollar integers, matching the production arithmetic. */
export function toMicros(value: string): bigint {
  const [whole = '0', fraction = ''] = value.split('.');
  return BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(6, '0'));
}

export function fromMicros(micros: bigint): string {
  return `${(micros / 1_000_000n).toString()}.${(micros % 1_000_000n).toString().padStart(6, '0')}`;
}

/** `numeric(14,6)` capacity, matching `MAX_USD_MICROS`. */
const MAX_MICROS = 99_999_999_999_999n;

export function createMemoryLedger(): MemoryLedger {
  const rows: MemoryLedgerRow[] = [];

  const find = (
    workspaceId: string,
    agentExternalId: string,
    day: string,
  ): MemoryLedgerRow | undefined =>
    rows.find(
      (r) =>
        r.workspaceId === workspaceId && r.agentExternalId === agentExternalId && r.day === day,
    );

  return {
    rows,

    usageOf(workspaceId, agentExternalId, day) {
      return find(workspaceId, agentExternalId, day);
    },

    lockDay(workspaceId, agentExternalId, day) {
      let row = find(workspaceId, agentExternalId, day);
      if (row === undefined) {
        row = {
          workspaceId,
          agentExternalId,
          day,
          spendCommittedUsd: '0.000000',
          publishCountCommitted: 0,
        };
        rows.push(row);
      }
      const target = row;

      return {
        get current(): MemoryLedgerRow {
          return target;
        },
        commitSpend(amountUsd: string): void {
          const total = toMicros(target.spendCommittedUsd) + toMicros(amountUsd);
          if (total > MAX_MICROS) {
            // Matches `LedgerCapacityError`: refuse rather than wrap or clamp.
            throw new Error('Ledger capacity exceeded.');
          }
          target.spendCommittedUsd = fromMicros(total);
        },
        commitPublish(count = 1): void {
          target.publishCountCommitted += count;
        },
      };
    },

    snapshot() {
      return rows.map((r) => ({ ...r }));
    },

    restore(snapshot) {
      rows.length = 0;
      rows.push(...snapshot.map((r) => ({ ...r })));
    },
  };
}
