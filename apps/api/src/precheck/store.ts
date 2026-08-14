import {
  explanationForDenyReason,
  ruleForDenyReason,
  type PrecheckRequest,
  type PrecheckResponse,
} from '@hybrid/contracts';
import {
  createAgentRepository,
  createLedgerRepository,
  createPlaneBlockRepository,
  createPolicyReadRepository,
  createPrecheckLockRepository,
  createPrecheckReceiptRepository,
  toUtcAccountingDay,
  type AuthenticatedApiCredential,
  type DatabaseClient,
  type ReceiptRow,
  type UtcAccountingDay,
} from '@hybrid/db';

import { decide, requiresLedger, type Decision } from './decide.js';

/**
 * The precheck decision transaction.
 *
 * ─── THE WHOLE THING IS ONE TRANSACTION ───────────────────────────────────
 *
 *   BEGIN
 *     1. advisory-lock the action identity      (idempotency)
 *     2. return the existing receipt if replayed
 *     3. FOR SHARE the policy version + read the agent's policy  (consistency)
 *     4. lock the daily ledger row, if this category needs it    (serialization)
 *     5. decide
 *     6. if allowed and tracked: commit usage
 *     7. insert the immutable receipt
 *   COMMIT
 *
 * COMMIT-ON-ALLOW is the release-critical rule. The ledger mutation and the
 * receipt share one transaction, so:
 *
 *   - a failed receipt insert rolls the debit back. Money that was spent but
 *     unexplainable is worse than a failed request.
 *   - a failed debit prevents the receipt. A receipt claiming spend that never
 *     landed would be false evidence.
 *
 * ─── GLOBAL LOCK ORDER ────────────────────────────────────────────────────
 *
 *   1. precheck action advisory lock
 *   2. workspace_policy_state          (FOR SHARE here, FOR UPDATE in Step 13)
 *   3. ledger_daily row                (FOR UPDATE)
 *
 * Every service that takes more than one of these takes them in this order.
 * Step 13's policy mutation takes only (2). Step 10's ingest takes only its own
 * advisory family. Nothing takes the ledger before the policy, so no cycle can
 * form. Documented in docs/precheck.md.
 */

/** The decision as returned to the caller, plus what it cost. */
export interface PrecheckOutcome {
  readonly response: PrecheckResponse;
  /** True when an existing receipt was returned rather than a new decision made. */
  readonly replayed: boolean;
}

/** The workspace has no policy state - a provisioning invariant failed. */
export class MissingPolicyStateError extends Error {
  public constructor() {
    super('Workspace policy state is missing.');
    this.name = 'MissingPolicyStateError';
  }
}

export interface PrecheckStore {
  /**
   * Decides one action and records a durable receipt.
   *
   * @param now - SERVER time. One reading per decision, used for the ledger day
   *   and the receipt's accounting day alike so they cannot disagree.
   */
  precheck(
    credential: AuthenticatedApiCredential,
    request: PrecheckRequest,
    now: Date,
  ): Promise<PrecheckOutcome>;
}

/** Rebuilds the wire response from a stored receipt, for a replay. */
function toResponse(receipt: ReceiptRow): PrecheckResponse {
  const base = {
    precheck_id: receipt.id,
    decision: receipt.decision,
    remaining:
      receipt.remainingSpendUsd !== null
        ? ({ kind: 'usd', value: receipt.remainingSpendUsd } as const)
        : receipt.remainingPublishCount !== null
          ? ({ kind: 'publish', value: receipt.remainingPublishCount } as const)
          : null,
  };

  // `reason` is present only on a denial, matching the contract.
  return receipt.denyReason === null
    ? base
    : { ...base, reason: receipt.denyReason as PrecheckResponse['reason'] };
}

/** Builds the wire response for a freshly made decision. */
function decisionToResponse(precheckId: string, decision: Decision): PrecheckResponse {
  const base = {
    precheck_id: precheckId,
    decision: decision.allow ? ('allow' as const) : ('deny' as const),
    remaining: decision.remaining,
  };
  return decision.reason === undefined ? base : { ...base, reason: decision.reason };
}

export function createDrizzlePrecheckStore(db: DatabaseClient): PrecheckStore {
  return {
    async precheck(
      credential: AuthenticatedApiCredential,
      request: PrecheckRequest,
      now: Date,
    ): Promise<PrecheckOutcome> {
      // Scope from the credential row. Nothing in the body contributed.
      const scope = credential.scope;
      // ONE server clock reading per decision. The ledger day and the receipt's
      // accounting day are derived from it once, so they cannot disagree - and
      // a caller's clock is never consulted.
      const day: UtcAccountingDay = toUtcAccountingDay(now);

      return db.transaction(async (tx) => {
        const receipts = createPrecheckReceiptRepository(tx, scope);

        // ── 1. IDEMPOTENCY ────────────────────────────────────────────────
        // A network retry of an allowed spend must not debit twice. The lock
        // is transaction-scoped, so it releases at COMMIT or ROLLBACK with no
        // unlock call to leak under PgBouncer/Neon pooling.
        await createPrecheckLockRepository(tx, scope).lockAction(request.action_id);

        const existing = await receipts.findByActionId(request.action_id);
        if (existing !== null) {
          // The original decision is authoritative. A replay carrying a
          // DIFFERENT agent, category or amount still returns this receipt and
          // changes nothing: historical action identity is not reinterpreted,
          // and re-deciding would be a second chance to spend.
          return { response: toResponse(existing), replayed: true };
        }

        // ── 2. AGENT ──────────────────────────────────────────────────────
        // Discovered on first sight, exactly as event ingest does, so a
        // runtime may precheck before sending its first event. Discovery does
        // not advance last-seen: a precheck is a request for permission, not
        // evidence of activity.
        const agent = await createAgentRepository(tx, scope).discover(request.agent_id, now);

        // ── 3. CONSISTENT POLICY SNAPSHOT ─────────────────────────────────
        // Version and caps read together under FOR SHARE, so the receipt can
        // cite a version that genuinely produced this decision.
        const policy = await createPolicyReadRepository(tx, scope).lockPolicyForDecision(
          agent.id,
        );
        if (policy === null) {
          // Rolls back; no receipt, no ledger effect.
          throw new MissingPolicyStateError();
        }

        // ── 4. LEDGER ─────────────────────────────────────────────────────
        // Locked only when this category could actually commit. `watch` and
        // `paused` never touch it, and an untracked category has nothing to
        // record - so those decisions do not contend on the row at all.
        const ledger = createLedgerRepository(tx, scope);
        const locked = requiresLedger(request.category, policy.mode)
          ? await ledger.lockDailyLedger(agent.id, day)
          : null;

        // Usage read UNDER THE LOCK when one was taken. Without a lock the
        // category cannot commit, so zeros are the correct neutral input.
        const usage = locked?.current ?? {
          spendCommittedUsd: '0.000000',
          publishCountCommitted: 0,
        };

        // ── 5. DECIDE ─────────────────────────────────────────────────────
        const decision = decide({
          category: request.category,
          amountUsd: request.amount_usd,
          policy: {
            mode: policy.mode,
            dailySpendCapUsd: policy.dailySpendCapUsd,
            dailyPublishCap: policy.dailyPublishCap,
          },
          usage,
        });

        // ── 6. COMMIT ON ALLOW ────────────────────────────────────────────
        // Only through the locked capability, which cannot exist unless the
        // row was serialized. A DENIED action never reaches here, so a denial
        // can never mutate the ledger.
        if (decision.allow && decision.commit !== 'none' && locked !== null) {
          if (decision.commit === 'spend') {
            await locked.commitSpend(request.amount_usd ?? '0.000000');
          } else {
            await locked.commitPublish();
          }
        }

        // ── 7. DURABLE RECEIPT, SAME TRANSACTION ──────────────────────────
        // EVERY decision gets one - allow, deny, watch, uncapped, untracked.
        const receipt = await receipts.insert({
          actionId: request.action_id,
          agentId: agent.id,
          category: request.category,
          requestedAmountUsd: request.category === 'spend' ? (request.amount_usd ?? null) : null,
          // One precheck is one intended publish; the contract accepts no count.
          requestedPublishCount: request.category === 'publish' ? 1 : null,
          decision: decision.allow ? 'allow' : 'deny',
          // The EXACT version this decision was made under. An operator can
          // change policy a second later and this receipt still explains
          // itself.
          policyVersion: policy.version,
          appliedMode: policy.mode,
          appliedSpendCapUsd: policy.dailySpendCapUsd,
          appliedPublishCap: policy.dailyPublishCap,
          accountingDay: day,
          // Usage as READ, before any commit - the evidence that explains the
          // comparison. Null when no ledger was consulted.
          ledgerSpendBeforeUsd: locked === null ? null : usage.spendCommittedUsd,
          ledgerPublishBefore: locked === null ? null : usage.publishCountCommitted,
          remainingSpendUsd:
            decision.remaining?.kind === 'usd' ? decision.remaining.value : null,
          remainingPublishCount:
            decision.remaining?.kind === 'publish' ? decision.remaining.value : null,
          denyReason: decision.reason ?? null,
        });

        // ── 8. WHOEVER DENIES, RECORDS ────────────────────────────────────
        // A plane denial writes its own block, in THIS transaction, linked to
        // the receipt just inserted. Same instant, same decision context - no
        // second policy read, so the block cannot tell a different story from
        // the receipt it explains.
        //
        // An ALLOW writes no block. Gated on `decision.reason`, which the
        // decision sets only when it refuses.
        if (!decision.allow && decision.reason !== undefined) {
          await createPlaneBlockRepository(tx, scope).createForDeniedPrecheck({
            agentId: agent.id,
            // Receipt-first ordering: the FK lives only on the block, so
            // nothing needs updating afterwards and the receipt stays
            // insert-only.
            precheckReceiptId: receipt.id,
            category: request.category,
            // The SINGLE shared mapping. Route code never invents a string, so
            // the receipt, the block and the wire response cannot disagree
            // about why the action was refused.
            rule: ruleForDenyReason(decision.reason),
            reason: explanationForDenyReason(decision.reason),
            // Denial evidence, recorded only where it means something: an
            // amount for a spend refusal, a count for a publish refusal.
            amountUsd: request.category === 'spend' ? request.amount_usd : undefined,
            count: request.category === 'publish' ? 1 : undefined,
            createdAt: now,
          });
        }

        return { response: decisionToResponse(receipt.id, decision), replayed: false };
      });
    },
  };
}
