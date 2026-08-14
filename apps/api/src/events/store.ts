import type { IngestEvent } from '@hybrid/contracts';
import {
  createAgentRepository,
  createBlockRepository,
  createEventRepository,
  createIngestLockRepository,
  createLedgerRepository,
  createPrecheckReceiptRepository,
  toUtcAccountingDay,
  type AgentRow,
  type AuthenticatedApiCredential,
  type DatabaseClient,
  type EventRow,
  type LockedDailyLedger,
} from '@hybrid/db';

import { checkPrecheckLinkage } from './settlement.js';

/**
 * Event ingest persistence.
 *
 * ─── THE INVARIANT ────────────────────────────────────────────────────────
 *
 *   THE DUPLICATE DECISION HAPPENS BEFORE ANY EVENT-SPECIFIC SIDE EFFECT.
 *
 * The idempotency identity is `(workspace_id, event_id)` and nothing else.
 * Once an event exists under that identity, a later submission reusing the id
 * is a duplicate whatever its content claims, and must not be allowed to
 * reinterpret history.
 *
 * ─── THE ALGORITHM ────────────────────────────────────────────────────────
 *
 *   BEGIN                            (ONE transaction for the whole batch)
 *     1. lock every event identity, in deterministic key order
 *     2. for each event: SELECT by (workspace_id, event_id)
 *          present -> duplicates++, DROP IT. No further work at all.
 *     3. resolve agents for the SURVIVORS, sorted by external id
 *     4. resolve + VALIDATE every precheck_id  - incoherent => abort the batch
 *     5. lock ledger rows for unprechecked spend, sorted by (agent, day)
 *     6. for each survivor, in submission order:
 *          resolve/create runtime block   - idempotent on external id
 *          INSERT event ON CONFLICT DO NOTHING RETURNING
 *          debit the ledger IF unprechecked spend
 *          accepted++, advance agent last_seen
 *   COMMIT
 *
 * Staged rather than one pass per event because two families of lock are now
 * involved. Phases 2-4 take no locks a doomed batch would have to release, and
 * phases 1, 3 and 5 each acquire their whole family in a deterministic total
 * order before the next family is touched. See "lock order" below.
 *
 * ─── WHY THE LOCK ─────────────────────────────────────────────────────────
 *
 * Deciding "is this a duplicate?" before doing the work makes it a READ, and a
 * bare read is race-prone: two concurrent transactions can both observe
 * absence, both perform side effects, and only then discover one of them lost.
 * `pg_advisory_xact_lock`, keyed deterministically on
 * `(workspace_id, event_id)`, means whoever holds it is the only transaction
 * evaluating that identity - so the SELECT is authoritative and exactly one
 * caller reaches the side effects.
 *
 * The locks are acquired in a globally deterministic order so two batches
 * carrying the same ids in different sequences cannot deadlock. See
 * `lock-keys.ts`.
 *
 * `UNIQUE (workspace_id, event_id)` and `ON CONFLICT DO NOTHING` are RETAINED
 * underneath as database-enforced defense in depth. The lock is a coordination
 * mechanism; the constraint is the guarantee.
 *
 * ─── WHAT AN EARLIER VERSION GOT WRONG ────────────────────────────────────
 *
 * The original ordering resolved the agent, the receipt and the block BEFORE
 * the insert revealed the replay. Because `event_id` is client-supplied, that
 * made the replay path a way to create rows: submitting a known event id with
 * a fresh `block_id` created a block for an event that was never accepted, and
 * a fresh `agent_id` enrolled an agent the same way. An unknown `precheck_id`
 * on a replay could even fail a batch that was going to change nothing.
 *
 * ─── PRECHECK-LINKED SETTLEMENT (Step 18) ─────────────────────────────────
 *
 *   PRECHECK COMMITS THE AUTHORITATIVE USAGE.
 *   THE FOLLOW-UP EVENT RECORDS WHAT HAPPENED.
 *   THE EVENT NEVER COMMITS THAT USAGE AGAIN.
 *
 * An event carrying `precheck_id` claims the action was already authorized and
 * already accounted for. The plane acts on that claim by NOT debiting - so the
 * claim is verified before it is believed. See `settlement.ts` for the rules
 * and the reasoning behind each one.
 *
 * The verification adds NO WRITE. Nothing marks a receipt consumed, and no
 * mutable settlement state exists: the linkage lives on `events.precheck_id`,
 * which the insert already carried. Receipts stay immutable evidence.
 *
 * ─── AUTHORITATIVE EVENT ACCOUNTING (Step 19) ─────────────────────────────
 *
 * A `spend.recorded` event debits the authoritative UTC-day ledger IF AND ONLY
 * IF it carries no `precheck_id`:
 *
 *   PRECHECKED spend   -> the precheck already committed it. Debiting here
 *                         would double-count. Step 18 guarantee, unchanged.
 *   UNPRECHECKED spend -> the spend already happened and is being reported.
 *                         The event IS the accounting record, and it debits
 *                         exactly once.
 *
 * The classification is the PRESENCE of a validated receipt, never what that
 * receipt recorded. A `watch` precheck deliberately committed nothing, and its
 * follow-up event must not commit on its behalf.
 *
 * Exactly-once falls out of the structure rather than a flag: the debit hangs
 * off the "this event is new" branch, so a duplicate never reaches it. There is
 * no `settled` / `accounted` / `debited` column anywhere, and no need for one.
 *
 * ─── RECORDING IS NOT DECIDING ────────────────────────────────────────────
 *
 * NO POLICY IS READ ON THIS PATH. `POST /v1/actions/precheck` asks whether an
 * action MAY happen; this records that one DID. A paused agent's reported spend
 * is still recorded, and committed usage may legitimately exceed a configured
 * cap - $41 against a $25 cap is the truth, and clamping it would hide the
 * overspend an operator most needs to see.
 *
 * ─── LOCK ORDER ───────────────────────────────────────────────────────────
 *
 * This module takes two families, always in this sequence, each family fully
 * acquired in a deterministic total order before the next is touched:
 *
 *   1. event identity advisory locks   sorted by (lockKey, eventId)
 *   2. agents rows (upsert)            sorted by external id
 *   3. ledger_daily rows FOR UPDATE    sorted by (agentId, day)
 *
 * The precheck engine takes precheck-advisory -> policy -> ledger and never
 * touches (1) or (2); this module never touches policy or precheck-advisory.
 * The only shared family is the ledger, and no transaction here holds a ledger
 * row while waiting for anything the precheck engine holds - so no cycle can
 * form between the two. See docs/precheck.md for the global order.
 *
 * ─── WHAT THIS STILL DELIBERATELY DOES NOT DO ─────────────────────────────
 *
 * No precheck receipts are created or modified - an unprechecked spend gets NO
 * synthetic "allow" receipt, because no decision was made. No plane-owned
 * blocks: an over-cap report is not a denial. No caps enforced, and no policy
 * read or mutated - this module imports no policy table.
 */

/** Outcome of ingesting one batch. */
export interface IngestOutcome {
  readonly accepted: number;
  readonly duplicates: number;
}

/** A caller-supplied reference that does not resolve inside this workspace. */
export interface UnresolvedReference {
  /** Index of the offending event within the submitted batch. */
  readonly index: number;
  readonly field: 'precheck_id';
  readonly message: string;
}

export class UnresolvedReferenceError extends Error {
  public constructor(public readonly references: readonly UnresolvedReference[]) {
    super('Unresolved reference in event batch.');
    this.name = 'UnresolvedReferenceError';
  }
}

export interface EventIngestStore {
  /**
   * Persists a validated batch inside one transaction.
   *
   * @param credential - authenticated API credential. The ONLY tenant source.
   * @param now - server time, used for `received_at` and last-seen.
   * @throws {UnresolvedReferenceError} when a linkage cannot be resolved in
   *   this workspace; the transaction rolls back and nothing is stored.
   */
  ingest(
    credential: AuthenticatedApiCredential,
    events: readonly IngestEvent[],
    now: Date,
  ): Promise<IngestOutcome>;
}

/** Maps the wire event to the enum values the schema stores. */
function categoryOf(event: IngestEvent): EventRow['category'] {
  // `spend.recorded` and `heartbeat` carry no category, and the column is
  // nullable. Inventing one just to fill it would fabricate governance data.
  return event.type === 'agent.action' || event.type === 'action.blocked'
    ? event.category
    : null;
}

export function createDrizzleEventIngestStore(db: DatabaseClient): EventIngestStore {
  return {
    async ingest(
      credential: AuthenticatedApiCredential,
      events: readonly IngestEvent[],
      now: Date,
    ): Promise<IngestOutcome> {
      // Scope comes from the credential row. Nothing in the body contributed.
      const scope = credential.scope;

      // ONE server instant for the whole batch. `received_at` and the UTC
      // accounting day both derive from it, so an event received at 23:59:59.9
      // can never be audited on day N and accounted on day N+1.
      const accountingDay = toUtcAccountingDay(now);

      return db.transaction(async (tx) => {
        // EVERY repository is built on `tx`. A single one built on `db` would
        // silently run outside the transaction, and a ledger debit that
        // committed while its event rolled back is money without an audit row.
        const agentRepo = createAgentRepository(tx, scope);
        const eventRepo = createEventRepository(tx, scope);
        const blockRepo = createBlockRepository(tx, scope);
        const receiptRepo = createPrecheckReceiptRepository(tx, scope);
        const ledgerRepo = createLedgerRepository(tx, scope);
        const lockRepo = createIngestLockRepository(tx, scope);

        // ─── PHASE 1: EVENT IDENTITY LOCKS ────────────────────────────────
        //
        // Every identity in the batch, up front, in deterministic key order.
        // Up front rather than per-event so the ordering is over the WHOLE
        // batch: interleaving "lock E1, work, lock E2" with another batch
        // doing the reverse is exactly the deadlock this avoids.
        await lockRepo.lockEvents(events.map((event) => event.event_id));

        let accepted = 0;
        let duplicates = 0;

        // ─── PHASE 2: THE DUPLICATE DECISION, BEFORE ANY SIDE EFFECT ──────
        //
        // Authoritative because this batch holds the advisory lock for each
        // identity: no concurrent transaction can be inserting one underneath
        // us. A duplicate is counted here having read one row and changed
        // NOTHING - no agent discovered, no receipt consulted, no block
        // created, no ledger row locked, no debit, no last-seen moved. Its
        // replacement payload is never even examined.
        //
        // This matters more now than it did in Step 10: reaching accounting is
        // now a money effect, so the gate has to hold before anything else.
        const fresh: { index: number; event: IngestEvent }[] = [];
        for (const [index, event] of events.entries()) {
          if ((await eventRepo.findByEventId(event.event_id)) !== null) {
            duplicates += 1;
            continue;
          }
          fresh.push({ index, event });
        }

        // Everything below runs ONLY for genuinely new events.

        // ─── PHASE 3: AGENT RESOLUTION, IN DETERMINISTIC ORDER ────────────
        //
        // `discover` is an upsert, so it takes a ROW LOCK on the agent. Two
        // batches naming the same agents in opposite sequence could otherwise
        // deadlock on those rows, so resolution is sorted by external id and
        // deduplicated. Sorting also means the agent locks are all held before
        // any ledger lock is requested, which is what keeps the two families
        // acyclic.
        const agentByExternalId = new Map<string, AgentRow>();
        const externalIds = [...new Set(fresh.map(({ event }) => event.agent_id))].sort();
        for (const externalId of externalIds) {
          agentByExternalId.set(externalId, await agentRepo.discover(externalId, now));
        }

        /** The agent for an event. Present by construction after phase 3. */
        const agentFor = (event: IngestEvent): AgentRow => {
          const agent = agentByExternalId.get(event.agent_id);
          if (agent === undefined) {
            throw new Error('Agent was not resolved for a new event.');
          }
          return agent;
        };

        // ─── PHASE 4: SETTLEMENT VALIDATION (Step 18) ─────────────────────
        //
        // Read-only, but it can REJECT - so it runs before any lock is taken
        // that a doomed transaction would only have to release. A reference
        // that does not resolve in THIS workspace fails the batch rather than
        // being quietly dropped: silently storing the event without the
        // linkage the caller asked for would be a silent drop of meaning.
        //
        // The lookup is workspace-scoped IN SQL, so another tenant's receipt is
        // never returned and reads identically to one that does not exist.
        const unresolved: UnresolvedReference[] = [];
        /** Event index -> validated receipt id. Absence means unprechecked. */
        const linkedReceipt = new Map<number, string>();

        for (const { index, event } of fresh) {
          if (event.precheck_id === undefined) {
            continue;
          }
          const receipt = await receiptRepo.findById(event.precheck_id);
          if (receipt === null) {
            unresolved.push({
              index,
              field: 'precheck_id',
              message: 'Unknown precheck_id for this workspace.',
            });
            continue;
          }

          const linkage = checkPrecheckLinkage(event, receipt, agentFor(event).id);
          if (!linkage.ok) {
            unresolved.push({ index, field: 'precheck_id', message: linkage.message });
            continue;
          }
          linkedReceipt.set(index, receipt.id);
        }

        if (unresolved.length > 0) {
          // Rolls the transaction back: no partial batch is ever committed.
          throw new UnresolvedReferenceError(unresolved);
        }

        // ─── PHASE 5: LEDGER LOCKS, IN DETERMINISTIC ORDER ────────────────
        //
        //   THE ACCOUNTING CLASSIFICATION, IN ONE PLACE.
        //
        // A `spend.recorded` event debits the authoritative ledger if and only
        // if it carries NO `precheck_id`. With one, the precheck already
        // committed the usage and debiting here would double-count - that is
        // the Step 18 guarantee, and it is decided by the PRESENCE of a
        // validated receipt, never by what mode that receipt recorded. A
        // `watch` precheck deliberately committed nothing, and its follow-up
        // event must not retroactively commit on its behalf.
        //
        // Locks are acquired here, before any mutation, sorted by
        // `(agentId, day)`. Two batches carrying the same agents in opposite
        // sequence therefore request the rows in the same sequence and cannot
        // form a cycle. The day is constant across a batch - one server instant
        // - but it is part of the sort key so this stays correct if that ever
        // changes.
        const debits = fresh.filter(
          ({ index, event }) => event.type === 'spend.recorded' && !linkedReceipt.has(index),
        );

        const ledgerKeys = [
          ...new Map(
            debits.map(({ event }) => {
              const agentId = agentFor(event).id;
              return [`${agentId}\u0000${accountingDay}`, agentId] as const;
            }),
          ),
        ].sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));

        /** One locked capability per agent-day, REUSED across the batch. */
        const ledgerByAgent = new Map<string, LockedDailyLedger>();
        for (const [, agentId] of ledgerKeys) {
          // The capability tracks committed state across mutations, so several
          // spends for one agent in one batch reuse it without an unlocked
          // re-read and without taking the row lock twice.
          const locked = await ledgerRepo.lockDailyLedger(agentId, accountingDay);
          if (locked === null) {
            // Unreachable: the agent was resolved inside this very scope in
            // phase 3, so it belongs to this workspace by construction.
            throw new Error('Ledger unavailable for an agent in this workspace.');
          }
          ledgerByAgent.set(agentId, locked);
        }

        // ─── PHASE 6: EFFECTS, IN SUBMISSION ORDER ────────────────────────
        for (const { index, event } of fresh) {
          const agent = agentFor(event);

          // Runtime block. The wire `block_id` is the client's opaque string;
          // the column `events.block_id` is the internal UUID, so this resolves
          // external -> internal and never casts the string.
          //
          // A DIFFERENT new event may legitimately reference an existing
          // external block and reuse that row - that is block dedup, not
          // replay.
          let blockId: string | undefined;
          if (event.type === 'action.blocked' && event.block_id !== undefined) {
            const block = await blockRepo.resolveOrCreateRuntimeBlock({
              externalBlockId: event.block_id,
              agentId: agent.id,
              category: event.category,
              rule: event.rule,
              reason: event.reason,
              amountUsd: event.amount_usd,
              count: event.count,
            });
            blockId = block.id;
          }

          // The insert. `ON CONFLICT DO NOTHING` is retained as DATABASE
          // defense in depth beneath the lock - correctness must not depend on
          // advisory locking alone.
          //
          // IT COMES BEFORE THE DEBIT deliberately: if the constraint reveals a
          // duplicate the lock somehow missed, no money has moved yet.
          const inserted = await eventRepo.insertIfNew({
            eventId: event.event_id,
            agentId: agent.id,
            type: event.type,
            category: categoryOf(event),
            // The ENTIRE validated event, verbatim, for AC-06 drill-through.
            // Validated data, not raw request bytes - so no credential or
            // header material can reach the audit record.
            payload: event,
            precheckReceiptId: linkedReceipt.get(index),
            blockId,
            occurredAt: event.occurred_at === undefined ? undefined : new Date(event.occurred_at),
            // SERVER time. `occurred_at` above is untrusted client metadata and
            // never becomes the authoritative ingest instant, and never selects
            // the accounting day.
            receivedAt: now,
          });

          if (inserted === null) {
            // Unreachable while the lock holds and the transaction runs at READ
            // COMMITTED: phase 2 already established absence. Reaching it means
            // the constraint caught something the lock did not, so the safe
            // reading is "already present" - count it, and debit nothing.
            duplicates += 1;
            continue;
          }

          // ─── AUTHORITATIVE ACCOUNTING (Step 19) ─────────────────────────
          //
          // Reached only for a NEW, accepted, UNPRECHECKED spend event, on the
          // same transaction as the row that explains it.
          //
          // NO POLICY IS CONSULTED. This records spend that ALREADY HAPPENED;
          // it does not ask whether it should have been allowed. A paused agent
          // or an over-cap total still records truthfully - suppressing it
          // would make the ledger a statement about policy rather than about
          // money, and would hide exactly the overspend an operator needs to
          // see.
          if (event.type === 'spend.recorded' && !linkedReceipt.has(index)) {
            const ledger = ledgerByAgent.get(agent.id);
            if (ledger === undefined) {
              // Unreachable: phase 5 locked every agent in `debits`.
              throw new Error('Ledger capability missing for an unprechecked spend.');
            }
            // The LOCKED capability is the only way to mutate the row. Exact
            // micro-dollar arithmetic; capacity is checked before the write.
            await ledger.commitSpend(event.amount_usd);
          }

          accepted += 1;
          await agentRepo.touchLastSeen(agent.id, now);
        }

        return { accepted, duplicates };
      });
    },
  };
}
