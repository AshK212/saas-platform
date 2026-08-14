import type { DecimalUsd } from '@hybrid/contracts';

/**
 * The three reference agents.
 *
 * ─── WHY EXACTLY THREE, AND WHY STABLE IDS ────────────────────────────────
 *
 * AC-04 asks for three agents visible with last-seen inside 60 seconds, so the
 * reference fleet is three. The external ids are STABLE across runs because
 * `agents.external_id` is the identity the plane deduplicates on: a fresh id
 * per run would enroll a new agent every time and the roster would grow
 * without bound, which is the opposite of what the criterion demonstrates.
 *
 * ─── THE ROLES MATCH THE ACCEPTANCE FLOWS ─────────────────────────────────
 *
 * Agent A spends, because AC-07/08/10/12 configure a spend cap and a pause on
 * it. Agent B publishes, because AC-11 configures a publish cap. Agent C does
 * untracked work, so the fleet shows an agent that governance is watching but
 * not metering.
 *
 * None of that is configured HERE. The operator sets policy through the
 * authenticated UI; this file only decides what each agent tries to do.
 */

export interface ReferenceAgent {
  /** `agents.external_id`. Stable across runs, by design. */
  readonly agentId: string;
  readonly name: string;
  /** What this agent attempts on a normal tick. */
  readonly role: 'spender' | 'publisher' | 'worker';
}

export const FLEET: readonly ReferenceAgent[] = [
  { agentId: 'agent-a', name: 'Research Agent A', role: 'spender' },
  { agentId: 'agent-b', name: 'Publishing Agent B', role: 'publisher' },
  { agentId: 'agent-c', name: 'Utility Agent C', role: 'worker' },
];

/**
 * Small, exact spend amounts for the baseline stream.
 *
 * DECIMAL STRINGS, never numbers. The wire contract is a string precisely so
 * a value cannot pass through an IEEE-754 double on its way to a ledger, and
 * a client that formatted `0.1 + 0.2` would reintroduce exactly that.
 *
 * They are also deliberately small: the baseline stream should not exhaust a
 * $25 cap by itself, or the over-cap scenario could not be demonstrated
 * afterwards on a fresh day.
 */
export const BASELINE_SPEND_CYCLE: readonly DecimalUsd[] = [
  '0.010000',
  '0.025000',
  '0.050000',
];

/** The amount AC-08 attempts against a $25 cap. */
export const OVER_CAP_AMOUNT: DecimalUsd = '41.000000';

/** AC-11 asks for six publishes against a cap of five. */
export const PUBLISH_BURST_SIZE = 6;
