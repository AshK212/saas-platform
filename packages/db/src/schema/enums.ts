import { pgEnum } from 'drizzle-orm/pg-core';

/**
 * Shared PostgreSQL enum types.
 *
 * Enums are used for closed vocabularies that the control plane owns, so an
 * invalid state is rejected by the database rather than only by application
 * validation.
 *
 * Extending a vocabulary later requires a migration (`ALTER TYPE … ADD VALUE`).
 * That cost is deliberate for governance-critical states. Note it cannot run
 * inside the same transaction that then uses the new value, so such a change
 * must be its own migration.
 *
 * Event *payloads* are deliberately NOT constrained this way - see `events.ts`,
 * where the payload is open `jsonb` so forward-compatible events remain
 * possible.
 */

/** Workspace membership role. Deliberately minimal - not an RBAC system. */
export const membershipRole = pgEnum('membership_role', ['operator', 'member']);

/** Governance mode applied to an agent. */
export const agentMode = pgEnum('agent_mode', ['watch', 'budgeted', 'paused']);

/** Baseline event vocabulary the ingest surface must support. */
export const eventType = pgEnum('event_type', [
  'agent.action',
  'spend.recorded',
  'action.blocked',
  'heartbeat',
]);

/** Category of an agent action, used for policy and precheck routing. */
export const actionCategory = pgEnum('action_category', [
  'llm_call',
  'tool_call',
  'spend',
  'publish',
  'other',
]);

/** Outcome of a precheck decision. */
export const precheckDecision = pgEnum('precheck_decision', ['allow', 'deny']);

/**
 * Who denied an action.
 *
 * `plane` denials are authoritative and are recorded by the control plane in
 * the same transaction as the denying receipt. `runtime` denials are reported
 * by a client or adapter and are recorded as received.
 */
export const blockSource = pgEnum('block_source', ['plane', 'runtime']);

/** Lifecycle of a runtime session. */
export const sessionStatus = pgEnum('session_status', ['open', 'closed']);

/** Lifecycle of a runtime task. Mirrors `TaskStatus` in @hybrid/runtime-core. */
export const taskStatus = pgEnum('task_status', [
  'pending',
  'running',
  'succeeded',
  'failed',
  'cancelled',
]);
