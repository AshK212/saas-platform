import { z } from 'zod';

import { decimalUsdSchema } from './events.js';

/**
 * Step 12 policy polling contracts.
 *
 * MACHINE SURFACE, snake_case
 * ---------------------------
 * This is an agent/runtime path polled roughly every 30 seconds with a
 * workspace API key, so it follows the same external convention as the event
 * ingest contract rather than the camelCase operator surface.
 *
 * READ-ONLY
 * ---------
 * Nothing here describes a mutation. There is no request body, no mode setter
 * and no cap setter - operator policy mutation is Step 13. A polling contract
 * that could express a change would be the first step toward a runtime editing
 * its own governance.
 */

/**
 * Machine policy polling endpoint.
 *
 * Deliberately WORKSPACE-LESS. The credential identifies the workspace, so
 * there is no path segment for a caller to point elsewhere. The operator-facing
 * `/v1/workspaces/:id/policy` route does not exist and belongs to Step 13.
 */
export const POLICY_POLL_PATH = '/v1/policy' as const;

export const POLICY_SINCE_VERSION_PARAM = 'since_version' as const;

/** The locked agent mode vocabulary. Identical to the `agent_mode` PG enum. */
export const agentModeSchema = z.enum(['watch', 'budgeted', 'paused']);

export type AgentMode = z.infer<typeof agentModeSchema>;

/**
 * The mode an agent has when no explicit policy row exists.
 *
 * `watch` means observe and record, enforce nothing. It is the only safe
 * default: `budgeted` would apply caps nobody configured, and `paused` would
 * halt an agent the operator never chose to stop.
 */
export const DEFAULT_AGENT_MODE = 'watch' as const;

/**
 * Policy version as a decimal integer STRING.
 *
 * The column is a PostgreSQL `bigint`. Serialising it as a JSON number would
 * mean a silent precision loss above 2^53 - the same class of defect the money
 * contract already rejects floats for. A version is compared for equality and
 * ordering, never arithmetic, so a string costs nothing.
 *
 * `since_version` uses this exact same domain, so caller and server can never
 * be comparing different representations of the same value.
 */
const versionStringSchema = z
  .string()
  .regex(/^(?:0|[1-9][0-9]{0,18})$/, 'Version must be a non-negative decimal integer.');

export const policyVersionSchema = versionStringSchema;

/**
 * Polling query.
 *
 * STRICT: an unknown parameter is a hard error rather than being ignored. That
 * is what makes `?workspace_id=...` a 400 instead of a field a future
 * maintainer might one day decide to read. The ONLY query authority is
 * `since_version`; tenancy comes from the credential.
 *
 * `0` is accepted and always yields a snapshot, because the initial version is
 * 1 - it is the natural "I have nothing yet" value.
 */
export const policyPollQuerySchema = z.strictObject({
  [POLICY_SINCE_VERSION_PARAM]: versionStringSchema.optional(),
});

export type PolicyPollQuery = z.infer<typeof policyPollQuerySchema>;

/**
 * One agent's effective policy.
 *
 * "Effective" means: the explicit `agent_policies` row if one exists, otherwise
 * the deterministic default. An agent that has never been configured still
 * appears here with a real policy - the snapshot is never partial.
 */
export const effectiveAgentPolicySchema = z.strictObject({
  /** EXTERNAL machine-facing id (`agents.external_id`), never the internal UUID. */
  agent_id: z.string(),
  mode: agentModeSchema,
  /** Decimal string, or null for UNCAPPED. Never 0 as a stand-in for absent. */
  daily_spend_cap_usd: decimalUsdSchema.nullable(),
  /** Non-negative integer, or null for UNCAPPED. */
  daily_publish_cap: z.number().int().min(0).nullable(),
});

export type EffectiveAgentPolicy = z.infer<typeof effectiveAgentPolicySchema>;

/**
 * The authoritative policy snapshot for one workspace.
 *
 * A SNAPSHOT, NOT A COMMAND SET. It describes current state; it does not tell
 * the runtime what to do. The runtime decides how to apply it.
 *
 * A workspace with no agents returns `{ version, agents: [] }`. That is a valid
 * snapshot, not an empty policy: the version is always present and always >= 1.
 * No agent is ever fabricated to avoid an empty array.
 */
export const policySnapshotSchema = z.strictObject({
  version: policyVersionSchema,
  agents: z.array(effectiveAgentPolicySchema),
});

export type PolicySnapshot = z.infer<typeof policySnapshotSchema>;

/** Safe error body for a rejected poll. Carries no schema internals. */
export const policyErrorSchema = z.strictObject({
  error: z.enum(['invalid_query', 'unauthorized', 'policy_unavailable', 'internal_error']),
});

export type PolicyError = z.infer<typeof policyErrorSchema>;
