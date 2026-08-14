import type { IngestEvent } from '@hybrid/contracts';
import {
  createAgentRepository,
  createBlockRepository,
  createEventRepository,
  createIngestLockRepository,
  createPrecheckReceiptRepository,
  type AuthenticatedApiCredential,
  type DatabaseClient,
  type EventRow,
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
 *   BEGIN                              (one transaction for the whole batch)
 *     lock every event identity in the batch, in deterministic key order
 *     for each event:
 *       1. SELECT the event by (workspace_id, event_id)
 *          if present -> duplicates++, CONTINUE. No further work at all.
 *       2. discover/resolve the agent      - WITHOUT touching last_seen
 *       3. resolve + VALIDATE precheck_id  - incoherent => abort whole batch
 *       4. resolve/create runtime block    - idempotent on external id
 *       5. INSERT event ON CONFLICT DO NOTHING RETURNING
 *       6. accepted++, advance agent last_seen
 *   COMMIT
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
 * ─── WHAT THIS DELIBERATELY DOES NOT DO ───────────────────────────────────
 *
 * NO LEDGER DEBIT, ON EITHER PATH.
 *
 *   PRECHECKED spend   -> the precheck already debited. Debiting here would
 *                         double-count, and this is the whole point of Step 18.
 *   UNPRECHECKED spend -> still does NOT debit. That deficiency remains
 *                         intentionally open for the NEXT Credit step.
 *
 * When event-side accounting does arrive, it hangs off the SAME "this event is
 * new" branch below, which is what makes exactly-once accounting reachable: a
 * duplicate never gets far enough to debit anything. It must also remain gated
 * on the ABSENCE of a valid `precheck_id`.
 *
 * No precheck receipts are created or modified, no caps enforced, no
 * plane-owned blocks written, and no policy read or mutated - this module
 * imports no policy table and no ledger repository.
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

      return db.transaction(async (tx) => {
        const agentRepo = createAgentRepository(tx, scope);
        const eventRepo = createEventRepository(tx, scope);
        const blockRepo = createBlockRepository(tx, scope);
        const receiptRepo = createPrecheckReceiptRepository(tx, scope);
        const lockRepo = createIngestLockRepository(tx, scope);

        // Serialize on every identity in the batch UP FRONT, in deterministic
        // key order. Up front rather than per-event so the ordering is over the
        // whole batch: interleaving "lock E1, work, lock E2" with another batch
        // doing the reverse is exactly the deadlock this avoids.
        await lockRepo.lockEvents(events.map((event) => event.event_id));

        const unresolved: UnresolvedReference[] = [];
        let accepted = 0;
        let duplicates = 0;

        for (const [index, event] of events.entries()) {
          // 1. THE DUPLICATE DECISION, BEFORE ANY SIDE EFFECT.
          //
          //    Authoritative because the advisory lock for this identity is
          //    held: no concurrent transaction can be inserting it underneath
          //    us. A duplicate returns here having read one row and changed
          //    nothing - no agent discovered, no receipt consulted, no block
          //    created, no last-seen moved. The replacement payload is never
          //    even examined.
          if ((await eventRepo.findByEventId(event.event_id)) !== null) {
            duplicates += 1;
            continue;
          }

          // Everything below runs ONLY for a genuinely new event.

          // 2. Agent - discovered on first sight, no activity claimed yet.
          const agent = await agentRepo.discover(event.agent_id, now);

          // 3. Precheck linkage - SETTLEMENT (Step 18).
          //
          //    A reference that does not resolve in THIS workspace fails the
          //    batch rather than being quietly dropped: silently storing the
          //    event without the linkage the caller asked for would be a silent
          //    drop of meaning.
          //
          //    The lookup is workspace-scoped IN SQL, so another tenant's
          //    receipt is never returned and reads identically to one that does
          //    not exist. No JavaScript compares workspace ids afterwards.
          //
          //    Resolving is not enough. `precheck_id` says "this action was
          //    already authorized and already accounted for", and the plane
          //    acts on that by NOT debiting again. An unchecked claim would
          //    therefore be a way to make spend vanish - so the claim must be
          //    coherent with what the receipt actually records.
          let precheckReceiptId: string | undefined;
          if (event.precheck_id !== undefined) {
            const receipt = await receiptRepo.findById(event.precheck_id);
            if (receipt === null) {
              // A receipt in another workspace is reported identically to one
              // that does not exist.
              unresolved.push({
                index,
                field: 'precheck_id',
                message: 'Unknown precheck_id for this workspace.',
              });
              continue;
            }

            const linkage = checkPrecheckLinkage(event, receipt, agent.id);
            if (!linkage.ok) {
              unresolved.push({ index, field: 'precheck_id', message: linkage.message });
              continue;
            }
            precheckReceiptId = receipt.id;
          }

          // 4. Runtime block. The wire `block_id` is the client's opaque
          //    string; the column `events.block_id` is the internal UUID, so
          //    this resolves external -> internal and never casts the string.
          //
          //    Reached only for a new event. A DIFFERENT new event may still
          //    legitimately reference an existing external block and reuse that
          //    row - that is block dedup, not replay.
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

          // 5. The insert. `ON CONFLICT DO NOTHING` is retained as DATABASE
          //    defense in depth beneath the lock - correctness must not depend
          //    on advisory locking alone.
          const inserted = await eventRepo.insertIfNew({
            eventId: event.event_id,
            agentId: agent.id,
            type: event.type,
            category: categoryOf(event),
            // The ENTIRE validated event, verbatim, for AC-06 drill-through.
            // Validated data, not raw request bytes - so no credential or
            // header material can reach the audit record.
            payload: event,
            precheckReceiptId,
            blockId,
            occurredAt: event.occurred_at === undefined ? undefined : new Date(event.occurred_at),
            // SERVER time. `occurred_at` above is untrusted client metadata and
            // never becomes the authoritative ingest instant.
            receivedAt: now,
          });

          if (inserted === null) {
            // Unreachable while the lock holds and the transaction runs at READ
            // COMMITTED: step 1 already established absence. Reaching it means
            // the constraint caught something the lock did not, so the safe
            // reading is "already present" - count it, change nothing further.
            duplicates += 1;
            continue;
          }

          // 6. Once-only side effects, on the new-event path only. Future
          //    ledger and accounting effects belong exactly here.
          accepted += 1;
          await agentRepo.touchLastSeen(agent.id, now);
        }

        if (unresolved.length > 0) {
          // Rolls the transaction back: no partial batch is ever committed.
          throw new UnresolvedReferenceError(unresolved);
        }

        return { accepted, duplicates };
      });
    },
  };
}
