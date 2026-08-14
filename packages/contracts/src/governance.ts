import { z } from 'zod';

import { denialRuleSchema } from './denial.js';
import { actionCategorySchema, decimalUsdSchema } from './events.js';
import { agentModeSchema, policyVersionSchema } from './policy.js';
import { precheckDecisionSchema, precheckDenyReasonSchema } from './precheck.js';

/**
 * Step 17 operator governance visibility.
 *
 * OPERATOR SURFACE, camelCase - these are read by our own browser app, like
 * the workspace, API-key, agent and timeline contracts.
 *
 * READ-ONLY, ENTIRELY. Nothing here describes a write. Receipts and blocks are
 * historical evidence: there is no update shape, no delete shape, and no
 * "recompute under current policy" field. A view that could alter what the
 * plane recorded would destroy the thing it exists to show.
 */

/** `/v1/workspaces/:workspaceId/receipts` */
export function workspaceReceiptsPath(workspaceId: string): string {
  return `/v1/workspaces/${encodeURIComponent(workspaceId)}/receipts`;
}

/** `/v1/workspaces/:workspaceId/receipts/:receiptId` */
export function workspaceReceiptPath(workspaceId: string, receiptId: string): string {
  return `${workspaceReceiptsPath(workspaceId)}/${encodeURIComponent(receiptId)}`;
}

/** `/v1/workspaces/:workspaceId/blocks` */
export function workspaceBlocksPath(workspaceId: string): string {
  return `/v1/workspaces/${encodeURIComponent(workspaceId)}/blocks`;
}

/** `/v1/workspaces/:workspaceId/blocks/:blockId` */
export function workspaceBlockPath(workspaceId: string, blockId: string): string {
  return `${workspaceBlocksPath(workspaceId)}/${encodeURIComponent(blockId)}`;
}

/**
 * Page sizing, matching the timeline convention.
 *
 * An audit stream grows without bound, so there is no unpaginated list. The
 * maximum is low enough that one call cannot become a bulk export - AC-16 is
 * deferred and raising this would quietly implement it.
 */
export const GOVERNANCE_DEFAULT_LIMIT = 50;
export const GOVERNANCE_MAX_LIMIT = 100;

/** Bounds the opaque cursor before it is decoded. */
export const MAX_GOVERNANCE_CURSOR_LENGTH = 512;

const limitParamSchema = z
  .string()
  .regex(/^[0-9]{1,4}$/, 'Limit must be a whole number.')
  .transform((raw) => Number.parseInt(raw, 10))
  .refine(
    (value) => value >= 1 && value <= GOVERNANCE_MAX_LIMIT,
    `Limit must be between 1 and ${String(GOVERNANCE_MAX_LIMIT)}.`,
  )
  .optional();

const cursorParamSchema = z
  .string()
  .min(1)
  .max(MAX_GOVERNANCE_CURSOR_LENGTH)
  .regex(/^[A-Za-z0-9_-]+$/, 'Malformed cursor.')
  .optional();

/**
 * Receipt list query.
 *
 * STRICT: an unknown parameter is a 400 rather than being ignored, so a
 * misspelled filter cannot silently return the unfiltered audit stream and be
 * mistaken for a complete answer.
 */
export const receiptListQuerySchema = z.strictObject({
  /** EXTERNAL agent id, resolved inside the authorized workspace. */
  agent_id: z.string().trim().min(1).max(120).optional(),
  /** A small bounded filter, not a query language. */
  decision: precheckDecisionSchema.optional(),
  limit: limitParamSchema,
  cursor: cursorParamSchema,
});

export type ReceiptListQuery = z.infer<typeof receiptListQuerySchema>;

/** Block list query. Same shape, filtered by ownership rather than decision. */
export const blockListQuerySchema = z.strictObject({
  agent_id: z.string().trim().min(1).max(120).optional(),
  /** Who refused: the control plane, or a runtime reporting its own denial. */
  source: z.enum(['plane', 'runtime']).optional(),
  limit: limitParamSchema,
  cursor: cursorParamSchema,
});

export type BlockListQuery = z.infer<typeof blockListQuerySchema>;

/** The agent a governance artifact belongs to, denormalised for display. */
export const governanceAgentRefSchema = z.object({
  id: z.uuid(),
  /** The stable client-supplied identifier (`agents.external_id`). */
  agentId: z.string(),
  name: z.string().nullable(),
});

export type GovernanceAgentRef = z.infer<typeof governanceAgentRefSchema>;

/**
 * One agent's live governance state, for the fleet view.
 *
 * `mode` and the caps are EFFECTIVE policy - the explicit row if one exists,
 * otherwise the Step 12 defaults. The frontend must not re-derive that.
 *
 * Usage is today's authoritative committed total from `ledger_daily`, read for
 * the SERVER's UTC accounting day. It is never aggregated from events: events
 * do not debit the ledger, and summing them would show a number the plane does
 * not enforce against.
 */
export const agentGovernanceSchema = z.object({
  mode: agentModeSchema,
  /** Decimal string, or null for UNCAPPED. Never a number. */
  dailySpendCapUsd: decimalUsdSchema.nullable(),
  dailyPublishCap: z.number().int().min(0).nullable(),
  /** Today's committed spend. Always present; zero when nothing is committed. */
  spendCommittedUsd: decimalUsdSchema,
  publishCountCommitted: z.number().int().min(0),
  /** The SERVER's UTC accounting day this usage belongs to. */
  accountingDay: z.string(),
});

export type AgentGovernance = z.infer<typeof agentGovernanceSchema>;

/** Plane block linkage carried on a receipt, when one exists. */
export const receiptBlockRefSchema = z.object({
  id: z.uuid(),
  rule: denialRuleSchema,
});

export type ReceiptBlockRef = z.infer<typeof receiptBlockRefSchema>;

/**
 * A receipt row in the audit list.
 *
 * Enough to scan a list of decisions without a second request, and no more.
 * Full evidence lives on the detail view.
 */
export const receiptSummarySchema = z.object({
  /** The plane-generated id, returned to the runtime as `precheck_id`. */
  id: z.uuid(),
  /** The runtime's own action identity. */
  actionId: z.string(),
  agent: governanceAgentRefSchema,
  category: actionCategorySchema,
  decision: precheckDecisionSchema,
  /** Present only on a denial. */
  reason: precheckDenyReasonSchema.nullable(),
  /** Set when this denial produced a plane-owned block. */
  block: receiptBlockRefSchema.nullable(),
  accountingDay: z.string(),
  createdAt: z.string(),
});

export type ReceiptSummary = z.infer<typeof receiptSummarySchema>;

/**
 * Full immutable decision evidence.
 *
 * Every field is what was PERSISTED at decision time. Nothing here is
 * recomputed against current policy: a cap changed this morning must not
 * rewrite yesterday's explanation.
 */
export const receiptDetailSchema = receiptSummarySchema.extend({
  /** The exact workspace policy version the decision evaluated against. */
  policyVersion: policyVersionSchema,
  /** The mode that applied AT DECISION TIME, not the agent's mode now. */
  appliedMode: agentModeSchema,
  appliedSpendCapUsd: decimalUsdSchema.nullable(),
  appliedPublishCap: z.number().int().min(0).nullable(),
  /** What was asked for. Exactly one of these is set, or neither. */
  requestedAmountUsd: decimalUsdSchema.nullable(),
  requestedPublishCount: z.number().int().min(0).nullable(),
  /** Committed usage as READ during the decision. Null when no ledger applied. */
  ledgerSpendBeforeUsd: decimalUsdSchema.nullable(),
  ledgerPublishBefore: z.number().int().min(0).nullable(),
  /** Headroom reported to the caller at the time. */
  remainingSpendUsd: decimalUsdSchema.nullable(),
  remainingPublishCount: z.number().int().min(0).nullable(),
});

export type ReceiptDetail = z.infer<typeof receiptDetailSchema>;

export const receiptListResponseSchema = z.object({
  receipts: z.array(receiptSummarySchema),
  /** Null on the last page. Opaque; pass back unmodified. */
  nextCursor: z.string().nullable(),
});

export type ReceiptListResponse = z.infer<typeof receiptListResponseSchema>;

export const receiptDetailResponseSchema = z.object({ receipt: receiptDetailSchema });
export type ReceiptDetailResponse = z.infer<typeof receiptDetailResponseSchema>;

/**
 * A block, runtime- or plane-owned.
 *
 * `source` is PERSISTED state, never inferred in the browser. A runtime block
 * is a plugin reporting its own refusal; a plane block is the control plane's
 * decision, and only the latter carries a receipt.
 */
export const blockSummarySchema = z.object({
  id: z.uuid(),
  source: z.enum(['plane', 'runtime']),
  agent: governanceAgentRefSchema,
  category: actionCategorySchema,
  /** Machine-readable control identifier. Free text for runtime blocks. */
  rule: z.string(),
  /** Human-readable explanation. */
  reason: z.string(),
  /** The client's own block identity. Always null for a plane block. */
  externalBlockId: z.string().nullable(),
  /** The denial receipt this block explains. Null for runtime blocks. */
  precheckId: z.uuid().nullable(),
  createdAt: z.string(),
});

export type BlockSummary = z.infer<typeof blockSummarySchema>;

/** Block detail adds the refused quantity, where one was recorded. */
export const blockDetailSchema = blockSummarySchema.extend({
  amountUsd: decimalUsdSchema.nullable(),
  count: z.number().int().min(0).nullable(),
});

export type BlockDetail = z.infer<typeof blockDetailSchema>;

export const blockListResponseSchema = z.object({
  blocks: z.array(blockSummarySchema),
  nextCursor: z.string().nullable(),
});

export type BlockListResponse = z.infer<typeof blockListResponseSchema>;

export const blockDetailResponseSchema = z.object({ block: blockDetailSchema });
export type BlockDetailResponse = z.infer<typeof blockDetailResponseSchema>;
