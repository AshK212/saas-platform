import { randomUUID } from 'node:crypto';

/**
 * Identity generation for the reference client.
 *
 * ─── TWO IDENTITIES, TWO DIFFERENT RULES ──────────────────────────────────
 *
 * `action_id` is the precheck idempotency key. `event_id` is the ingest
 * idempotency key. Both are client-supplied, and the server treats each as
 * IMMUTABLE once it has decided or stored under it. That makes when to reuse
 * an id, and when not to, a correctness question rather than a style one.
 *
 *   REUSE the same id when retrying an uncertain request. A lost HTTP
 *   response does not mean the server did nothing. Retrying with a fresh id
 *   turns "did my $4 spend land?" into a second $4 spend.
 *
 *   NEW id for a genuinely new attempt. After an operator raises a cap, the
 *   retry is a NEW action: the original `action_id` already has a durable
 *   denial receipt, and Step 15 correctly replays that denial forever. Reusing
 *   it would make a raised cap look like it had not taken effect.
 *
 * Those two rules pull in opposite directions, which is exactly why they live
 * here with the reasoning attached rather than being decided at each call site.
 *
 * ─── DETERMINISM ──────────────────────────────────────────────────────────
 *
 * Ids are derived from a RUN ID, so a test can pin the run and predict every
 * id, while a real run gets a fresh namespace and cannot collide with a
 * previous one.
 */

/** A short, URL-safe, collision-resistant run namespace. */
export function newRunId(): string {
  // A UUID's first block is 32 bits of randomness - ample to separate runs,
  // and short enough to stay readable in a terminal and in an audit trail.
  return randomUUID().slice(0, 8);
}

export interface IdFactory {
  /** The namespace every id in this run shares. */
  readonly runId: string;
  /**
   * An id for a NEW governed action.
   *
   * @param label - what the action is, so a receipt is legible in the audit.
   * @param ordinal - distinguishes repeats within one scenario.
   */
  actionId(label: string, ordinal: number): string;
  /** An id for a NEW event. */
  eventId(label: string, ordinal: number): string;
}

export function createIdFactory(runId: string = newRunId()): IdFactory {
  return {
    runId,
    actionId: (label, ordinal) => `act-${runId}-${label}-${String(ordinal)}`,
    eventId: (label, ordinal) => `evt-${runId}-${label}-${String(ordinal)}`,
  };
}
