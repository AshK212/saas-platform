import { precheckDenyReasonSchema, type PrecheckDenyReason } from './precheck.js';

import { z } from 'zod';

/**
 * The denial vocabulary shared by receipts, blocks and the wire.
 *
 * ONE MAPPING, IN ONE PLACE.
 *
 * A denial is recorded in two artifacts - the receipt and the plane-owned
 * block - and reported to the caller in a third. If route or repository code
 * invented its own strings, those three could disagree about why the same
 * action was refused, and an operator reading a block would be told something
 * different from the runtime that was denied.
 *
 * `reason` answers "what happened" (`daily_spend_cap_exceeded`). `rule` answers
 * "which control fired" (`daily_spend_cap`). They are deliberately different
 * vocabularies: a rule is stable governance identity, while reasons could
 * gain nuance later without renaming the control.
 */

/** The governance control that produced a denial. */
export const denialRuleSchema = z.enum([
  'daily_spend_cap',
  'daily_publish_cap',
  'agent_paused',
]);

export type DenialRule = z.infer<typeof denialRuleSchema>;

/**
 * The single reason -> rule mapping.
 *
 * Exhaustive by construction: `Record<PrecheckDenyReason, DenialRule>` fails to
 * compile if a new reason is added without deciding which control it belongs
 * to, so the vocabularies cannot drift apart silently.
 */
const RULE_FOR_REASON: Record<PrecheckDenyReason, DenialRule> = {
  daily_spend_cap_exceeded: 'daily_spend_cap',
  daily_publish_cap_exceeded: 'daily_publish_cap',
  paused: 'agent_paused',
};

export function ruleForDenyReason(reason: PrecheckDenyReason): DenialRule {
  return RULE_FOR_REASON[reason];
}

/**
 * Human-readable explanation, for the `reason` column blocks require.
 *
 * The machine-readable code is what clients branch on; this is what an
 * operator reads in a block list. Both are stored so neither has to be
 * reconstructed later from the other.
 */
const EXPLANATION_FOR_REASON: Record<PrecheckDenyReason, string> = {
  daily_spend_cap_exceeded: 'Daily spend cap reached.',
  daily_publish_cap_exceeded: 'Daily publish cap reached.',
  paused: 'Agent is paused.',
};

export function explanationForDenyReason(reason: PrecheckDenyReason): string {
  return EXPLANATION_FOR_REASON[reason];
}

/** Re-exported so callers need only one import for the denial vocabulary. */
export { precheckDenyReasonSchema };
