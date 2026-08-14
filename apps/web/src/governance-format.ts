import type { AgentGovernance, AgentMode, DenialRule, PrecheckDenyReason } from '@hybrid/contracts';

/**
 * Display formatting for governance values.
 *
 * ─── MONEY IS FORMATTED, NEVER COMPUTED ───────────────────────────────────
 *
 * Every function here takes a canonical decimal string and produces another
 * string. There is no `parseFloat`, no `toFixed`, no arithmetic. The browser
 * must never derive enforcement state - "is this agent over its cap?" is a
 * question only the plane answers, and a float comparison here could disagree
 * with the exact micro-dollar comparison the precheck actually made.
 *
 * ─── WORDING IS FACTUAL ───────────────────────────────────────────────────
 *
 * A configured cap is not a guarantee. Nothing here says "protected", "safe"
 * or "blocked" merely because a number exists; it reports what is set and what
 * has been committed, and lets the operator draw the conclusion.
 */

/** Human label for a mode. */
export const MODE_LABEL: Record<AgentMode, string> = {
  watch: 'Watch',
  budgeted: 'Budgeted',
  paused: 'Paused',
};

/** One-line description of what a mode means, for a tooltip or caption. */
export const MODE_DESCRIPTION: Record<AgentMode, string> = {
  watch: 'Activity is recorded. Caps are not applied.',
  budgeted: 'Caps below are applied to spend and publish actions.',
  paused: 'Actions are denied while paused.',
};

/**
 * Formats a canonical `"25.000000"` as `"$25.00"`.
 *
 * STRING MANIPULATION ONLY. The integer half is taken verbatim and the
 * fraction is truncated to two places for display - never rounded, because a
 * rounded-up total could read as over a cap the plane considers unmet.
 * Grouping separators are inserted by walking the digits.
 */
export function formatUsd(value: string): string {
  const [whole = '0', fraction = ''] = value.split('.');
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const cents = fraction.slice(0, 2).padEnd(2, '0');
  return `$${grouped}.${cents}`;
}

/**
 * `"Today's spend: $24.00 / $25.00"` or `"… / Uncapped"`.
 *
 * The two halves are formatted independently and never compared: whether the
 * left has reached the right is enforcement state, and this module does not
 * decide enforcement state.
 */
export function describeSpend(governance: AgentGovernance): string {
  const committed = formatUsd(governance.spendCommittedUsd);
  return governance.dailySpendCapUsd === null
    ? `${committed} / Uncapped`
    : `${committed} / ${formatUsd(governance.dailySpendCapUsd)}`;
}

/** `"4 / 5"` or `"4 / Uncapped"`. */
export function describePublishes(governance: AgentGovernance): string {
  const committed = String(governance.publishCountCommitted);
  return governance.dailyPublishCap === null
    ? `${committed} / Uncapped`
    : `${committed} / ${String(governance.dailyPublishCap)}`;
}

/** Whether caps are worth showing at all for this mode. */
export function capsApply(mode: AgentMode): boolean {
  // Under `watch` a leftover cap is not applied, and under `paused` nothing
  // proceeds - showing a budget in either case would imply it governs.
  return mode === 'budgeted';
}

/** Human label for a denial reason. */
export const REASON_LABEL: Record<PrecheckDenyReason, string> = {
  daily_spend_cap_exceeded: 'Daily spend cap exceeded',
  daily_publish_cap_exceeded: 'Daily publish cap exceeded',
  paused: 'Agent paused',
};

/** Human label for a governance control. */
export const RULE_LABEL: Record<DenialRule, string> = {
  daily_spend_cap: 'Daily spend cap',
  daily_publish_cap: 'Daily publish cap',
  agent_paused: 'Agent paused',
};

/**
 * Labels a rule for display, falling back to the raw value.
 *
 * A RUNTIME block's rule is free text chosen by the plugin, so it will not be
 * in the map. Showing it verbatim is correct - inventing a friendly label for
 * a string we do not control would misrepresent what the runtime reported.
 */
export function describeRule(rule: string): string {
  return RULE_LABEL[rule as DenialRule] ?? rule;
}

/** `"Control plane block"` / `"Runtime-reported block"`. */
export function describeBlockOwner(source: 'plane' | 'runtime'): string {
  return source === 'plane' ? 'Control plane block' : 'Runtime-reported block';
}

/** A timestamp rendered in full, with the ISO value available on hover. */
export function formatInstant(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString();
}
