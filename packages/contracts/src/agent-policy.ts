import { z } from 'zod';

import { decimalUsdSchema } from './events.js';
import { agentModeSchema, effectiveAgentPolicySchema, policyVersionSchema } from './policy.js';

/**
 * Step 13 operator policy mutation contracts.
 *
 * WHY snake_case HERE, AGAINST THE OPERATOR CONVENTION
 * ----------------------------------------------------
 * The operator surface is otherwise camelCase. This one is deliberately not.
 * `mode`, `daily_spend_cap_usd` and `daily_publish_cap` are the exact fields an
 * agent reads back from `GET /v1/policy`, and having an operator SET
 * `dailySpendCapUsd` while a runtime READS `daily_spend_cap_usd` would mean two
 * spellings of one governance value. The response even reuses
 * `effectiveAgentPolicySchema` verbatim, so the write and the read cannot drift.
 *
 * PUT, NOT PATCH
 * --------------
 * The request is a COMPLETE policy. A partial update would need conflict rules
 * ("omitted means unchanged" vs "omitted means null") for exactly three fields,
 * and "clear the spend cap" would become indistinguishable from "leave it
 * alone". For an object this small, sending all of it is unambiguous.
 */

/** `/v1/workspaces/:workspaceId/agents/:agentId/policy` */
export function agentPolicyPath(workspaceId: string, agentId: string): string {
  return `/v1/workspaces/${encodeURIComponent(workspaceId)}/agents/${encodeURIComponent(agentId)}/policy`;
}

/**
 * A complete desired policy.
 *
 * STRICT, and all three fields required. There is deliberately NO:
 *
 *   - `workspace_id` / `tenant_id` - tenancy comes from the proven membership;
 *   - `version` - the version is server-authoritative. Accepting one would let
 *     a caller assert governance history, and it is not an optimistic-lock
 *     token: the requirements do not ask for one;
 *   - `agent_id` - the agent is the path, not the body, so the two can never
 *     disagree;
 *   - credentials of any kind.
 *
 * Unknown fields are rejected rather than ignored, so a typo like
 * `daily_spend_cap` is a loud 400 instead of a silently uncapped agent.
 */
export const agentPolicyMutationRequestSchema = z.strictObject({
  mode: agentModeSchema,
  /**
   * Decimal string, or null for UNCAPPED.
   *
   * Never a JSON number: IEEE-754 would make `25.00` arrive as
   * `25.000000000000004` in some clients, and this value decides whether a cap
   * is exceeded. Same rule as the event money contract, same schema.
   */
  daily_spend_cap_usd: decimalUsdSchema.nullable(),
  /** Non-negative integer, or null for UNCAPPED. */
  daily_publish_cap: z.number().int().min(0).max(2_147_483_647).nullable(),
});

export type AgentPolicyMutationRequest = z.infer<typeof agentPolicyMutationRequestSchema>;

/**
 * The committed policy and the version it committed at.
 *
 * The two always describe the SAME transaction: the mutation and the version
 * increment share one transaction, so a caller can never see a changed policy
 * reported at a stale version.
 *
 * Exposes no internal policy-row id, no internal agent UUID, no workspace id
 * and no other agent's policy.
 */
export const agentPolicyResponseSchema = z.strictObject({
  policy: effectiveAgentPolicySchema,
  version: policyVersionSchema,
});

export type AgentPolicyResponse = z.infer<typeof agentPolicyResponseSchema>;

/** Safe error body. Carries no schema internals and no tenant hints. */
export const agentPolicyErrorSchema = z.strictObject({
  error: z.enum(['invalid_policy', 'not_found', 'insufficient_role', 'policy_unavailable']),
});

export type AgentPolicyError = z.infer<typeof agentPolicyErrorSchema>;

/** Maximum integer digits `numeric(14, 6)` can hold: 14 - 6. */
const MAX_INTEGER_DIGITS = 8;
/** Scale of the `numeric(14, 6)` money columns. */
const MONEY_SCALE = 6;

/**
 * Normalises operator-typed money into the canonical exact decimal string.
 *
 * `25`, `25.0`, `25.00` and `25.000000` all mean the same cap, and an operator
 * should not have to type six decimal places. This pads to scale using STRING
 * MANIPULATION ONLY - no `parseFloat`, no `toFixed`, no arithmetic - so the
 * value that reaches `numeric(14,6)` is exactly what was typed.
 *
 * Returns `null` for empty input, meaning UNCAPPED, and `undefined` when the
 * input is not a valid cap. `undefined` rather than a thrown error because the
 * caller is a keystroke handler, and a 0 or a silent round would both be worse
 * than refusing to submit.
 *
 * @returns canonical string, `null` for uncapped, or `undefined` if invalid.
 */
export function normalizeSpendCapInput(raw: string): string | null | undefined {
  const trimmed = raw.trim();
  if (trimmed === '') {
    return null;
  }

  // No sign, no exponent, no thousands separators, no leading `.`.
  const match = /^([0-9]{1,8})(?:\.([0-9]{1,6}))?$/.exec(trimmed);
  if (match === null) {
    return undefined;
  }

  const whole = match[1] ?? '';
  const fraction = match[2] ?? '';

  // `025` is rejected rather than silently read as 25: it usually means the
  // operator typed something they did not intend.
  if (whole.length > 1 && whole.startsWith('0')) {
    return undefined;
  }
  if (whole.length > MAX_INTEGER_DIGITS) {
    return undefined;
  }

  return `${whole}.${fraction.padEnd(MONEY_SCALE, '0')}`;
}

/**
 * Normalises operator-typed publish counts.
 *
 * @returns the integer, `null` for uncapped, or `undefined` if invalid.
 */
export function normalizePublishCapInput(raw: string): number | null | undefined {
  const trimmed = raw.trim();
  if (trimmed === '') {
    return null;
  }

  // Whole numbers only. `5.5` and `-1` are refused rather than truncated.
  if (!/^(?:0|[1-9][0-9]{0,9})$/.test(trimmed)) {
    return undefined;
  }

  const value = Number.parseInt(trimmed, 10);
  return value > 2_147_483_647 ? undefined : value;
}
