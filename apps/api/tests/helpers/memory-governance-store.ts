import { randomUUID } from 'node:crypto';

import type { AgentMode } from '@hybrid/contracts';
import {
  toUtcAccountingDay,
  type AuditBlockRow,
  type AuditReceiptRow,
  type WorkspaceScope,
} from '@hybrid/db';

import type {
  BlockPage,
  BlockQueryOptions,
  FleetAgent,
  GovernanceReadStore,
  ReceiptPage,
  ReceiptQueryOptions,
} from '../../src/governance/read-store';

/**
 * In-memory `GovernanceReadStore` mirroring the production read algorithm.
 *
 * Reproduces the semantics that matter: workspace scoping on every read,
 * effective-policy defaults, today's usage read from the ledger (never
 * aggregated from events), `created_at DESC, id DESC` ordering with a
 * `(created_at, id)` cursor, limit+1 page probing, and agent filters resolved
 * INSIDE the workspace.
 *
 * IT IS ALSO WRITE-FREE BY CONSTRUCTION. There is no method that creates a
 * ledger row, a policy row, a receipt or a block - so a test cannot
 * accidentally demonstrate a write path the read surface does not have.
 * Seeding happens through explicit `seed*` helpers standing in for the steps
 * that legitimately write.
 *
 * WHAT IT CANNOT PROVE
 * --------------------
 * That the emitted SQL carries the workspace predicate, that PostgreSQL orders
 * a row-value cursor the way this does, or that a read genuinely creates no
 * row. Those are `packages/db/tests/governance.test.ts` (compiled SQL) and
 * `packages/db/tests/governance.live.test.ts` (real PostgreSQL, skipped
 * without `TEST_DATABASE_URL`).
 */

interface SeedAgent {
  readonly workspaceId: string;
  readonly id: string;
  readonly externalId: string;
  readonly displayName?: string | null;
  readonly lastSeenAt?: Date | null;
}

interface SeedPolicy {
  readonly workspaceId: string;
  readonly agentId: string;
  readonly mode: AgentMode;
  readonly dailySpendCapUsd: string | null;
  readonly dailyPublishCap: number | null;
}

interface SeedLedger {
  readonly workspaceId: string;
  readonly agentId: string;
  readonly day: string;
  readonly spendCommittedUsd: string;
  readonly publishCountCommitted: number;
}

export interface SeedReceipt {
  readonly workspaceId: string;
  readonly agentId: string;
  readonly actionId: string;
  readonly category: AuditReceiptRow['category'];
  readonly decision: 'allow' | 'deny';
  readonly denyReason?: string | null;
  readonly policyVersion?: string;
  readonly appliedMode?: AgentMode;
  readonly appliedSpendCapUsd?: string | null;
  readonly appliedPublishCap?: number | null;
  readonly requestedAmountUsd?: string | null;
  readonly requestedPublishCount?: number | null;
  readonly ledgerSpendBeforeUsd?: string | null;
  readonly ledgerPublishBefore?: number | null;
  readonly remainingSpendUsd?: string | null;
  readonly remainingPublishCount?: number | null;
  readonly accountingDay?: string;
  readonly createdAt: Date;
}

export interface SeedBlock {
  readonly workspaceId: string;
  readonly agentId: string;
  readonly source: 'plane' | 'runtime';
  readonly category: AuditBlockRow['category'];
  readonly rule: string;
  readonly reason: string;
  readonly externalBlockId?: string | null;
  readonly precheckReceiptId?: string | null;
  readonly amountUsd?: string | null;
  readonly count?: number | null;
  readonly createdAt: Date;
}

export interface MemoryGovernanceStore extends GovernanceReadStore {
  seedAgent(agent: SeedAgent): void;
  seedPolicy(policy: SeedPolicy): void;
  seedLedger(ledger: SeedLedger): void;
  seedReceipt(receipt: SeedReceipt): string;
  seedBlock(block: SeedBlock): string;
  /** Everything the store holds, for asserting a read wrote nothing. */
  snapshot(): string;
}

export function createMemoryGovernanceStore(): MemoryGovernanceStore {
  const agents: SeedAgent[] = [];
  const policies: SeedPolicy[] = [];
  const ledger: SeedLedger[] = [];
  const receipts: (SeedReceipt & { id: string })[] = [];
  const blocks: (SeedBlock & { id: string })[] = [];

  function agentIn(workspaceId: string, agentId: string): SeedAgent | undefined {
    return agents.find((a) => a.workspaceId === workspaceId && a.id === agentId);
  }

  function agentRef(workspaceId: string, agentId: string): AuditReceiptRow['agent'] {
    const agent = agentIn(workspaceId, agentId);
    return {
      id: agentId,
      externalId: agent?.externalId ?? 'unknown',
      displayName: agent?.displayName ?? null,
    };
  }

  /** Resolves an external id inside the workspace only. */
  function resolveExternal(workspaceId: string, externalId: string): string | null {
    return agents.find((a) => a.workspaceId === workspaceId && a.externalId === externalId)?.id
      ?? null;
  }

  /** The shared `created_at DESC, id DESC` boundary. */
  function beforeCursor(
    row: { createdAt: Date; id: string },
    cursor: { createdAt: Date; id: string } | undefined,
  ): boolean {
    if (cursor === undefined) return true;
    const at = row.createdAt.getTime();
    const boundary = cursor.createdAt.getTime();
    if (at !== boundary) return at < boundary;
    return row.id < cursor.id;
  }

  function newestFirst(
    a: { createdAt: Date; id: string },
    b: { createdAt: Date; id: string },
  ): number {
    const delta = b.createdAt.getTime() - a.createdAt.getTime();
    if (delta !== 0) return delta;
    return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
  }

  return {
    seedAgent(agent: SeedAgent): void {
      agents.push(agent);
    },
    seedPolicy(policy: SeedPolicy): void {
      policies.push(policy);
    },
    seedLedger(row: SeedLedger): void {
      ledger.push(row);
    },
    seedReceipt(receipt: SeedReceipt): string {
      const id = randomUUID();
      receipts.push({ ...receipt, id });
      return id;
    },
    seedBlock(block: SeedBlock): string {
      const id = randomUUID();
      blocks.push({ ...block, id });
      return id;
    },
    snapshot(): string {
      return JSON.stringify({ agents, policies, ledger, receipts, blocks });
    },

    listFleet(scope: WorkspaceScope, now: Date): Promise<FleetAgent[]> {
      const workspaceId = scope.workspaceId;
      // ONE server clock reading for the whole roster.
      const day = toUtcAccountingDay(now);

      const fleet = agents
        .filter((a) => a.workspaceId === workspaceId)
        .map((agent) => {
          const policy = policies.find(
            (p) => p.workspaceId === workspaceId && p.agentId === agent.id,
          );
          // READ only. No row is created when none exists.
          const usage = ledger.find(
            (l) => l.workspaceId === workspaceId && l.agentId === agent.id && l.day === day,
          );

          return {
            agent: {
              id: agent.id,
              workspaceId,
              externalId: agent.externalId,
              displayName: agent.displayName ?? null,
              lastSeenAt: agent.lastSeenAt ?? null,
              createdAt: new Date('2026-01-01T00:00:00.000Z'),
            } as FleetAgent['agent'],
            governance: {
              // Step 12 defaults when no explicit row exists.
              mode: policy?.mode ?? ('watch' as const),
              dailySpendCapUsd: policy?.dailySpendCapUsd ?? null,
              dailyPublishCap: policy?.dailyPublishCap ?? null,
              spendCommittedUsd: usage?.spendCommittedUsd ?? '0.000000',
              publishCountCommitted: usage?.publishCountCommitted ?? 0,
              accountingDay: day,
            },
          };
        });

      return Promise.resolve(fleet);
    },

    listReceipts(
      scope: WorkspaceScope,
      options: ReceiptQueryOptions,
    ): Promise<ReceiptPage> {
      const workspaceId = scope.workspaceId;

      let agentId: string | undefined;
      if (options.agentExternalId !== undefined) {
        const resolved = resolveExternal(workspaceId, options.agentExternalId);
        if (resolved === null) {
          return Promise.resolve({ receipts: [], nextCursor: null });
        }
        agentId = resolved;
      }

      const ordered = receipts
        .filter((r) => r.workspaceId === workspaceId)
        .filter((r) => agentId === undefined || r.agentId === agentId)
        .filter((r) => options.decision === undefined || r.decision === options.decision)
        .filter((r) => beforeCursor(r, options.cursor))
        .sort(newestFirst);

      const window = ordered.slice(0, options.limit + 1);
      const hasMore = window.length > options.limit;
      const page = hasMore ? window.slice(0, options.limit) : window;
      const last = page.at(-1);

      const rows: AuditReceiptRow[] = page.map((r) => {
        const block = blocks.find((b) => b.precheckReceiptId === r.id);
        return {
          id: r.id,
          actionId: r.actionId,
          agentId: r.agentId,
          category: r.category,
          decision: r.decision,
          policyVersion: r.policyVersion ?? '1',
          appliedMode: r.appliedMode ?? 'watch',
          appliedSpendCapUsd: r.appliedSpendCapUsd ?? null,
          appliedPublishCap: r.appliedPublishCap ?? null,
          requestedAmountUsd: r.requestedAmountUsd ?? null,
          requestedPublishCount: r.requestedPublishCount ?? null,
          remainingSpendUsd: r.remainingSpendUsd ?? null,
          remainingPublishCount: r.remainingPublishCount ?? null,
          denyReason: r.denyReason ?? null,
          accountingDay: r.accountingDay ?? '2026-08-14',
          ledgerSpendBeforeUsd: r.ledgerSpendBeforeUsd ?? null,
          ledgerPublishBefore: r.ledgerPublishBefore ?? null,
          createdAt: r.createdAt,
          agent: agentRef(workspaceId, r.agentId),
          block: block === undefined ? null : { id: block.id, rule: block.rule },
        };
      });

      return Promise.resolve({
        receipts: rows,
        nextCursor:
          hasMore && last !== undefined ? { createdAt: last.createdAt, id: last.id } : null,
      });
    },

    async findReceipt(
      scope: WorkspaceScope,
      receiptId: string,
    ): Promise<AuditReceiptRow | null> {
      // Scoped: another tenant's uuid resolves to null, not to their row.
      const page = await this.listReceipts(scope, { limit: 1_000 });
      return page.receipts.find((r) => r.id === receiptId) ?? null;
    },

    listBlocks(scope: WorkspaceScope, options: BlockQueryOptions): Promise<BlockPage> {
      const workspaceId = scope.workspaceId;

      let agentId: string | undefined;
      if (options.agentExternalId !== undefined) {
        const resolved = resolveExternal(workspaceId, options.agentExternalId);
        if (resolved === null) {
          return Promise.resolve({ blocks: [], nextCursor: null });
        }
        agentId = resolved;
      }

      const ordered = blocks
        .filter((b) => b.workspaceId === workspaceId)
        .filter((b) => agentId === undefined || b.agentId === agentId)
        .filter((b) => options.source === undefined || b.source === options.source)
        .filter((b) => beforeCursor(b, options.cursor))
        .sort(newestFirst);

      const window = ordered.slice(0, options.limit + 1);
      const hasMore = window.length > options.limit;
      const page = hasMore ? window.slice(0, options.limit) : window;
      const last = page.at(-1);

      const rows: AuditBlockRow[] = page.map((b) => ({
        id: b.id,
        source: b.source,
        category: b.category,
        rule: b.rule,
        reason: b.reason,
        externalBlockId: b.externalBlockId ?? null,
        precheckReceiptId: b.precheckReceiptId ?? null,
        amountUsd: b.amountUsd ?? null,
        count: b.count ?? null,
        createdAt: b.createdAt,
        agent: agentRef(workspaceId, b.agentId),
      }));

      return Promise.resolve({
        blocks: rows,
        nextCursor:
          hasMore && last !== undefined ? { createdAt: last.createdAt, id: last.id } : null,
      });
    },

    async findBlock(
      scope: WorkspaceScope,
      blockId: string,
    ): Promise<AuditBlockRow | null> {
      const page = await this.listBlocks(scope, { limit: 1_000 });
      return page.blocks.find((b) => b.id === blockId) ?? null;
    },
  };
}
