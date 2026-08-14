import type { AgentGovernance } from '@hybrid/contracts';
import {
  createAgentRepository,
  createBlockRepository,
  createLedgerRepository,
  createPolicyReadRepository,
  createPrecheckReceiptRepository,
  toUtcAccountingDay,
  type AgentRow,
  type AuditBlockRow,
  type AuditCursor,
  type AuditReceiptRow,
  type WorkspaceScope,
  type BlockCursor,
  type DatabaseClient,
} from '@hybrid/db';

/**
 * Read-side persistence port for operator governance visibility (Step 17).
 *
 * ─── READ-ONLY, WITHOUT EXCEPTION ─────────────────────────────────────────
 *
 * Nothing here writes. Displaying governance state must not:
 *
 *   - lock the ledger. `findDailyLedger` is used, never `lockDailyLedger`;
 *     taking a row lock to render a number would serialize the whole fleet
 *     view against live enforcement.
 *   - create today's ledger row. A workspace whose operator opened a dashboard
 *     must not thereby acquire accounting rows for agents that did nothing.
 *     Absent usage is computed as zero at read time, never persisted.
 *   - create a policy override, bump a version, refresh last-seen, or write a
 *     receipt or block.
 *
 * Guardrail tests enforce each of those.
 *
 * ─── USAGE COMES FROM THE LEDGER, NOT FROM EVENTS ─────────────────────────
 *
 * `spend.recorded` events still do NOT debit the authoritative ledger. Summing
 * them here would show the operator a number the plane does not enforce
 * against - the two would diverge silently, and the dashboard would be
 * confidently wrong. Today's usage is read from `ledger_daily` and nowhere
 * else.
 */

/** An agent plus its live governance state, for the fleet roster. */
export interface FleetAgent {
  readonly agent: AgentRow;
  readonly governance: AgentGovernance;
}

export interface ReceiptPage {
  readonly receipts: readonly AuditReceiptRow[];
  readonly nextCursor: AuditCursor | null;
}

export interface BlockPage {
  readonly blocks: readonly AuditBlockRow[];
  readonly nextCursor: BlockCursor | null;
}

export interface ReceiptQueryOptions {
  readonly limit: number;
  /** EXTERNAL agent id as the operator chose it. Resolved inside the scope. */
  readonly agentExternalId?: string | undefined;
  readonly decision?: 'allow' | 'deny' | undefined;
  readonly cursor?: AuditCursor | undefined;
}

export interface BlockQueryOptions {
  readonly limit: number;
  readonly agentExternalId?: string | undefined;
  readonly source?: 'plane' | 'runtime' | undefined;
  readonly cursor?: BlockCursor | undefined;
}

export interface GovernanceReadStore {
  /**
   * The agent roster with each agent's effective policy and today's usage.
   *
   * @param now - SERVER time. The UTC accounting day derives from it, never
   *   from a browser clock: a caller in another zone must not be shown a
   *   different day's usage than the plane enforces against.
   */
  listFleet(scope: WorkspaceScope, now: Date): Promise<FleetAgent[]>;

  listReceipts(
    scope: WorkspaceScope,
    options: ReceiptQueryOptions,
  ): Promise<ReceiptPage>;

  /** Null when the receipt is not in this workspace. */
  findReceipt(
    scope: WorkspaceScope,
    receiptId: string,
  ): Promise<AuditReceiptRow | null>;

  listBlocks(scope: WorkspaceScope, options: BlockQueryOptions): Promise<BlockPage>;

  /** Null when the block is not in this workspace. */
  findBlock(scope: WorkspaceScope, blockId: string): Promise<AuditBlockRow | null>;
}

/** Usage for an agent with no ledger row today. Computed, never written. */
const NO_USAGE = { spendCommittedUsd: '0.000000', publishCountCommitted: 0 } as const;

export function createDrizzleGovernanceReadStore(db: DatabaseClient): GovernanceReadStore {
  /**
   * Resolves an external agent id inside the authorized workspace.
   *
   * @returns the internal uuid, or null when this workspace has no such agent.
   *   A caller must treat null as "empty result", not as an error: reporting
   *   404 would reveal whether the id exists in some other tenant.
   */
  async function resolveAgent(
    scope: WorkspaceScope,
    externalId: string,
  ): Promise<string | null> {
    const agent = await createAgentRepository(db, scope).findByExternalId(externalId);
    return agent?.id ?? null;
  }

  return {
    async listFleet(scope: WorkspaceScope, now: Date): Promise<FleetAgent[]> {
      // ONE server clock reading for the whole roster, so every row reports
      // the same accounting day even if the request straddles UTC midnight.
      const day = toUtcAccountingDay(now);

      const policyRepository = createPolicyReadRepository(db, scope);
      const ledgerRepository = createLedgerRepository(db, scope);

      const [agents, policies] = await Promise.all([
        createAgentRepository(db, scope).listAll(),
        // The Step 12 effective-policy read: explicit row where one exists,
        // otherwise the documented defaults. Reused rather than reimplemented,
        // so the fleet view and the polling agent can never disagree.
        policyRepository.listEffectivePolicies(),
      ]);

      const policyByAgent = new Map(policies.map((row) => [row.id, row]));

      return Promise.all(
        agents.map(async (agent) => {
          const policy = policyByAgent.get(agent.id);
          // READ, never lock, never create.
          const usage = (await ledgerRepository.findDailyLedger(agent.id, day)) ?? NO_USAGE;

          return {
            agent,
            governance: {
              mode: policy?.mode ?? 'watch',
              dailySpendCapUsd: policy?.dailySpendCapUsd ?? null,
              dailyPublishCap: policy?.dailyPublishCap ?? null,
              spendCommittedUsd: usage.spendCommittedUsd,
              publishCountCommitted: usage.publishCountCommitted,
              accountingDay: day,
            },
          };
        }),
      );
    },

    async listReceipts(
      scope: WorkspaceScope,
      options: ReceiptQueryOptions,
    ): Promise<ReceiptPage> {
      let agentId: string | undefined;
      if (options.agentExternalId !== undefined) {
        const resolved = await resolveAgent(scope, options.agentExternalId);
        if (resolved === null) {
          // An id this workspace does not have yields an empty page, exactly
          // like an agent that exists but has no decisions.
          return { receipts: [], nextCursor: null };
        }
        agentId = resolved;
      }

      // One extra row is the page-boundary probe. A count would be a second
      // scan for information the client does not need.
      const rows = await createPrecheckReceiptRepository(db, scope).listAudit({
        limit: options.limit + 1,
        agentId,
        decision: options.decision,
        cursor: options.cursor,
      });

      const hasMore = rows.length > options.limit;
      const receipts = hasMore ? rows.slice(0, options.limit) : rows;
      const last = receipts.at(-1);

      return {
        receipts,
        nextCursor:
          hasMore && last !== undefined ? { createdAt: last.createdAt, id: last.id } : null,
      };
    },

    async findReceipt(
      scope: WorkspaceScope,
      receiptId: string,
    ): Promise<AuditReceiptRow | null> {
      return createPrecheckReceiptRepository(db, scope).findAuditById(receiptId);
    },

    async listBlocks(
      scope: WorkspaceScope,
      options: BlockQueryOptions,
    ): Promise<BlockPage> {
      let agentId: string | undefined;
      if (options.agentExternalId !== undefined) {
        const resolved = await resolveAgent(scope, options.agentExternalId);
        if (resolved === null) {
          return { blocks: [], nextCursor: null };
        }
        agentId = resolved;
      }

      const rows = await createBlockRepository(db, scope).listAudit({
        limit: options.limit + 1,
        agentId,
        source: options.source,
        cursor: options.cursor,
      });

      const hasMore = rows.length > options.limit;
      const blocks = hasMore ? rows.slice(0, options.limit) : rows;
      const last = blocks.at(-1);

      return {
        blocks,
        nextCursor:
          hasMore && last !== undefined ? { createdAt: last.createdAt, id: last.id } : null,
      };
    },

    async findBlock(
      scope: WorkspaceScope,
      blockId: string,
    ): Promise<AuditBlockRow | null> {
      return createBlockRepository(db, scope).findAuditById(blockId);
    },
  };
}
