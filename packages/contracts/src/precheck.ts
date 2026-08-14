import { actionCategorySchema, decimalUsdSchema } from './events.js';

import { z } from 'zod';

/**
 * Step 15 precheck contracts - the governance decision surface.
 *
 * MACHINE SURFACE, snake_case. This is called by runtimes on every governed
 * action, so it follows the same external convention as event ingest and
 * policy polling.
 *
 * THE REQUEST CARRIES NO AUTHORITY. There is no `workspace_id`, no
 * `tenant_id`, no policy field, no cap, no version and no `precheck_id` - the
 * plane generates the receipt id. A caller states what it wants to do; the
 * plane decides.
 */

/** The locked precheck endpoint. Bearer API key only. */
export const PRECHECK_PATH = '/v1/actions/precheck' as const;

/**
 * Bounded like `event_id`: a runtime-supplied opaque identifier, not a UUID -
 * agent ecosystems use ULIDs, KSUIDs and prefixed ids.
 */
const actionIdSchema = z.string().trim().min(1, 'An action id is required.').max(200);

/**
 * A precheck request.
 *
 * STRICT, and category-aware:
 *
 *   - `spend` REQUIRES `amount_usd`. An unquantified spend cannot be compared
 *     to a cap, and defaulting it to zero would silently let every spend
 *     through.
 *   - every other category REJECTS `amount_usd`. Only `spend` is accounted
 *     against the money cap, so an amount elsewhere would be silently ignored
 *     - and a caller who sent one would reasonably believe it counted.
 *
 * There is deliberately no publish COUNT field: one precheck is one intended
 * publish. Batching is not in the locked requirements, and accepting a count
 * would let a caller consume its cap in a single unreviewable request.
 */
export const precheckRequestSchema = z
  .strictObject({
    /**
     * The runtime's identifier for this action. The IDEMPOTENCY KEY: replaying
     * it returns the original decision rather than deciding again.
     *
     * Distinct from `precheck_id` (the plane's receipt id), `event_id` and
     * `block_id`.
     */
    action_id: actionIdSchema,
    /** Stable external agent identifier (`agents.external_id`). */
    agent_id: z.string().trim().min(1, 'An agent id is required.').max(120),
    category: actionCategorySchema,
    /** Decimal string. Required for `spend`, forbidden otherwise. */
    amount_usd: decimalUsdSchema.optional(),
  })
  .superRefine((value, ctx) => {
    if (value.category === 'spend' && value.amount_usd === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['amount_usd'],
        message: 'A spend precheck must state amount_usd.',
      });
    }
    if (value.category !== 'spend' && value.amount_usd !== undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['amount_usd'],
        message: 'amount_usd applies only to the spend category.',
      });
    }
  });

export type PrecheckRequest = z.infer<typeof precheckRequestSchema>;

export const precheckDecisionSchema = z.enum(['allow', 'deny']);
export type PrecheckDecision = z.infer<typeof precheckDecisionSchema>;

/**
 * Stable machine-readable denial reasons.
 *
 * An enum rather than prose so a runtime can branch on it - retry later on a
 * cap, stop entirely on a pause. Human-facing detail can be added alongside
 * later without breaking a client that switched on this.
 */
export const precheckDenyReasonSchema = z.enum([
  'daily_spend_cap_exceeded',
  'daily_publish_cap_exceeded',
  'paused',
]);

export type PrecheckDenyReason = z.infer<typeof precheckDenyReasonSchema>;

/**
 * Remaining headroom, as a TYPED object.
 *
 * A bare scalar would be ambiguous in the worst possible way: `"5"` could mean
 * five dollars or five publishes, and a runtime that guessed wrong would
 * mis-budget silently. The `kind` discriminant makes the unit explicit.
 *
 * Null when no limit applies - an uncapped policy, or a category the caps do
 * not govern.
 */
export const precheckRemainingSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('usd'), value: decimalUsdSchema }),
  z.strictObject({ kind: z.literal('publish'), value: z.number().int().min(0) }),
]);

export type PrecheckRemaining = z.infer<typeof precheckRemainingSchema>;

/**
 * The decision.
 *
 * `precheck_id` is the plane-generated receipt UUID. Every decision produces a
 * durable receipt, so this id always names one - a caller can cite it, and a
 * later `agent.action` event can reference it.
 */
export const precheckResponseSchema = z.strictObject({
  precheck_id: z.uuid(),
  decision: precheckDecisionSchema,
  /** Null when no cap governs this category, or the cap is uncapped. */
  remaining: precheckRemainingSchema.nullable(),
  /** Present only on a denial. */
  reason: precheckDenyReasonSchema.optional(),
});

export type PrecheckResponse = z.infer<typeof precheckResponseSchema>;

/** Safe error body. Carries no schema internals and no tenant hints. */
export const precheckErrorSchema = z.strictObject({
  error: z.enum(['invalid_request', 'unauthorized', 'precheck_unavailable']),
});

export type PrecheckError = z.infer<typeof precheckErrorSchema>;
