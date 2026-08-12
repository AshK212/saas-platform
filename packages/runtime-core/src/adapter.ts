import type { Session, Task, TaskResult, WorkspaceId } from './session.js';

/**
 * Declarative description of a runtime implementation.
 *
 * A profile is descriptive metadata, not configuration authority. Registering a
 * profile does not grant a runtime any governance capability.
 */
export interface RuntimeProfile {
  /** Stable identifier, e.g. `local-dev`, `hosted-default`. */
  readonly id: string;
  /** Human-readable label for operator surfaces. */
  readonly displayName: string;
  /**
   * Free-form capability tags an adapter claims to support. Intentionally
   * untyped strings so this package never has to name a specific vendor.
   */
  readonly capabilities: readonly string[];
}

/**
 * The single seam between the control plane and any runtime implementation.
 *
 * GOVERNANCE INVARIANT
 * --------------------
 * Governance remains owned by the control plane. Runtime adapters execute work
 * but must not own or bypass authoritative governance state.
 *
 * Concretely, an adapter MUST NOT:
 *   - read, write or cache policy, budget, cap or pause state;
 *   - decide whether an action is permitted (it may only be told to execute);
 *   - write to the ledger, or emit receipts, blocks or audit records;
 *   - cross a workspace boundary, or infer one it was not given;
 *   - persist authoritative state of any kind.
 *
 * An adapter is the hands. The control plane is the ledger.
 *
 * VENDOR NEUTRALITY
 * -----------------
 * This interface must never reference Hermes, OpenClaw, Ollama, or any specific
 * agent framework or vendor SDK. Adding a vendor type here breaks the
 * replaceability guarantee this package exists to provide.
 */
export interface RuntimeAdapter {
  /** The profile this adapter implements. */
  readonly profile: RuntimeProfile;

  /**
   * Opens an execution context inside an already-authorised workspace.
   *
   * The control plane supplies the workspace; the adapter never chooses it.
   */
  openSession(workspaceId: WorkspaceId): Promise<Session>;

  /** Executes a single authorised task and reports the outcome. */
  execute(session: Session, task: Task): Promise<TaskResult>;

  /** Releases any resources held for the session. Must be idempotent. */
  closeSession(session: Session): Promise<void>;
}
