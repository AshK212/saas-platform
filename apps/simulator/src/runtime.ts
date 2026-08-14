import type {
  ActionCategory,
  DecimalUsd,
  IngestEvent,
  PrecheckResponse,
} from '@hybrid/contracts';

import type { ControlPlaneClient } from './client.js';
import type { IdFactory } from './ids.js';
import type { Logger } from './logging.js';

/**
 * The simulated runtime: THE HANDS, never the ledger.
 *
 * ─── THE ONE RULE THIS FILE EXISTS TO ENFORCE ─────────────────────────────
 *
 *   THE PLANE IS THE LEDGER; THE PLUGIN IS THE HANDS.
 *
 * This module asks `POST /v1/actions/precheck` and branches on the answer. It
 * does NOT decide anything. There is deliberately no arithmetic here:
 * no `41 > 25`, no publish counter, no "is this agent paused". A guard test
 * asserts the absence.
 *
 * That is not fastidiousness. A client that computes its own verdict is a
 * SECOND governance engine, and two engines drift: the client's copy of the
 * cap goes stale the moment an operator changes it, and the fleet starts
 * acting on policy that no longer exists. Asking costs one round trip and
 * cannot be wrong.
 *
 * ─── WHAT A DENIAL MEANS ──────────────────────────────────────────────────
 *
 * The plane already wrote the receipt AND the plane-owned block, atomically,
 * before it answered. So on a denial this module:
 *
 *   - does not perform the action;
 *   - does not report a spend;
 *   - does NOT emit an `action.blocked` event.
 *
 * That last one is the subtle one. `action.blocked` is for a denial the
 * RUNTIME made on its own account. Emitting one for a plane denial would put
 * two blocks in the audit for one refusal - one owned by the plane, one
 * claiming to be runtime-owned - and an operator could not tell which system
 * actually stopped the work.
 */

/** What the runtime did with one governed action. */
export type ActionOutcome =
  | {
      readonly status: 'allowed';
      readonly actionId: string;
      readonly precheckId: string;
      /** The follow-up audit event, already accepted by the plane. */
      readonly eventId: string;
    }
  | {
      readonly status: 'denied';
      readonly actionId: string;
      readonly precheckId: string;
      /** The plane's machine-readable reason, passed through unchanged. */
      readonly reason: string;
    };

export interface RuntimeDeps {
  readonly client: ControlPlaneClient;
  readonly ids: IdFactory;
  readonly log: Logger;
}

/** Formats the plane's `remaining` for a human, without interpreting it. */
function describeRemaining(response: PrecheckResponse): string {
  if (response.remaining === null) {
    return 'uncapped';
  }
  return response.remaining.kind === 'usd'
    ? `$${response.remaining.value} left`
    : `${String(response.remaining.value)} left`;
}

export function createRuntime(deps: RuntimeDeps) {
  const { client, ids, log } = deps;

  /**
   * Performs one governed SPEND, the correct way.
   *
   * precheck -> allow -> act -> report with `precheck_id`.
   *
   * The follow-up event carries the receipt id, so Step 18 recognises the
   * action as already accounted for and Step 19 does not debit it again. The
   * amount is the EXACT string that was authorized: a mismatch is rejected by
   * the plane, and rightly so - a $4 authorization must not absolve $400.
   */
  async function spend(
    agentId: string,
    amountUsd: DecimalUsd,
    label: string,
    ordinal: number,
  ): Promise<ActionOutcome> {
    const actionId = ids.actionId(label, ordinal);

    const decision = await client.precheck({
      action_id: actionId,
      agent_id: agentId,
      category: 'spend',
      amount_usd: amountUsd,
    });

    if (decision.decision === 'deny') {
      // The plane owns the receipt and the block. Nothing to do but stop.
      log.deny(
        `${agentId} spend $${amountUsd} DENIED (${decision.reason ?? 'no reason given'}) ` +
          `· action ${actionId} · receipt ${decision.precheck_id}`,
      );
      return {
        status: 'denied',
        actionId,
        precheckId: decision.precheck_id,
        reason: decision.reason ?? 'unknown',
      };
    }

    // ... the simulated work happens here ...

    const eventId = ids.eventId(label, ordinal);
    await client.ingestEvents([
      {
        type: 'spend.recorded',
        event_id: eventId,
        agent_id: agentId,
        // EXACTLY what was authorized.
        amount_usd: amountUsd,
        provider: 'simulator',
        precheck_id: decision.precheck_id,
      },
    ]);

    log.ok(
      `${agentId} spend $${amountUsd} allowed (${describeRemaining(decision)}) ` +
        `· receipt ${decision.precheck_id} · event ${eventId}`,
    );
    return { status: 'allowed', actionId, precheckId: decision.precheck_id, eventId };
  }

  /**
   * Performs one governed PUBLISH.
   *
   * One precheck is one publish - the contract carries no count, so a burst is
   * N prechecks with N DISTINCT action ids. Reusing one id would replay the
   * first decision N times and prove nothing.
   */
  async function publish(agentId: string, label: string, ordinal: number): Promise<ActionOutcome> {
    const actionId = ids.actionId(label, ordinal);

    const decision = await client.precheck({
      action_id: actionId,
      agent_id: agentId,
      category: 'publish',
    });

    if (decision.decision === 'deny') {
      log.deny(
        `${agentId} publish DENIED (${decision.reason ?? 'no reason given'}) ` +
          `· action ${actionId} · receipt ${decision.precheck_id}`,
      );
      return {
        status: 'denied',
        actionId,
        precheckId: decision.precheck_id,
        reason: decision.reason ?? 'unknown',
      };
    }

    // A completed publish is an `agent.action` with category `publish`. There
    // is no `publish.recorded` in the vocabulary and inventing one would be a
    // contract change for no reason.
    const eventId = ids.eventId(label, ordinal);
    await client.ingestEvents([
      {
        type: 'agent.action',
        event_id: eventId,
        agent_id: agentId,
        category: 'publish',
        precheck_id: decision.precheck_id,
      },
    ]);

    log.ok(
      `${agentId} publish allowed (${describeRemaining(decision)}) ` +
        `· receipt ${decision.precheck_id} · event ${eventId}`,
    );
    return { status: 'allowed', actionId, precheckId: decision.precheck_id, eventId };
  }

  /**
   * Performs one governed action of an UNTRACKED category.
   *
   * `llm_call`, `tool_call` and `other` still go through precheck, because a
   * paused agent must be stopped in every category - that is what makes pause
   * a kill switch rather than a budget.
   */
  async function act(
    agentId: string,
    category: Exclude<ActionCategory, 'spend' | 'publish'>,
    label: string,
    ordinal: number,
  ): Promise<ActionOutcome> {
    const actionId = ids.actionId(label, ordinal);
    const decision = await client.precheck({
      action_id: actionId,
      agent_id: agentId,
      category,
    });

    if (decision.decision === 'deny') {
      log.deny(
        `${agentId} ${category} DENIED (${decision.reason ?? 'no reason given'}) ` +
          `· action ${actionId}`,
      );
      return {
        status: 'denied',
        actionId,
        precheckId: decision.precheck_id,
        reason: decision.reason ?? 'unknown',
      };
    }

    const eventId = ids.eventId(label, ordinal);
    await client.ingestEvents([
      {
        type: 'agent.action',
        event_id: eventId,
        agent_id: agentId,
        category,
        precheck_id: decision.precheck_id,
      },
    ]);
    log.ok(`${agentId} ${category} allowed · event ${eventId}`);
    return { status: 'allowed', actionId, precheckId: decision.precheck_id, eventId };
  }

  /** A liveness ping. Ungoverned, so no precheck and no `precheck_id`. */
  async function heartbeat(agentId: string, label: string, ordinal: number): Promise<string> {
    const eventId = ids.eventId(label, ordinal);
    await client.ingestEvents([{ type: 'heartbeat', event_id: eventId, agent_id: agentId }]);
    return eventId;
  }

  /**
   * ACCEPTANCE PATH ONLY: reports spend that was never prechecked.
   *
   * This exists to exercise the Step 19 event-side debit, where the event
   * itself is the accounting record. It is deliberately named for what it is
   * and is never used by the normal governed flow.
   *
   * A real runtime should precheck FIRST. Reporting after the fact means the
   * money is already gone: the plane records it truthfully, even past a cap,
   * but nothing had the chance to stop it.
   */
  async function recordUnprecheckedSpend(
    agentId: string,
    amountUsd: DecimalUsd,
    label: string,
    ordinal: number,
  ): Promise<string> {
    const eventId = ids.eventId(label, ordinal);
    await client.ingestEvents([
      {
        type: 'spend.recorded',
        event_id: eventId,
        agent_id: agentId,
        amount_usd: amountUsd,
        provider: 'simulator',
        // NO precheck_id: this is the unprechecked accounting path.
      },
    ]);
    log.info(`${agentId} reported UNPRECHECKED spend $${amountUsd} · event ${eventId}`);
    return eventId;
  }

  /**
   * Reports a denial the RUNTIME made on its own account.
   *
   * Legitimate only when the plane was not involved. Never called after a
   * precheck denial - see the header note.
   */
  async function reportRuntimeBlock(
    agentId: string,
    category: ActionCategory,
    rule: string,
    reason: string,
    label: string,
    ordinal: number,
  ): Promise<string> {
    const eventId = ids.eventId(label, ordinal);
    const event: IngestEvent = {
      type: 'action.blocked',
      event_id: eventId,
      agent_id: agentId,
      category,
      rule,
      reason,
      block_id: `blk-${ids.runId}-${label}-${String(ordinal)}`,
      ...(category === 'spend' ? { amount_usd: '0.000000' as DecimalUsd } : {}),
      ...(category === 'publish' ? { count: 1 } : {}),
    };
    await client.ingestEvents([event]);
    log.info(`${agentId} runtime-side block (${rule}) · event ${eventId}`);
    return eventId;
  }

  return { spend, publish, act, heartbeat, recordUnprecheckedSpend, reportRuntimeBlock };
}

export type Runtime = ReturnType<typeof createRuntime>;
