import type {
  AgentSummary,
  BlockSummary,
  DenialRule,
  EventDetail,
  EventSummary,
  PrecheckDenyReason,
  ReceiptSummary,
} from '@hybrid/contracts';
import type {
  AgentRow,
  AuditBlockRow,
  AuditReceiptRow,
  EventDetailRow,
  TimelineEventRow,
} from '@hybrid/db';

/**
 * Row -> wire mappers, shared by every read surface.
 *
 * ─── WHY THESE LIVE HERE AND NOT IN THE ROUTES ────────────────────────────
 *
 * Three authorities can now read a workspace: an operator session, and - from
 * AC-18 - a read-only share token. (A machine API key reads nothing; it only
 * writes.) They differ entirely in WHO may read and not at all in WHAT the
 * data looks like.
 *
 * Left in the route files, each mapper would have been copied into the share
 * routes, and the two copies would drift. The drift would be quiet and it
 * would matter: a shared view slowly describing a different system than the
 * operator sees is worse than no shared view, because both look authoritative.
 *
 * So the presentation of a row is decided ONCE, here, and every surface uses
 * it. Authority stays in the routes, where it differs.
 *
 * ─── WHAT IS DELIBERATELY ABSENT ──────────────────────────────────────────
 *
 * Nothing here reads a database, and nothing takes a workspace id or a scope.
 * These are pure functions over rows that a scoped repository already
 * returned - by the time a row reaches this module, tenancy is settled.
 */

/** An agent, as every surface presents it. */
export function toAgentSummary(agent: AgentRow): AgentSummary {
  return {
    id: agent.id,
    // Transport calls the client-supplied identifier `agentId`; the column is
    // `external_id`. Same value, different name.
    agentId: agent.externalId,
    name: agent.displayName,
    lastSeenAt: agent.lastSeenAt?.toISOString() ?? null,
    createdAt: agent.createdAt.toISOString(),
  };
}

/** One timeline row. */
export function toEventSummary(row: TimelineEventRow): EventSummary {
  return {
    id: row.id,
    eventId: row.eventId,
    agent: {
      id: row.agent.id,
      agentId: row.agent.externalId,
      name: row.agent.displayName,
    },
    type: row.type,
    category: row.category,
    // Client-reported and untrusted; surfaced as metadata, never as authority.
    occurredAt: row.occurredAt?.toISOString() ?? null,
    receivedAt: row.receivedAt.toISOString(),
    precheckId: row.precheckReceiptId,
    block:
      row.block === null
        ? null
        : {
            id: row.block.id,
            externalBlockId: row.block.externalBlockId,
            source: row.block.source,
          },
  };
}

/** One event with its stored payload (AC-06). */
export function toEventDetail(row: EventDetailRow): EventDetail {
  return {
    ...toEventSummary(row),
    // The VALIDATED event object as stored - not raw request bytes and not
    // headers. No credential material ever reached it.
    raw: row.payload,
  };
}

/** One precheck decision, as the audit lists it. */
export function toReceiptSummary(row: AuditReceiptRow): ReceiptSummary {
  return {
    id: row.id,
    actionId: row.actionId,
    agent: { id: row.agent.id, agentId: row.agent.externalId, name: row.agent.displayName },
    category: row.category,
    decision: row.decision,
    // Persisted machine-readable reason; null on an allow.
    reason: row.denyReason === null ? null : (row.denyReason as PrecheckDenyReason),
    block: row.block === null ? null : { id: row.block.id, rule: row.block.rule as DenialRule },
    accountingDay: row.accountingDay ?? '',
    createdAt: row.createdAt.toISOString(),
  };
}

/** One block, runtime- or plane-owned. */
export function toBlockSummary(row: AuditBlockRow): BlockSummary {
  return {
    id: row.id,
    // PERSISTED ownership. Never inferred.
    source: row.source,
    agent: { id: row.agent.id, agentId: row.agent.externalId, name: row.agent.displayName },
    category: row.category,
    rule: row.rule,
    reason: row.reason,
    externalBlockId: row.externalBlockId,
    // Null for a runtime block: a plugin reporting its own refusal has no
    // plane receipt, and inventing one would fabricate evidence.
    precheckId: row.precheckReceiptId,
    createdAt: row.createdAt.toISOString(),
  };
}
