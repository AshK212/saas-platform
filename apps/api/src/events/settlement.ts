import type { ActionCategory, IngestEvent } from '@hybrid/contracts';
import { MoneyError, parseUsdToMicros } from '@hybrid/db';

/**
 * Precheck-linked event settlement rules (Step 18).
 *
 * ─── THE INVARIANT ────────────────────────────────────────────────────────
 *
 *   PRECHECK COMMITS THE AUTHORITATIVE USAGE.
 *   THE FOLLOW-UP EVENT RECORDS WHAT HAPPENED.
 *   THE EVENT NEVER COMMITS THAT USAGE AGAIN.
 *
 * A precheck already debited the ledger and wrote a durable receipt. The
 * follow-up event is audit evidence that the authorized action actually ran.
 * Debiting again would double-count: a $4 allow followed by its own
 * `spend.recorded` would leave $8 committed for $4 of work.
 *
 * ─── WHY THESE CHECKS EXIST AT ALL ────────────────────────────────────────
 *
 * "Linked events do not debit" is only safe if the link is TRUE. Without
 * validation, `precheck_id` becomes a way to make spend disappear: point any
 * `spend.recorded` at any receipt and the plane records the money while
 * charging nothing for it.
 *
 * That is the attack these rules close, and it is why each one is a hard
 * rejection rather than a warning:
 *
 *   forge      -> unknown id, rejected by the workspace-scoped lookup
 *   borrow     -> another agent's receipt, rejected here
 *   substitute -> a publish receipt for a spend event, rejected here
 *   inflate    -> $400 against a $4 authorization, rejected here
 *   invert     -> a DENIED receipt as proof of success, rejected here
 *
 * ─── WHAT THIS MODULE DELIBERATELY DOES NOT DO ────────────────────────────
 *
 * It is a PURE FUNCTION over an event and a receipt. It reads no database,
 * touches no ledger, and returns no instruction to write anything. There is no
 * "settle" verb here because settlement is not a mutation in Step 18 - the
 * accounting already happened, and the correct action is to record the event
 * and change nothing else.
 *
 * ─── NOT IN THIS STEP ─────────────────────────────────────────────────────
 *
 * `spend.recorded` WITHOUT a `precheck_id` still does not debit the
 * authoritative ledger. That remains open, deliberately, for the next Credit
 * step. Nothing here changes it in either direction.
 */

/** The receipt facts settlement compares against. Immutable, already stored. */
export interface SettlementReceipt {
  readonly id: string;
  /** Internal agent UUID the decision was made for. */
  readonly agentId: string;
  readonly category: ActionCategory;
  readonly decision: 'allow' | 'deny';
  /** Decimal string for a spend decision, else null. */
  readonly requestedAmountUsd: string | null;
  readonly requestedPublishCount: number | null;
}

export type LinkageCheck = { readonly ok: true } | { readonly ok: false; readonly message: string };

const OK: LinkageCheck = { ok: true };

function reject(message: string): LinkageCheck {
  return { ok: false, message };
}

/**
 * The category an event is governed as.
 *
 * `spend.recorded` carries no `category` field because its type already says
 * what it is - the event vocabulary and the action-category vocabulary are
 * separate, and this is the one place they must be reconciled. `heartbeat` is
 * not a governed action at all.
 */
export function effectiveCategory(event: IngestEvent): ActionCategory | null {
  switch (event.type) {
    case 'spend.recorded':
      return 'spend';
    case 'agent.action':
    case 'action.blocked':
      return event.category;
    case 'heartbeat':
      return null;
  }
}

/**
 * Whether an event asserts that the governed action SUCCEEDED.
 *
 * The distinction decides which receipt decisions are coherent. A completed
 * action cannot be evidenced by a refusal.
 */
function assertsSuccess(event: IngestEvent): boolean {
  return event.type === 'spend.recorded' || event.type === 'agent.action';
}

/**
 * The amount an event reports, where it reports one.
 *
 * Only ever a TYPED ENVELOPE FIELD. `payload` is inert by construction and is
 * never consulted: a governance-critical number hidden in free-form JSON is
 * exactly the silent accounting hole the strict contract exists to prevent.
 */
function reportedAmountUsd(event: IngestEvent): string | null {
  if (event.type === 'spend.recorded') {
    return event.amount_usd;
  }
  if (event.type === 'action.blocked') {
    return event.amount_usd ?? null;
  }
  return null;
}

/**
 * Exact decimal equality, via micro-dollar `bigint`.
 *
 * `"4"`, `"4.0"` and `"4.000000"` are all valid wire representations of the
 * same money and must compare equal. String equality would reject two of them;
 * `parseFloat` would compare doubles, and a comparison that decides whether
 * $400 passes as $4 is the last place a float belongs.
 */
function sameMoney(left: string, right: string): boolean {
  try {
    return parseUsdToMicros(left) === parseUsdToMicros(right);
  } catch (error: unknown) {
    // Both sides are already contract- or column-validated, so this is
    // unreachable in practice. Failing closed is still the only safe answer:
    // an amount we cannot parse is an amount we cannot claim matches.
    if (error instanceof MoneyError) {
      return false;
    }
    throw error;
  }
}

/**
 * Decides whether a follow-up event may claim this receipt.
 *
 * @param event - the validated event, exactly as it arrived.
 * @param receipt - the receipt, already resolved INSIDE the caller's workspace.
 *   Passing one from another tenant is not defended against here; the lookup is
 *   scoped so such a receipt is never obtained in the first place.
 * @param resolvedAgentId - internal UUID of the event's agent, resolved inside
 *   the same workspace. Never the wire `agent_id`, which is external.
 *
 * Messages name the specific mismatch. Within one workspace that leaks nothing:
 * an API key is workspace-scoped, so its holder may already read every receipt
 * in the tenant through the operator surface. Cross-tenant indistinguishability
 * is enforced one level up, by the scoped lookup returning null.
 */
export function checkPrecheckLinkage(
  event: IngestEvent,
  receipt: SettlementReceipt,
  resolvedAgentId: string,
): LinkageCheck {
  // ─── 1. AGENT ───────────────────────────────────────────────────────────
  //
  // A receipt authorizes ONE agent's action. Letting agent-b settle agent-a's
  // authorization would let a single prechecked $4 absolve spend across the
  // entire fleet.
  if (receipt.agentId !== resolvedAgentId) {
    return reject('precheck_id belongs to a different agent.');
  }

  // ─── 2. EVENT TYPE ──────────────────────────────────────────────────────
  //
  // A heartbeat is liveness, not the completion of a governed action. There is
  // no action for it to follow up on, so linkage would be meaningless - and
  // meaningless linkage in an audit trail is worse than none.
  const category = effectiveCategory(event);
  if (category === null) {
    return reject('A heartbeat cannot reference a precheck.');
  }

  // ─── 3. DECISION ────────────────────────────────────────────────────────
  //
  // A denial is not permission. An event asserting the action ran cannot cite
  // a receipt saying it was refused - and if it could, every denied action
  // could report its spend as already accounted for.
  if (assertsSuccess(event) && receipt.decision === 'deny') {
    return reject('precheck_id references a denied decision.');
  }

  // ─── 4. CATEGORY ────────────────────────────────────────────────────────
  //
  // Categories are the governance vocabulary. A `publish` receipt must not
  // become evidence for a spend, and an `llm_call` receipt must not become
  // spend authorization merely by being referenced.
  if (receipt.category !== category) {
    return reject(`precheck_id references a ${receipt.category} decision, not ${category}.`);
  }

  // ─── 5. AMOUNT ──────────────────────────────────────────────────────────
  //
  // THE INFLATION GUARD. A $4 authorization must not silently absolve $400.
  // Exact micro-dollar comparison; no float anywhere on this path.
  const reported = reportedAmountUsd(event);
  if (reported !== null) {
    if (receipt.requestedAmountUsd === null) {
      // A receipt that authorized no amount cannot vouch for one.
      return reject('precheck_id references a decision with no authorized amount.');
    }
    if (!sameMoney(reported, receipt.requestedAmountUsd)) {
      return reject('amount_usd does not match the amount this precheck authorized.');
    }
  }

  return OK;
}
