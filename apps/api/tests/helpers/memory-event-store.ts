import { randomUUID } from 'node:crypto';

import type { IngestEvent } from '@hybrid/contracts';
import type { AuthenticatedApiCredential } from '@hybrid/db';

import {
  UnresolvedReferenceError,
  type EventIngestStore,
  type IngestOutcome,
  type UnresolvedReference,
} from '../../src/events/store';

/**
 * In-memory `EventIngestStore` mirroring the production algorithm exactly.
 *
 * Reproduces the semantics that matter: idempotency keyed on
 * `(workspace_id, event_id)`, block dedup keyed on
 * `(workspace_id, external_block_id)`, agent discovery that does NOT advance
 * last-seen, and - critically - the DUPLICATE DECISION BEFORE ANY SIDE EFFECT.
 *
 * WHAT IT CANNOT PROVE
 * --------------------
 * It is single-threaded JavaScript, so its duplicate read is authoritative for
 * free. Production has to buy that with a `pg_advisory_xact_lock` keyed on
 * `(workspace_id, event_id)`, and nothing here exercises that lock. Whether two
 * concurrent requests really serialize - and whether overlapping batches
 * deadlock - can only be established by
 * `packages/db/tests/event-ingest.live.test.ts`, which is skipped without
 * `TEST_DATABASE_URL`.
 */

export interface StoredEvent {
  id: string;
  workspaceId: string;
  eventId: string;
  agentId: string;
  type: string;
  category: string | null;
  payload: unknown;
  precheckReceiptId: string | null;
  blockId: string | null;
  occurredAt: Date | null;
  receivedAt: Date;
}

export interface StoredAgent {
  id: string;
  workspaceId: string;
  externalId: string;
  lastSeenAt: Date | null;
}

export interface StoredBlock {
  id: string;
  workspaceId: string;
  externalBlockId: string;
  agentId: string;
  source: string;
  category: string;
  rule: string;
  reason: string;
  amountUsd: string | null;
  count: number | null;
}

export interface MemoryEventStore extends EventIngestStore {
  readonly events: StoredEvent[];
  readonly agents: StoredAgent[];
  readonly blocks: StoredBlock[];
  /** Pre-existing receipts, so precheck linkage can be exercised. */
  readonly receipts: { id: string; workspaceId: string }[];
  seedReceipt(workspaceId: string): string;
  /** Forces the persistence layer to fail, to exercise rollback. */
  failOnEventId: string | null;
}

export function createMemoryEventStore(): MemoryEventStore {
  const events: StoredEvent[] = [];
  const agents: StoredAgent[] = [];
  const blocks: StoredBlock[] = [];
  const receipts: { id: string; workspaceId: string }[] = [];
  const state = { failOnEventId: null as string | null };

  return {
    events,
    agents,
    blocks,
    receipts,

    seedReceipt(workspaceId: string): string {
      const id = randomUUID();
      receipts.push({ id, workspaceId });
      return id;
    },

    get failOnEventId(): string | null {
      return state.failOnEventId;
    },
    set failOnEventId(value: string | null) {
      state.failOnEventId = value;
    },

    ingest(
      credential: AuthenticatedApiCredential,
      batch: readonly IngestEvent[],
      now: Date,
    ): Promise<IngestOutcome> {
      const workspaceId = credential.scope.workspaceId;

      // Snapshot for rollback - the production path is one transaction.
      const eventSnapshot = [...events];
      const agentSnapshot = agents.map((a) => ({ ...a }));
      const blockSnapshot = [...blocks];

      const rollback = (): void => {
        events.length = 0;
        events.push(...eventSnapshot);
        agents.length = 0;
        agents.push(...agentSnapshot);
        blocks.length = 0;
        blocks.push(...blockSnapshot);
      };

      const unresolved: UnresolvedReference[] = [];
      let accepted = 0;
      let duplicates = 0;

      try {
        for (const [index, event] of batch.entries()) {
          // 1. THE DUPLICATE DECISION, BEFORE ANY SIDE EFFECT.
          //
          //    In production this read is made authoritative by an advisory
          //    lock on (workspace_id, event_id). Here the runtime is
          //    single-threaded, so the read is trivially authoritative - which
          //    is exactly why this fake CANNOT prove the concurrent case. That
          //    is `packages/db/tests/event-ingest.live.test.ts`.
          if (
            events.some((e) => e.workspaceId === workspaceId && e.eventId === event.event_id)
          ) {
            duplicates += 1;
            continue;
          }

          // 2. Agent discovery - never advances last_seen.
          let agent = agents.find(
            (a) => a.workspaceId === workspaceId && a.externalId === event.agent_id,
          );
          if (agent === undefined) {
            agent = { id: randomUUID(), workspaceId, externalId: event.agent_id, lastSeenAt: null };
            agents.push(agent);
          }

          // 3. Precheck linkage, scoped to this workspace.
          let precheckReceiptId: string | null = null;
          if (event.precheck_id !== undefined) {
            const found = receipts.find(
              (r) => r.id === event.precheck_id && r.workspaceId === workspaceId,
            );
            if (found === undefined) {
              unresolved.push({
                index,
                field: 'precheck_id',
                message: 'Unknown precheck_id for this workspace.',
              });
              continue;
            }
            precheckReceiptId = found.id;
          }

          // 4. Runtime block - idempotent on (workspace, external_block_id).
          let blockId: string | null = null;
          if (event.type === 'action.blocked' && event.block_id !== undefined) {
            let block = blocks.find(
              (b) => b.workspaceId === workspaceId && b.externalBlockId === event.block_id,
            );
            if (block === undefined) {
              block = {
                id: randomUUID(),
                workspaceId,
                externalBlockId: event.block_id,
                agentId: agent.id,
                source: 'runtime',
                category: event.category,
                rule: event.rule,
                reason: event.reason,
                amountUsd: event.amount_usd ?? null,
                count: event.count ?? null,
              };
              blocks.push(block);
            }
            blockId = block.id;
          }

          if (state.failOnEventId === event.event_id) {
            throw new Error('persistence failure');
          }

          // 5. The insert. Absence was already established in step 1.
          events.push({
            id: randomUUID(),
            workspaceId,
            eventId: event.event_id,
            agentId: agent.id,
            type: event.type,
            category:
              event.type === 'agent.action' || event.type === 'action.blocked'
                ? event.category
                : null,
            payload: event,
            precheckReceiptId,
            blockId,
            occurredAt: event.occurred_at === undefined ? null : new Date(event.occurred_at),
            receivedAt: now,
          });

          // 6. Once-only side effect, only for a genuinely new event.
          accepted += 1;
          agent.lastSeenAt = now;
        }

        if (unresolved.length > 0) {
          rollback();
          return Promise.reject(new UnresolvedReferenceError(unresolved));
        }

        return Promise.resolve({ accepted, duplicates });
      } catch (error: unknown) {
        rollback();
        return Promise.reject(error instanceof Error ? error : new Error('ingest failed'));
      }
    },
  };
}
