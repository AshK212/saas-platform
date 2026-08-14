import { randomUUID } from 'node:crypto';

import {
  explanationForDenyReason,
  ruleForDenyReason,
  type AgentMode,
  type PrecheckRequest,
  type PrecheckResponse,
} from '@hybrid/contracts';
import { toUtcAccountingDay, type AuthenticatedApiCredential } from '@hybrid/db';

import { decide, requiresLedger } from '../../src/precheck/decide';
import { MissingPolicyStateError, type PrecheckOutcome, type PrecheckStore } from '../../src/precheck/store';

/**
 * In-memory `PrecheckStore` mirroring the production transaction exactly.
 *
 * Reproduces the ordering that matters: idempotency first, then a consistent
 * policy snapshot, then locked usage, then the decision, then commit-on-allow,
 * then the receipt - with a snapshot/rollback so a failed receipt insert
 * undoes the debit.
 *
 * WHAT IT CANNOT PROVE
 * --------------------
 * It is single-threaded JavaScript, so its idempotency check and its "lock"
 * are authoritative for free. Whether `pg_advisory_xact_lock` really
 * serializes two concurrent retries, whether `SELECT … FOR UPDATE` prevents
 * two callers from both allowing past a cap, and whether the whole thing rolls
 * back atomically can only be established by
 * `packages/db/tests/precheck.live.test.ts`, skipped without
 * `TEST_DATABASE_URL`.
 */

export interface StoredReceipt {
  id: string;
  workspaceId: string;
  actionId: string;
  agentExternalId: string;
  category: PrecheckRequest['category'];
  decision: 'allow' | 'deny';
  policyVersion: string;
  appliedMode: AgentMode;
  appliedSpendCapUsd: string | null;
  appliedPublishCap: number | null;
  accountingDay: string;
  requestedAmountUsd: string | null;
  requestedPublishCount: number | null;
  ledgerSpendBeforeUsd: string | null;
  ledgerPublishBefore: number | null;
  remainingSpendUsd: string | null;
  remainingPublishCount: number | null;
  denyReason: string | null;
}

interface LedgerRow {
  workspaceId: string;
  agentExternalId: string;
  day: string;
  spendCommittedUsd: string;
  publishCountCommitted: number;
}

/** A plane-owned block, as the decision transaction records it. */
export interface StoredPlaneBlock {
  id: string;
  workspaceId: string;
  agentExternalId: string;
  source: 'plane';
  externalBlockId: null;
  precheckReceiptId: string;
  category: PrecheckRequest['category'];
  rule: string;
  reason: string;
  amountUsd: string | null;
  count: number | null;
  createdAt: Date;
}

interface PolicyRow {
  workspaceId: string;
  agentExternalId: string;
  mode: AgentMode;
  dailySpendCapUsd: string | null;
  dailyPublishCap: number | null;
}

export interface MemoryPrecheckStore extends PrecheckStore {
  readonly receipts: StoredReceipt[];
  readonly ledger: LedgerRow[];
  readonly blocks: StoredPlaneBlock[];
  readonly agents: { workspaceId: string; externalId: string }[];
  /** The block accompanying a receipt, if any. */
  blockForReceipt(receiptId: string): StoredPlaneBlock | undefined;
  /** Forces the block insert to fail, to exercise rollback. */
  failBlockInsert: boolean;
  /** Stands in for provisioning. */
  seedPolicyState(workspaceId: string, version?: string): void;
  /** Stands in for the Step 13 operator mutation service. */
  seedPolicy(policy: PolicyRow): void;
  seedVersion(workspaceId: string, version: string): void;
  /** Reads committed usage, for assertions. */
  usageOf(workspaceId: string, agentExternalId: string, day: string): LedgerRow | undefined;
  /** Forces the receipt insert to fail, to exercise rollback. */
  failReceiptInsert: boolean;
}

export function createMemoryPrecheckStore(): MemoryPrecheckStore {
  const receipts: StoredReceipt[] = [];
  const ledger: LedgerRow[] = [];
  const blocks: StoredPlaneBlock[] = [];
  const agents: { workspaceId: string; externalId: string }[] = [];
  const policies: PolicyRow[] = [];
  const versions = new Map<string, string>();
  const state = { failReceiptInsert: false, failBlockInsert: false };

  function usdAdd(a: string, b: string): string {
    // Exact micro-dollar integers, matching the production path.
    const toMicros = (v: string): bigint => {
      const [whole = '0', fraction = ''] = v.split('.');
      return BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(6, '0'));
    };
    const total = toMicros(a) + toMicros(b);
    return `${(total / 1_000_000n).toString()}.${(total % 1_000_000n).toString().padStart(6, '0')}`;
  }

  return {
    receipts,
    ledger,
    blocks,
    agents,

    blockForReceipt(receiptId: string): StoredPlaneBlock | undefined {
      return blocks.find((b) => b.precheckReceiptId === receiptId);
    },

    get failBlockInsert(): boolean {
      return state.failBlockInsert;
    },
    set failBlockInsert(value: boolean) {
      state.failBlockInsert = value;
    },

    seedPolicyState(workspaceId: string, version = '1'): void {
      versions.set(workspaceId, version);
    },
    seedPolicy(policy: PolicyRow): void {
      // REPLACES any existing policy for this agent, matching what an operator
      // mutation actually does. Appending would leave the first row winning
      // the lookup, so a test that "unpauses" would silently still be paused.
      const existing = policies.findIndex(
        (p) => p.workspaceId === policy.workspaceId && p.agentExternalId === policy.agentExternalId,
      );
      if (existing >= 0) {
        policies[existing] = policy;
      } else {
        policies.push(policy);
      }
      if (!agents.some((a) => a.workspaceId === policy.workspaceId && a.externalId === policy.agentExternalId)) {
        agents.push({ workspaceId: policy.workspaceId, externalId: policy.agentExternalId });
      }
    },
    seedVersion(workspaceId: string, version: string): void {
      versions.set(workspaceId, version);
    },
    usageOf(workspaceId: string, agentExternalId: string, day: string): LedgerRow | undefined {
      return ledger.find(
        (r) => r.workspaceId === workspaceId && r.agentExternalId === agentExternalId && r.day === day,
      );
    },

    get failReceiptInsert(): boolean {
      return state.failReceiptInsert;
    },
    set failReceiptInsert(value: boolean) {
      state.failReceiptInsert = value;
    },

    precheck(
      credential: AuthenticatedApiCredential,
      request: PrecheckRequest,
      now: Date,
    ): Promise<PrecheckOutcome> {
      const workspaceId = credential.scope.workspaceId;
      const day = toUtcAccountingDay(now);

      // Snapshot for rollback - production is one transaction.
      const ledgerSnapshot = ledger.map((r) => ({ ...r }));
      const agentSnapshot = agents.map((a) => ({ ...a }));
      const receiptSnapshot = [...receipts];
      const blockSnapshot = [...blocks];

      const rollback = (): void => {
        ledger.length = 0;
        ledger.push(...ledgerSnapshot);
        agents.length = 0;
        agents.push(...agentSnapshot);
        receipts.length = 0;
        receipts.push(...receiptSnapshot);
        blocks.length = 0;
        blocks.push(...blockSnapshot);
      };

      // 1. IDEMPOTENCY, before anything else.
      const existing = receipts.find(
        (r) => r.workspaceId === workspaceId && r.actionId === request.action_id,
      );
      if (existing !== undefined) {
        const response: PrecheckResponse = {
          precheck_id: existing.id,
          decision: existing.decision,
          remaining:
            existing.remainingSpendUsd !== null
              ? { kind: 'usd', value: existing.remainingSpendUsd }
              : existing.remainingPublishCount !== null
                ? { kind: 'publish', value: existing.remainingPublishCount }
                : null,
          ...(existing.denyReason === null
            ? {}
            : { reason: existing.denyReason as PrecheckResponse['reason'] }),
        };
        return Promise.resolve({ response, replayed: true });
      }

      // 2. Agent discovery - no last-seen advance.
      if (!agents.some((a) => a.workspaceId === workspaceId && a.externalId === request.agent_id)) {
        agents.push({ workspaceId, externalId: request.agent_id });
      }

      // 3. Consistent policy snapshot.
      const version = versions.get(workspaceId);
      if (version === undefined) {
        return Promise.reject(new MissingPolicyStateError());
      }
      const explicit = policies.find(
        (p) => p.workspaceId === workspaceId && p.agentExternalId === request.agent_id,
      );
      const policy = {
        mode: explicit?.mode ?? ('watch' as AgentMode),
        dailySpendCapUsd: explicit?.dailySpendCapUsd ?? null,
        dailyPublishCap: explicit?.dailyPublishCap ?? null,
      };

      // 4. Ledger, only when this category could commit.
      const needsLedger = requiresLedger(request.category, policy.mode);
      let row: LedgerRow | undefined;
      if (needsLedger) {
        row = ledger.find(
          (r) => r.workspaceId === workspaceId && r.agentExternalId === request.agent_id && r.day === day,
        );
        if (row === undefined) {
          row = {
            workspaceId,
            agentExternalId: request.agent_id,
            day,
            spendCommittedUsd: '0.000000',
            publishCountCommitted: 0,
          };
          ledger.push(row);
        }
      }
      const usage = row ?? { spendCommittedUsd: '0.000000', publishCountCommitted: 0 };

      // 5. Decide.
      const decision = decide({
        category: request.category,
        amountUsd: request.amount_usd,
        policy,
        usage: {
          spendCommittedUsd: usage.spendCommittedUsd,
          publishCountCommitted: usage.publishCountCommitted,
        },
      });

      const before = {
        spend: usage.spendCommittedUsd,
        publish: usage.publishCountCommitted,
      };

      // 6. Commit on allow, only through the locked row.
      if (decision.allow && decision.commit !== 'none' && row !== undefined) {
        if (decision.commit === 'spend') {
          row.spendCommittedUsd = usdAdd(row.spendCommittedUsd, request.amount_usd ?? '0.000000');
        } else {
          row.publishCountCommitted += 1;
        }
      }

      // 7. Durable receipt, same transaction.
      if (state.failReceiptInsert) {
        // Roll the debit back with it: neither half may survive alone.
        rollback();
        return Promise.reject(new Error('receipt insert failed'));
      }

      const receipt: StoredReceipt = {
        id: randomUUID(),
        workspaceId,
        actionId: request.action_id,
        agentExternalId: request.agent_id,
        category: request.category,
        decision: decision.allow ? 'allow' : 'deny',
        policyVersion: version,
        appliedMode: policy.mode,
        appliedSpendCapUsd: policy.dailySpendCapUsd,
        appliedPublishCap: policy.dailyPublishCap,
        accountingDay: day,
        requestedAmountUsd: request.category === 'spend' ? (request.amount_usd ?? null) : null,
        requestedPublishCount: request.category === 'publish' ? 1 : null,
        ledgerSpendBeforeUsd: needsLedger ? before.spend : null,
        ledgerPublishBefore: needsLedger ? before.publish : null,
        remainingSpendUsd: decision.remaining?.kind === 'usd' ? decision.remaining.value : null,
        remainingPublishCount:
          decision.remaining?.kind === 'publish' ? decision.remaining.value : null,
        denyReason: decision.reason ?? null,
      };
      receipts.push(receipt);

      // 8. WHOEVER DENIES, RECORDS. A plane denial writes its block in the
      //    same transaction, linked to the receipt just inserted. An allow
      //    writes none.
      if (!decision.allow && decision.reason !== undefined) {
        if (state.failBlockInsert) {
          // The receipt must not survive a denial whose block failed.
          rollback();
          return Promise.reject(new Error('block insert failed'));
        }

        blocks.push({
          id: randomUUID(),
          workspaceId,
          agentExternalId: request.agent_id,
          source: 'plane',
          externalBlockId: null,
          precheckReceiptId: receipt.id,
          category: request.category,
          rule: ruleForDenyReason(decision.reason),
          reason: explanationForDenyReason(decision.reason),
          amountUsd: request.category === 'spend' ? (request.amount_usd ?? null) : null,
          count: request.category === 'publish' ? 1 : null,
          createdAt: now,
        });
      }

      return Promise.resolve({
        response: {
          precheck_id: receipt.id,
          decision: receipt.decision,
          remaining: decision.remaining,
          ...(decision.reason === undefined ? {} : { reason: decision.reason }),
        },
        replayed: false,
      });
    },
  };
}
