import type { IngestEvent } from '@hybrid/contracts';

import type { ControlPlaneClient } from './client.js';
import {
  BASELINE_SPEND_CYCLE,
  FLEET,
  OVER_CAP_AMOUNT,
  PUBLISH_BURST_SIZE,
} from './fleet.js';
import type { IdFactory } from './ids.js';
import type { Logger } from './logging.js';
import type { Runtime } from './runtime.js';

/**
 * Deterministic acceptance scenarios.
 *
 * ─── WHAT A SCENARIO IS, AND IS NOT ───────────────────────────────────────
 *
 * Each one drives the PUBLIC API through a sequence an operator can watch in
 * the governance UI. None of them asserts an outcome, because the outcome is
 * the plane's to decide - a scenario that expected `deny` would be encoding
 * policy it does not own, and would start failing the moment an operator
 * legitimately changed a cap.
 *
 * So a scenario REPORTS what the plane said and exits non-zero only if it
 * could not complete the conversation at all.
 *
 * ─── OPERATOR SETUP IS A PRECONDITION, NOT A STEP ─────────────────────────
 *
 * Every scenario below documents the policy it expects an operator to have
 * configured. The simulator cannot configure it: policy mutation is an
 * operator route and a machine credential is refused on it. That separation is
 * the product, not a limitation - see docs/simulator.md.
 */

export interface ScenarioDeps {
  readonly client: ControlPlaneClient;
  readonly runtime: Runtime;
  readonly ids: IdFactory;
  readonly log: Logger;
}

export interface ScenarioResult {
  /** True when the conversation completed. NOT "the plane allowed it". */
  readonly completed: boolean;
  /** Events this run submitted, retained verbatim so `replay` can resend. */
  readonly submitted: readonly IngestEvent[];
}

/** Registers the three reference agents. Idempotent on external id. */
export async function registerFleet(deps: ScenarioDeps): Promise<void> {
  const { client, log } = deps;
  log.step('Registering the reference fleet');

  for (const agent of FLEET) {
    const registered = await client.registerAgent(agent.agentId, agent.name);
    // The machine response carries no internal UUID, deliberately: a runtime
    // never needs one, and exposing it would leak database identity.
    log.info(`${agent.agentId} registered · last seen ${registered.agent.last_seen_at}`);
  }
}

/**
 * BASELINE - AC-04, AC-05, AC-06.
 *
 * One pass of realistic three-agent activity: every agent heartbeats, then
 * each does the governed work its role implies. Enough for three agents to
 * show as seen within 60 seconds and for the timeline to have something to
 * drill into.
 */
export async function runBaseline(deps: ScenarioDeps, cycle = 0): Promise<ScenarioResult> {
  const { runtime, log } = deps;
  log.step(`Baseline activity (cycle ${String(cycle)})`);

  for (const agent of FLEET) {
    await runtime.heartbeat(agent.agentId, `hb-${agent.agentId}`, cycle);
  }
  log.info(`${String(FLEET.length)} heartbeats sent`);

  for (const agent of FLEET) {
    switch (agent.role) {
      case 'spender': {
        const amount =
          BASELINE_SPEND_CYCLE[cycle % BASELINE_SPEND_CYCLE.length] ?? BASELINE_SPEND_CYCLE[0];
        if (amount !== undefined) {
          await runtime.spend(agent.agentId, amount, `baseline-spend-${agent.agentId}`, cycle);
        }
        break;
      }
      case 'publisher':
        await runtime.publish(agent.agentId, `baseline-publish-${agent.agentId}`, cycle);
        break;
      case 'worker':
        await runtime.act(agent.agentId, 'llm_call', `baseline-llm-${agent.agentId}`, cycle);
        break;
    }
  }

  return { completed: true, submitted: [] };
}

/**
 * OVER-CAP - AC-08.
 *
 * Operator precondition: agent-a is `budgeted` with a $25 daily spend cap.
 *
 * Attempts $41. The plane denies, and writes the receipt and the plane-owned
 * block itself, in one transaction, before answering. This scenario adds
 * nothing to that record - see the note in `runtime.ts` about why it must not
 * emit an `action.blocked` for a plane denial.
 */
export async function runOverCap(deps: ScenarioDeps, attempt = 0): Promise<ScenarioResult> {
  const { runtime, log } = deps;
  log.step(`Over-cap attempt: agent-a spend $${OVER_CAP_AMOUNT}`);
  log.info('Expects an operator to have set agent-a to budgeted with a $25 daily cap.');

  const outcome = await runtime.spend(
    'agent-a',
    OVER_CAP_AMOUNT,
    'over-cap',
    attempt,
  );

  if (outcome.status === 'denied') {
    log.info('The plane recorded the denial receipt and its block. Nothing was spent.');
  } else {
    log.info(
      'Allowed - so the cap in force permits it. Check the configured policy if a denial was expected.',
    );
  }
  return { completed: true, submitted: [] };
}

/**
 * CAP RAISE - AC-10.
 *
 * Operator precondition: the cap was raised (say to $100) AFTER a denial.
 *
 * ─── THIS USES A NEW ACTION ID, AND THAT IS THE WHOLE POINT ───────────────
 *
 * `action_id` is the precheck idempotency key. The denied attempt has a
 * durable receipt under its id, and Step 15 correctly replays that same
 * denial for that id FOREVER - that is what makes a network retry safe.
 *
 * So retrying after a cap raise with the ORIGINAL id would return the old
 * denial and look exactly like "the raise did not take effect". A retry after
 * a policy change is a NEW ACTION and needs a new identity. The `attempt`
 * ordinal supplies it.
 */
export async function runCapRaiseRetry(deps: ScenarioDeps, attempt = 1): Promise<ScenarioResult> {
  const { runtime, log } = deps;
  log.step(`Cap-raise retry: agent-a spend $${OVER_CAP_AMOUNT} under a NEW action id`);
  log.info('A new action id is required - the denied one replays its denial by design.');

  await runtime.spend('agent-a', OVER_CAP_AMOUNT, 'over-cap', attempt);
  return { completed: true, submitted: [] };
}

/**
 * PUBLISH BURST - AC-11.
 *
 * Operator precondition: agent-b is `budgeted` with a daily publish cap of 5.
 *
 * Six prechecks, six DISTINCT action ids. Stops executing at the first denial:
 * the sixth publish must not happen, and the plane has already recorded why.
 */
export async function runPublishBurst(deps: ScenarioDeps): Promise<ScenarioResult> {
  const { runtime, log } = deps;
  log.step(`Publish burst: ${String(PUBLISH_BURST_SIZE)} attempts by agent-b`);
  log.info('Expects an operator to have set agent-b to budgeted with a publish cap of 5.');

  for (let ordinal = 1; ordinal <= PUBLISH_BURST_SIZE; ordinal += 1) {
    const outcome = await runtime.publish('agent-b', 'burst', ordinal);
    if (outcome.status === 'denied') {
      // STOP. Continuing would be performing work the plane just refused.
      log.info(
        `Stopped at attempt ${String(ordinal)}. The remaining attempts were not performed.`,
      );
      return { completed: true, submitted: [] };
    }
  }

  log.info('All attempts were allowed - check the configured publish cap.');
  return { completed: true, submitted: [] };
}

/**
 * PAUSE PROBE - AC-12.
 *
 * Operator precondition: agent-a is `paused`.
 *
 * Probes an UNTRACKED category, because pause is a kill switch rather than a
 * budget: if `other` still ran while paused, the agent would be "mostly
 * stopped", which is not stopped.
 */
export async function runPauseProbe(deps: ScenarioDeps, attempt = 0): Promise<ScenarioResult> {
  const { runtime, log } = deps;
  log.step('Pause probe: agent-a attempts an untracked action');
  log.info('Expects an operator to have paused agent-a. Pause denies EVERY category.');

  await runtime.act('agent-a', 'other', 'pause-probe', attempt);
  return { completed: true, submitted: [] };
}

/**
 * REPLAY - AC-13.
 *
 * Submits a batch, then submits the IDENTICAL batch again: same event ids,
 * same payloads, no regeneration. The plane must report the second submission
 * as all duplicates and store nothing new.
 *
 * The batch is built ONCE and held, which is the whole mechanism. A scenario
 * that rebuilt it would generate fresh ids and prove the opposite of what
 * AC-13 asks.
 */
export async function runReplay(deps: ScenarioDeps): Promise<ScenarioResult> {
  const { client, ids, log } = deps;
  log.step('Replay: submitting one batch twice, byte-identical');

  // Built once. Every later reference is to THIS array.
  const batch: IngestEvent[] = [
    { type: 'heartbeat', event_id: ids.eventId('replay', 1), agent_id: 'agent-a' },
    {
      type: 'agent.action',
      event_id: ids.eventId('replay', 2),
      agent_id: 'agent-b',
      category: 'llm_call',
    },
    { type: 'heartbeat', event_id: ids.eventId('replay', 3), agent_id: 'agent-c' },
  ];

  const first = await client.ingestEvents(batch);
  log.ok(
    `First submission: accepted ${String(first.accepted)}, duplicates ${String(first.duplicates)}`,
  );

  const second = await client.ingestEvents(batch);
  log.ok(
    `Replay: accepted ${String(second.accepted)}, duplicates ${String(second.duplicates)}`,
  );

  if (second.accepted === 0 && second.duplicates === batch.length) {
    log.info('Idempotent: the replay stored nothing and the event count is unchanged.');
  } else {
    log.warn('The replay was not reported as a pure duplicate. Inspect the timeline count.');
  }

  return { completed: true, submitted: batch };
}

/**
 * UNPRECHECKED SPEND - Step 19 accounting path.
 *
 * Reports spend with NO `precheck_id`, so the event itself is the accounting
 * record and debits the ledger exactly once.
 *
 * Deliberately a separate, explicitly named scenario. A runtime should
 * precheck FIRST; by the time an unprechecked report arrives, the money is
 * already gone and nothing had the chance to stop it.
 */
export async function runUnprecheckedSpend(deps: ScenarioDeps): Promise<ScenarioResult> {
  const { runtime, log } = deps;
  log.step('Unprechecked spend: agent-c reports $1.500000 after the fact');
  log.info('The event IS the accounting record here. Nothing authorized it in advance.');

  await runtime.recordUnprecheckedSpend('agent-c', '1.500000', 'unprechecked', 0);
  return { completed: true, submitted: [] };
}
