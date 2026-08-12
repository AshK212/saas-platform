/**
 * Minimal, vendor-neutral execution primitives.
 *
 * These types describe *what* a runtime is asked to do and *what* it reports
 * back. They deliberately say nothing about how work is executed, which model
 * or agent framework is used, or how a runtime is hosted.
 */

/** Opaque identifier issued by the control plane, never by a runtime. */
export type SessionId = string & { readonly __brand: 'SessionId' };

/** Opaque identifier issued by the control plane, never by a runtime. */
export type TaskId = string & { readonly __brand: 'TaskId' };

/**
 * Workspace scope. Every session is bound to exactly one workspace; the
 * workspace boundary is mandatory and is enforced by the control plane.
 */
export type WorkspaceId = string & { readonly __brand: 'WorkspaceId' };

/**
 * A unit of execution handed to a runtime adapter.
 *
 * A task carries no authority of its own. It is a request to perform work that
 * the control plane has already authorised.
 */
export interface Task {
  readonly id: TaskId;
  readonly sessionId: SessionId;
  /** Runtime-agnostic description of the work requested. */
  readonly instruction: string;
  /**
   * Opaque, runtime-interpreted parameters. Kept as `unknown` so the core never
   * grows vendor-shaped fields; adapters validate their own input.
   */
  readonly input?: unknown;
}

/** Terminal and non-terminal states a task may report. */
export type TaskStatus = 'pending' | 'running' | 'succeeded' | 'failed' | 'cancelled';

/**
 * What a runtime reports after (or during) execution.
 *
 * Note there is no field through which a runtime can assert a spend amount,
 * a policy decision, or a governance outcome. Authoritative accounting is
 * derived by the control plane, not claimed by the runtime.
 */
export interface TaskResult {
  readonly taskId: TaskId;
  readonly status: TaskStatus;
  /** Opaque runtime output. Interpreted by the caller, not by this package. */
  readonly output?: unknown;
  /** Human-readable failure reason when `status` is `failed`. */
  readonly error?: string;
}

/**
 * A bounded execution context within a single workspace.
 *
 * Sessions are created by the control plane. A runtime adapter receives a
 * session; it cannot mint one, widen its workspace scope, or extend its life.
 */
export interface Session {
  readonly id: SessionId;
  readonly workspaceId: WorkspaceId;
  /** Identifier of the runtime profile this session was opened against. */
  readonly profileId: string;
}
