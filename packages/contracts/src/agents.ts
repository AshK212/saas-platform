import { z } from 'zod';

import { agentGovernanceSchema } from './governance.js';

/**
 * Step 8 agent registry contracts.
 *
 * TWO TRANSPORT STYLES, DELIBERATELY
 * ----------------------------------
 * The MACHINE surface uses snake_case (`agent_id`, `last_seen_at`) because that
 * is the shape the locked Credit requirements specify for agent and event
 * payloads. Keeping it consistent now means the Step 9/10 event contracts slot
 * in without renaming a field agents already send.
 *
 * The OPERATOR surface uses camelCase, matching the workspace and API-key
 * contracts the browser app already consumes.
 *
 * The split is between audiences, not arbitrary: one is an external contract we
 * do not control, the other is our own UI.
 *
 * NAMING NOTE: the transport calls it `agent_id`; the database column is
 * `external_id`. They are the same value. `id` in operator responses is the
 * internal UUID primary key, which is a different thing entirely.
 */

/** Machine registration endpoint. Bearer API key only. */
export const AGENT_REGISTER_PATH = '/v1/agents/register' as const;

/** `/v1/workspaces/:workspaceId/agents` */
export function workspaceAgentsPath(workspaceId: string): string {
  return `/v1/workspaces/${encodeURIComponent(workspaceId)}/agents`;
}

/** `/v1/workspaces/:workspaceId/agents/:agentId` */
export function workspaceAgentPath(workspaceId: string, agentId: string): string {
  return `${workspaceAgentsPath(workspaceId)}/${encodeURIComponent(agentId)}`;
}

/**
 * Machine registration request.
 *
 * There is deliberately NO `workspace_id` field. The workspace comes from the
 * API credential; accepting one here would create the exact bypass Step 7
 * exists to prevent, and a caller would inevitably start sending it.
 *
 * There is also no `last_seen_at`: that is server-authoritative. A client clock
 * may be wrong or dishonest, and last-seen is the basis of AC-04.
 *
 * And no runtime profile, mode, caps or policy - none is machine-owned.
 */
export const registerAgentRequestSchema = z.object({
  /** Stable identifier, unique within the workspace. Maps to `external_id`. */
  agent_id: z.string().trim().min(1, 'An agent id is required.').max(120),
  /** Optional self-reported label. Omitted leaves any existing name intact. */
  name: z.string().trim().min(1).max(120).optional(),
});

export type RegisterAgentRequest = z.infer<typeof registerAgentRequestSchema>;

/** Machine registration response. Echoes server-authoritative state. */
export const registerAgentResponseSchema = z.object({
  agent: z.object({
    agent_id: z.string(),
    name: z.string().nullable(),
    /** Server time at registration, ISO-8601. */
    last_seen_at: z.string(),
  }),
});

export type RegisterAgentResponse = z.infer<typeof registerAgentResponseSchema>;

/**
 * Operator-facing agent metadata.
 *
 * STEP 17 added `governance`: the agent's EFFECTIVE mode and caps plus today's
 * authoritative committed usage. It is optional on the wire so the single-agent
 * lookup, which has no reason to load a ledger row, can omit it - a caller must
 * check for it rather than assume it is always present.
 *
 * It is deliberately a nested object rather than flattened fields: mode, caps
 * and usage are one coherent snapshot taken for one accounting day, and
 * scattering them would invite reading a cap from one request and a total from
 * another.
 */
export const agentSummarySchema = z.object({
  /** Internal UUID. Distinct from the client-supplied `agentId`. */
  id: z.uuid(),
  /** The stable client-supplied identifier (`external_id`). */
  agentId: z.string(),
  name: z.string().nullable(),
  /** Null until the agent first makes contact. */
  lastSeenAt: z.string().nullable(),
  createdAt: z.string(),
  /** Present on the roster; absent on the single-agent lookup. */
  governance: agentGovernanceSchema.optional(),
});

export type AgentSummary = z.infer<typeof agentSummarySchema>;

export const agentListResponseSchema = z.object({
  agents: z.array(agentSummarySchema),
});

export type AgentListResponse = z.infer<typeof agentListResponseSchema>;

export const agentResponseSchema = z.object({
  agent: agentSummarySchema,
});

export type AgentResponse = z.infer<typeof agentResponseSchema>;
