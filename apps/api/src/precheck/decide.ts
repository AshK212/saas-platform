import type {
  ActionCategory,
  AgentMode,
  PrecheckDenyReason,
  PrecheckRemaining,
} from '@hybrid/contracts';
import {
  addMicros,
  formatUsdFromMicros,
  parseUsdToMicros,
  remainingCount,
  remainingMicros,
} from '@hybrid/db';

/**
 * The governance decision, as a PURE function.
 *
 * Deliberately separated from the transaction that surrounds it. Cap
 * comparison is the part that must be exactly right, and keeping it free of
 * database access means every branch is exhaustively testable without a
 * connection - and that a future change to the transaction cannot quietly
 * change what "allowed" means.
 *
 * It decides. It does not write, lock, or know that a ledger exists as
 * anything other than two committed numbers handed to it.
 */

/** The policy snapshot this decision is evaluated against. */
export interface AppliedPolicy {
  readonly mode: AgentMode;
  /** Decimal string, or null for UNCAPPED. */
  readonly dailySpendCapUsd: string | null;
  /** Non-negative integer, or null for UNCAPPED. */
  readonly dailyPublishCap: number | null;
}

/** Authoritative committed usage, read under the row lock. */
export interface CommittedUsage {
  readonly spendCommittedUsd: string;
  readonly publishCountCommitted: number;
}

export interface DecisionInput {
  readonly category: ActionCategory;
  /** Decimal string. Present only for `spend`, guaranteed by the contract. */
  readonly amountUsd?: string | undefined;
  readonly policy: AppliedPolicy;
  readonly usage: CommittedUsage;
}

export interface Decision {
  readonly allow: boolean;
  readonly reason?: PrecheckDenyReason | undefined;
  /**
   * Whether an ALLOWED decision must be recorded in the authoritative ledger.
   *
   * Separate from `allow` because the two genuinely differ: `watch` allows and
   * records nothing, and `other` is allowed but is not a tracked quantity.
   */
  readonly commit: 'spend' | 'publish' | 'none';
  /** Headroom to report, computed AFTER any commit. Null when uncapped. */
  readonly remaining: PrecheckRemaining | null;
}

/**
 * Which categories consume a tracked daily quantity.
 *
 * `llm_call` and `tool_call` are governed by mode but not by a cap - the locked
 * Credit contract defines no accounting limit for them, and inventing one would
 * enforce a budget nobody configured. `other` is the explicit uncategorised
 * escape hatch and is likewise untracked.
 */
function trackedQuantity(category: ActionCategory): 'spend' | 'publish' | 'none' {
  if (category === 'spend') return 'spend';
  if (category === 'publish') return 'publish';
  return 'none';
}

/** Does this category need the ledger row locked at all? */
export function requiresLedger(category: ActionCategory, mode: AgentMode): boolean {
  // Only a budgeted, tracked category touches the ledger. `watch` allows
  // without recording, and `paused` denies without recording.
  return mode === 'budgeted' && trackedQuantity(category) !== 'none';
}

/**
 * Evaluates one action against one policy snapshot and one committed usage.
 *
 * ─── MODE SEMANTICS ───────────────────────────────────────────────────────
 *
 *   watch     always allow, NEVER touch the ledger. Observation mode must not
 *             silently behave as budgeted accounting - an operator who has not
 *             opted into enforcement has not opted into having usage counted
 *             against them either.
 *   budgeted  compare the relevant cap; commit on allow.
 *   paused    deny everything, touch nothing.
 *
 * ─── UNCAPPED BUDGETED STILL COMMITS ──────────────────────────────────────
 *
 * Under `budgeted` with a null cap, a tracked action is allowed AND recorded.
 * The ledger is authoritative committed usage, independent of whether a cap
 * currently exists - so if an operator adds a cap later the same day, the
 * morning's spend is already counted rather than silently forgiven.
 */
export function decide(input: DecisionInput): Decision {
  const { category, policy, usage } = input;

  // PAUSED denies every category, including `other`. A pause is a kill switch,
  // not a budget: an agent that can still act "a bit" is not paused.
  if (policy.mode === 'paused') {
    return { allow: false, reason: 'paused', commit: 'none', remaining: null };
  }

  // WATCH allows everything and records nothing.
  if (policy.mode === 'watch') {
    return { allow: true, commit: 'none', remaining: null };
  }

  const tracked = trackedQuantity(category);

  // Budgeted, but an untracked category: allowed, no cap governs it.
  if (tracked === 'none') {
    return { allow: true, commit: 'none', remaining: null };
  }

  if (tracked === 'spend') {
    // Guaranteed present by the contract; treated as zero only defensively so
    // a contract change cannot turn into an unbounded allow.
    const requested = parseUsdToMicros(input.amountUsd ?? '0');
    const committed = parseUsdToMicros(usage.spendCommittedUsd);

    if (policy.dailySpendCapUsd === null) {
      // Uncapped: allow and RECORD, so a cap added later today applies to a
      // real running total.
      return {
        allow: true,
        commit: 'spend',
        remaining: null,
      };
    }

    const cap = parseUsdToMicros(policy.dailySpendCapUsd);
    // Exact micro-dollar integers. `addMicros` also refuses to exceed storage
    // capacity, so an absurd request fails before it can be allowed.
    const prospective = addMicros(committed, requested);

    if (prospective > cap) {
      // DENIED ACTIONS NEVER MUTATE THE LEDGER. Remaining reflects CURRENT
      // committed usage, not the refused request - subtracting what was
      // denied would report headroom the agent never consumed.
      return {
        allow: false,
        reason: 'daily_spend_cap_exceeded',
        commit: 'none',
        remaining: { kind: 'usd', value: formatUsdFromMicros(remainingMicros(cap, committed)) },
      };
    }

    // Allowed exactly AT the cap: `prospective <= cap`. Spending the last
    // cent of a budget is within it; the next positive request is not.
    return {
      allow: true,
      commit: 'spend',
      remaining: { kind: 'usd', value: formatUsdFromMicros(remainingMicros(cap, prospective)) },
    };
  }

  // PUBLISH. One precheck is one publish, so the delta is always exactly 1.
  const committed = usage.publishCountCommitted;

  if (policy.dailyPublishCap === null) {
    return { allow: true, commit: 'publish', remaining: null };
  }

  const prospective = committed + 1;
  if (prospective > policy.dailyPublishCap) {
    return {
      allow: false,
      reason: 'daily_publish_cap_exceeded',
      commit: 'none',
      remaining: { kind: 'publish', value: remainingCount(policy.dailyPublishCap, committed) },
    };
  }

  return {
    allow: true,
    commit: 'publish',
    remaining: { kind: 'publish', value: remainingCount(policy.dailyPublishCap, prospective) },
  };
}
