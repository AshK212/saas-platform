import { sql } from 'drizzle-orm';
import {
  check,
  foreignKey,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';

import { agents } from './agents.js';
import { blocks } from './blocks.js';
import { actionCategory, eventType } from './enums.js';
import { precheckReceipts } from './receipts.js';
import { workspaces } from './workspaces.js';

/**
 * The audit event stream - the future target of `POST /v1/events`.
 *
 * IDEMPOTENCY BOUNDARY
 * --------------------
 * `UNIQUE (workspace_id, event_id)` is the constraint AC-13 (event replay
 * idempotency) rests on. `event_id` is client-supplied and is only unique
 * within a workspace, never globally - one tenant's id space must not collide
 * with another's. Later ingest will rely on this constraint rather than on a
 * read-then-write check, which would race.
 *
 * FORWARD COMPATIBILITY
 * ---------------------
 * `payload` is open `jsonb` with no shape constraint, so a future event can
 * carry fields this schema has never seen. Only the `type` and `category`
 * vocabularies are closed, because the control plane routes on them.
 *
 * `category` is nullable: it applies to `agent.action` events and is not
 * meaningful for a `heartbeat`.
 *
 * TWO TIMESTAMPS, DELIBERATELY
 * ----------------------------
 *   - `occurred_at`  - when the client says it happened. Nullable and
 *                      untrusted; a client clock may be wrong or absent.
 *   - `received_at`  - when the plane accepted it. Always present, server-set,
 *                      and the authoritative axis for ordering and timelines.
 *
 * Trusting a client timestamp for authoritative ordering would let a caller
 * rewrite its own history.
 *
 * No ingest, idempotency, timeline or ledger-effect behaviour is implemented
 * here. Recording a `spend.recorded` event does NOT debit the ledger; that is
 * a later, separate, transactional step.
 */
export const events = pgTable(
  'events',
  {
    /** Internal surrogate key. Distinct from the client-supplied `event_id`. */
    id: uuid('id').primaryKey().defaultRandom(),

    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'restrict' }),

    /** Client-supplied identifier. Unique within the workspace. */
    eventId: text('event_id').notNull(),

    agentId: uuid('agent_id').notNull(),

    type: eventType('type').notNull(),
    category: actionCategory('category'),

    /** Raw client payload, stored verbatim. Intentionally unconstrained. */
    payload: jsonb('payload').notNull(),

    /** Optional linkage to the decision and denial this event refers to. */
    precheckReceiptId: uuid('precheck_receipt_id'),
    blockId: uuid('block_id'),

    /** Client-reported time. Untrusted, nullable. */
    occurredAt: timestamp('occurred_at', { withTimezone: true }),

    /** Server-assigned receipt time. Authoritative ordering axis. */
    receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // AC-13 idempotency boundary.
    unique('events_workspace_event_id_key').on(table.workspaceId, table.eventId),

    foreignKey({
      name: 'events_workspace_agent_fkey',
      columns: [table.workspaceId, table.agentId],
      foreignColumns: [agents.workspaceId, agents.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'events_workspace_precheck_receipt_fkey',
      columns: [table.workspaceId, table.precheckReceiptId],
      foreignColumns: [precheckReceipts.workspaceId, precheckReceipts.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'events_workspace_block_fkey',
      columns: [table.workspaceId, table.blockId],
      foreignColumns: [blocks.workspaceId, blocks.id],
    }).onDelete('restrict'),

    check('events_event_id_nonempty_check', sql`length(${table.eventId}) > 0`),

    // AC-05 timeline: workspace stream, newest first.
    index('events_workspace_received_idx').on(table.workspaceId, table.receivedAt),
    // AC-05 agent filter: per-agent stream, newest first.
    index('events_workspace_agent_received_idx').on(
      table.workspaceId,
      table.agentId,
      table.receivedAt,
    ),
  ],
);
