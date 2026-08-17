import { EVENT_INGEST_PATH, PRECHECK_PATH } from '@hybrid/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createControlPlaneClient } from '../src/client';
import { runDemoGenerator, readIntervalMs, MIN_BLOCK_INTERVAL_MS } from '../src/demo-generator';
import { createIdFactory } from '../src/ids';
import { createLogger } from '../src/logging';
import { createRuntime } from '../src/runtime';
import { registerFleet, type ScenarioDeps } from '../src/scenarios';
import { startFakeControlPlane, type FakeControlPlane } from './helpers/fake-control-plane';

/**
 * The AC-19 demo generator, driven over a REAL HTTP socket.
 *
 * The property under test is the one that fails silently: that each recurring
 * block attempt is a genuinely NEW action. Reusing an `action_id` would make
 * the plane replay its first decision forever - no new receipt, no new block -
 * and everything would still look like it was working.
 */

const API_KEY = 'hmp_live_TESTKEYvalue0000000000000000000';

let plane: FakeControlPlane;
let lines: string[];
let deps: ScenarioDeps;
let controller: AbortController;

beforeEach(async () => {
  plane = await startFakeControlPlane();
  lines = [];
  const log = createLogger(
    (line) => lines.push(line),
    (line) => lines.push(line),
  );
  const client = createControlPlaneClient({
    baseUrl: plane.url,
    apiKey: API_KEY,
    timeoutMs: 2_000,
    sleep: () => Promise.resolve(),
  });
  const ids = createIdFactory('demorun');
  deps = { client, runtime: createRuntime({ client, ids, log }), ids, log };
  controller = new AbortController();
});

afterEach(async () => {
  controller.abort();
  await plane.close();
});

/** No real waiting: the loop's delay is injected. */
const instantly = (): Promise<void> => Promise.resolve();

const output = (): string => lines.join('\n');

/** Every precheck body the generator sent. */
function prechecks(): { action_id: string; category: string; amount_usd?: string }[] {
  return plane
    .requestsTo(PRECHECK_PATH)
    .map((r) => r.body as { action_id: string; category: string; amount_usd?: string });
}

describe('recurring over-cap blocks', () => {
  it('EVERY BLOCK CYCLE USES A NEW ACTION ID', async () => {
    // The plane denies every spend, as it would under a $25 cap.
    plane.scriptPrecheck({ decision: 'deny', reason: 'daily_spend_cap_exceeded' });
    await registerFleet(deps);

    const result = await runDemoGenerator({
      deps,
      // Every cycle is a block cycle, so three cycles is three attempts.
      activityIntervalMs: 1_000,
      blockIntervalMs: 1_000,
      signal: controller.signal,
      sleep: instantly,
      maxCycles: 3,
    });

    expect(result.blockAttempts).toBe(3);

    const overCap = prechecks().filter((p) => p.amount_usd === '41.000000');
    expect(overCap).toHaveLength(3);
    // THE ASSERTION THIS FILE EXISTS FOR. Reusing an id would replay the first
    // decision and produce no further blocks.
    expect(new Set(overCap.map((p) => p.action_id)).size).toBe(3);
  });

  it('records a denial per attempt and adds nothing to the audit', async () => {
    plane.scriptPrecheck({ decision: 'deny', reason: 'daily_spend_cap_exceeded' });
    await registerFleet(deps);

    const result = await runDemoGenerator({
      deps,
      activityIntervalMs: 1_000,
      blockIntervalMs: 1_000,
      signal: controller.signal,
      sleep: instantly,
      maxCycles: 2,
    });

    expect(result.denials).toBe(2);

    const submitted = plane
      .requestsTo(EVENT_INGEST_PATH)
      .flatMap((r) => (r.body as { events: { type: string }[] }).events);

    // The plane wrote the receipt and the block. A runtime `action.blocked`
    // would put two records in the audit for one refusal, and a
    // `spend.recorded` would claim money that was never spent.
    expect(submitted.filter((e) => e.type === 'action.blocked')).toEqual([]);
    expect(submitted.filter((e) => e.type === 'spend.recorded')).toEqual([]);
  });

  it('attempts a block only on the configured cadence', async () => {
    plane.scriptPrecheck({ decision: 'deny', reason: 'daily_spend_cap_exceeded' });
    await registerFleet(deps);

    const result = await runDemoGenerator({
      deps,
      activityIntervalMs: 1_000,
      // One block attempt per three activity cycles.
      blockIntervalMs: 3_000,
      signal: controller.signal,
      sleep: instantly,
      maxCycles: 6,
    });

    expect(result.cycles).toBe(6);
    expect(result.blockAttempts).toBe(2);
  });

  it('OBEYS THE PLANE WHEN THE ATTEMPT IS ALLOWED', async () => {
    // An operator raised the cap. The generator must not lower it back, and
    // must not fabricate a denial to keep the demo interesting.
    plane.scriptPrecheck({ decision: 'allow' });
    await registerFleet(deps);

    const result = await runDemoGenerator({
      deps,
      activityIntervalMs: 1_000,
      blockIntervalMs: 1_000,
      signal: controller.signal,
      sleep: instantly,
      maxCycles: 1,
    });

    expect(result.blockAttempts).toBe(1);
    expect(result.denials).toBe(0);
    expect(output()).toContain('ALLOWED under current policy');

    // Allowed means it happened, so it is reported like any runtime would.
    const spends = plane
      .requestsTo(EVENT_INGEST_PATH)
      .flatMap((r) => (r.body as { events: Record<string, unknown>[] }).events)
      .filter((e) => e['type'] === 'spend.recorded' && e['amount_usd'] === '41.000000');
    expect(spends).toHaveLength(1);
  });
});

describe('the three-agent fleet stays live', () => {
  it('registers the same three agents and keeps them active', async () => {
    await registerFleet(deps);

    await runDemoGenerator({
      deps,
      activityIntervalMs: 1_000,
      blockIntervalMs: 999_999,
      signal: controller.signal,
      sleep: instantly,
      maxCycles: 2,
    });

    // Stable ids, so repeated cycles do not enroll new agents.
    expect([...plane.registeredAgents].sort()).toEqual(['agent-a', 'agent-b', 'agent-c']);

    const heartbeats = plane
      .requestsTo(EVENT_INGEST_PATH)
      .flatMap((r) => (r.body as { events: { type: string }[] }).events)
      .filter((e) => e.type === 'heartbeat');
    // Three per cycle, through the real ingest path - so `last_seen_at` moves
    // for real rather than being fabricated.
    expect(heartbeats).toHaveLength(6);
  });

  it('every governed action is prechecked first', async () => {
    await registerFleet(deps);

    await runDemoGenerator({
      deps,
      activityIntervalMs: 1_000,
      blockIntervalMs: 999_999,
      signal: controller.signal,
      sleep: instantly,
      maxCycles: 1,
    });

    // One per agent role, none of them the over-cap attempt.
    expect(prechecks()).toHaveLength(3);
  });
});

describe('retry identity versus recurrence identity', () => {
  it('A RETRY REUSES ITS ACTION ID', async () => {
    // The first response is lost. The server may have acted, so the retry must
    // carry the same identity - otherwise "did my $41 attempt land?" becomes a
    // second attempt.
    //
    // Exercised on the exact runtime verb the generator calls, so the primed
    // failure lands on the over-cap precheck rather than on a heartbeat
    // earlier in the cycle.
    await registerFleet(deps);
    plane.failNext(1, 503);
    plane.scriptPrecheck({ decision: 'deny', reason: 'daily_spend_cap_exceeded' });

    await deps.runtime.spend('agent-a', '41.000000', 'demo-over-cap', 1);

    const overCap = prechecks().filter((p) => p.amount_usd === '41.000000');
    expect(overCap.length).toBeGreaterThanOrEqual(2);
    // Retries of ONE attempt share an id...
    expect(new Set(overCap.map((p) => p.action_id)).size).toBe(1);
  });

  it('...but the NEXT cycle does not', async () => {
    plane.scriptPrecheck({ decision: 'deny', reason: 'daily_spend_cap_exceeded' });
    await registerFleet(deps);

    await runDemoGenerator({
      deps,
      activityIntervalMs: 1_000,
      blockIntervalMs: 1_000,
      signal: controller.signal,
      sleep: instantly,
      maxCycles: 2,
    });

    const ids = prechecks()
      .filter((p) => p.amount_usd === '41.000000')
      .map((p) => p.action_id);
    expect(ids).toHaveLength(2);
    expect(ids[0]).not.toBe(ids[1]);
  });
});

describe('resilience', () => {
  it('survives a transient failure and continues', async () => {
    await registerFleet(deps);
    // Enough failures to exhaust the retries on one cycle, primed after
    // registration so it is the GENERATOR that meets them.
    plane.failNext(6, 503);

    const result = await runDemoGenerator({
      deps,
      activityIntervalMs: 1_000,
      blockIntervalMs: 999_999,
      signal: controller.signal,
      sleep: instantly,
      maxCycles: 3,
    });

    // A demo that stops forever after one 503 is worse than one that misses a
    // cycle.
    expect(result.cycles).toBe(3);
    expect(output()).toContain('!');
  });

  it('stops promptly when aborted', async () => {
    await registerFleet(deps);
    controller.abort();

    const result = await runDemoGenerator({
      deps,
      activityIntervalMs: 1_000,
      blockIntervalMs: 1_000,
      signal: controller.signal,
      sleep: instantly,
    });

    // No cycle runs, and the call returns rather than hanging.
    expect(result.cycles).toBe(0);
  });

  it('never logs the API key', async () => {
    plane.scriptPrecheck({ decision: 'deny', reason: 'daily_spend_cap_exceeded' });
    await registerFleet(deps);

    await runDemoGenerator({
      deps,
      activityIntervalMs: 1_000,
      blockIntervalMs: 1_000,
      signal: controller.signal,
      sleep: instantly,
      maxCycles: 2,
    });

    expect(output().length).toBeGreaterThan(0);
    expect(output()).not.toContain(API_KEY);
    expect(output()).not.toMatch(/bearer|authorization/i);
  });
});

describe('interval configuration', () => {
  it('falls back when unset or malformed', () => {
    expect(readIntervalMs(undefined, 5_000, 1_000)).toBe(5_000);
    expect(readIntervalMs('', 5_000, 1_000)).toBe(5_000);
    expect(readIntervalMs('abc', 5_000, 1_000)).toBe(5_000);
  });

  it('accepts a configured value', () => {
    expect(readIntervalMs('12000', 5_000, 1_000)).toBe(12_000);
  });

  it('FLOORS a dangerously small value', () => {
    // A typo must not turn the generator into a load test against the plane.
    expect(readIntervalMs('1', 5_000, MIN_BLOCK_INTERVAL_MS)).toBe(MIN_BLOCK_INTERVAL_MS);
  });
});
