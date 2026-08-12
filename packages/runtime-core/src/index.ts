/**
 * @hybrid/runtime-core - vendor-neutral runtime boundary.
 *
 * PURPOSE
 * -------
 * This package exists to make runtime implementations *replaceable*. It defines
 * the smallest set of concepts the control plane needs in order to hand work to
 * some runtime, without knowing or caring which runtime that is.
 *
 * THE PLANE IS THE LEDGER; THE PLUGIN IS THE HANDS.
 *
 * Governance remains owned by the control plane. Runtime adapters execute work
 * but must not own or bypass authoritative governance state.
 *
 * STEP 1 SCOPE - TYPES ONLY
 * -------------------------
 * Deliberately NOT implemented here, now or as part of the Credit phase:
 *   - Hermes adapter, OpenClaw adapter, or any other concrete adapter
 *   - routing, delegation or scheduling
 *   - memory, skills or tool systems
 *   - autonomous orchestration or an execution engine
 *   - any persistent orchestration behaviour
 *
 * This package has zero runtime dependencies and must stay that way.
 */

export type { RuntimeAdapter, RuntimeProfile } from './adapter.js';
export type {
  Session,
  SessionId,
  Task,
  TaskId,
  TaskResult,
  TaskStatus,
  WorkspaceId,
} from './session.js';

/**
 * Revision of the runtime boundary contract. Any breaking change to
 * `RuntimeAdapter` must bump this so adapters can assert compatibility.
 */
export const RUNTIME_CORE_CONTRACT_VERSION = '0.1.0' as const;
