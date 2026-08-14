import {
  AGENT_REGISTER_PATH,
  EVENT_INGEST_PATH,
  PRECHECK_PATH,
} from '@hybrid/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ControlPlaneError, createControlPlaneClient } from '../src/client';
import { createIdFactory } from '../src/ids';
import { createLogger } from '../src/logging';
import { createRuntime } from '../src/runtime';
import {
  registerFleet,
  runBaseline,
  runOverCap,
  runPublishBurst,
  runReplay,
  runUnprecheckedSpend,
  type ScenarioDeps,
} from '../src/scenarios';
import { startFakeControlPlane, type FakeControlPlane } from './helpers/fake-control-plane';

/**
 * The reference client, exercised AS AN HTTP CLIENT against a real socket.
 *
 * Nothing here imports API internals. If a flow cannot be driven through the
 * published contract, that is a finding about the API, not something to work
 * around by reaching behind it.
 */

const API_KEY = 'hmp_live_TESTKEYvalue0000000000000000000';

let plane: FakeControlPlane;
let lines: string[];
let deps: ScenarioDeps;

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
  const ids = createIdFactory('testrun');
  deps = { client, runtime: createRuntime({ client, ids, log }), ids, log };
});

afterEach(async () => {
  await plane.close();
});

const output = (): string => lines.join('\n');

describe('the fleet registers over the public API', () => {
  it('registers exactly three stable agents', async () => {
    await registerFleet(deps);

    // AC-04 asks for three agents. Stable ids, so a second run does not enroll
    // three more.
    expect([...plane.registeredAgents].sort()).toEqual(['agent-a', 'agent-b', 'agent-c']);
    expect(plane.requestsTo(AGENT_REGISTER_PATH)).toHaveLength(3);
  });

  it('re-registering the same ids does not create new agents', async () => {
    await registerFleet(deps);
    await registerFleet(deps);

    expect(plane.registeredAgents.size).toBe(3);
  });

  it('sends the credential as a bearer header on every call', async () => {
    await registerFleet(deps);

    for (const request of plane.requests) {
      expect(request.authorization).toBe(`Bearer ${API_KEY}`);
    }
  });

  it('NEVER sends a workspace id in any body', async () => {
    await registerFleet(deps);
    await runBaseline(deps);

    // Tenancy comes from the credential. A client that could name a workspace
    // could be wrong about it.
    const serialised = JSON.stringify(plane.requests.map((r) => r.body));
    expect(serialised).not.toMatch(/workspace/i);
    expect(serialised).not.toMatch(/tenant/i);
  });
});

describe('baseline activity', () => {
  it('heartbeats every agent and performs each role', async () => {
    await runBaseline(deps);

    const ingested = plane.requestsTo(EVENT_INGEST_PATH);
    expect(ingested.length).toBeGreaterThanOrEqual(6);
    // Three heartbeats, then one governed action per agent.
    expect(plane.requestsTo(PRECHECK_PATH)).toHaveLength(3);
  });

  it('prechecks BEFORE every governed action', async () => {
    await runBaseline(deps);

    const order = plane.requests.map((r) => r.path);
    const firstPrecheck = order.indexOf(PRECHECK_PATH);
    expect(firstPrecheck).toBeGreaterThan(-1);

    // Every spend/action event must be preceded by a precheck. The heartbeats
    // come first and are ungoverned, so the check is that no GOVERNED event
    // precedes the first precheck.
    const governedBefore = plane.requests
      .slice(0, firstPrecheck)
      .filter((r) => r.path === EVENT_INGEST_PATH)
      .flatMap((r) => (r.body as { events: { type: string }[] }).events)
      .filter((e) => e.type !== 'heartbeat');
    expect(governedBefore).toEqual([]);
  });

  it('carries the precheck_id on every allowed follow-up event', async () => {
    await runBaseline(deps);

    const governed = plane
      .requestsTo(EVENT_INGEST_PATH)
      .flatMap((r) => (r.body as { events: Record<string, unknown>[] }).events)
      .filter((e) => e['type'] !== 'heartbeat');

    expect(governed.length).toBeGreaterThan(0);
    for (const event of governed) {
      // Step 18/19: the linkage is what stops the event debiting again.
      expect(event['precheck_id']).toMatch(/^[0-9a-f-]{36}$/);
    }
  });
});

describe('A DENIAL STOPS THE WORK', () => {
  it('sends NO follow-up spend event after a denied precheck', async () => {
    plane.scriptPrecheck({ decision: 'deny', reason: 'daily_spend_cap_exceeded' });

    await runOverCap(deps);

    // The action did not happen, so there is nothing to report. Reporting a
    // spend here would record money that was never spent.
    const spends = plane
      .requestsTo(EVENT_INGEST_PATH)
      .flatMap((r) => (r.body as { events: { type: string }[] }).events)
      .filter((e) => e.type === 'spend.recorded');
    expect(spends).toEqual([]);
  });

  it('EMITS NO action.blocked for a plane denial', async () => {
    plane.scriptPrecheck({ decision: 'deny', reason: 'daily_spend_cap_exceeded' });

    await runOverCap(deps);

    // The plane already wrote its receipt and its own block. A runtime block
    // here would put two records in the audit for one refusal, and an operator
    // could not tell which system actually stopped the work.
    const blocked = plane
      .requestsTo(EVENT_INGEST_PATH)
      .flatMap((r) => (r.body as { events: { type: string }[] }).events)
      .filter((e) => e.type === 'action.blocked');
    expect(blocked).toEqual([]);
  });

  it('reports the denial reason without reinterpreting it', async () => {
    plane.scriptPrecheck({ decision: 'deny', reason: 'daily_spend_cap_exceeded' });

    await runOverCap(deps);

    expect(output()).toContain('DENIED');
    expect(output()).toContain('daily_spend_cap_exceeded');
  });

  it('an allowed over-cap attempt DOES report its spend', async () => {
    // Same scenario, opposite answer: the client obeys the plane rather than
    // deciding for itself that $41 is too much.
    plane.scriptPrecheck({ decision: 'allow' });

    await runOverCap(deps);

    const spends = plane
      .requestsTo(EVENT_INGEST_PATH)
      .flatMap((r) => (r.body as { events: Record<string, unknown>[] }).events)
      .filter((e) => e['type'] === 'spend.recorded');
    expect(spends).toHaveLength(1);
    expect(spends[0]?.['amount_usd']).toBe('41.000000');
  });
});

describe('publish burst', () => {
  it('stops executing at the first denial', async () => {
    // Five allows, then deny - the AC-11 shape.
    plane.scriptPrecheck(
      { decision: 'allow' },
      { decision: 'allow' },
      { decision: 'allow' },
      { decision: 'allow' },
      { decision: 'allow' },
      { decision: 'deny', reason: 'daily_publish_cap_exceeded' },
    );

    await runPublishBurst(deps);

    // Six asked, five performed. The sixth must not run.
    expect(plane.requestsTo(PRECHECK_PATH)).toHaveLength(6);
    const published = plane
      .requestsTo(EVENT_INGEST_PATH)
      .flatMap((r) => (r.body as { events: { type: string }[] }).events);
    expect(published).toHaveLength(5);
  });

  it('uses a DISTINCT action id for every attempt', async () => {
    plane.scriptPrecheck(
      { decision: 'allow' },
      { decision: 'allow' },
      { decision: 'allow' },
      { decision: 'allow' },
      { decision: 'allow' },
      { decision: 'deny', reason: 'daily_publish_cap_exceeded' },
    );

    await runPublishBurst(deps);

    const actionIds = plane
      .requestsTo(PRECHECK_PATH)
      .map((r) => (r.body as { action_id: string }).action_id);
    // One precheck is one publish. Reusing an id would replay the first
    // decision six times and prove nothing about the cap.
    expect(new Set(actionIds).size).toBe(6);
  });

  it('does not continue after the denial even if later answers would allow', async () => {
    plane.scriptPrecheck(
      { decision: 'deny', reason: 'daily_publish_cap_exceeded' },
      { decision: 'allow' },
    );

    await runPublishBurst(deps);

    expect(plane.requestsTo(PRECHECK_PATH)).toHaveLength(1);
    expect(plane.requestsTo(EVENT_INGEST_PATH)).toHaveLength(0);
  });
});

describe('AC-13 replay', () => {
  it('resends byte-identical event ids and the plane reports duplicates', async () => {
    await runReplay(deps);

    const submissions = plane.requestsTo(EVENT_INGEST_PATH);
    expect(submissions).toHaveLength(2);

    const idsOf = (index: number): string[] =>
      (submissions[index]?.body as { events: { event_id: string }[] }).events.map(
        (e) => e.event_id,
      );

    // The SAME ids. A scenario that rebuilt the batch would generate new ones
    // and prove the opposite of what AC-13 asks.
    expect(idsOf(1)).toEqual(idsOf(0));
    expect(JSON.stringify(submissions[1]?.body)).toBe(JSON.stringify(submissions[0]?.body));
    // Three stored, not six.
    expect(plane.storedEventIds.size).toBe(3);
    expect(output()).toContain('Replay: accepted 0, duplicates 3');
  });
});

describe('RETRY REUSES THE SAME IDENTITY', () => {
  it('a retried precheck keeps its action_id', async () => {
    // The first response is lost to a 503; the client retries.
    plane.failNext(1, 503);
    plane.scriptPrecheck({ decision: 'allow' });

    await deps.runtime.spend('agent-a', '4.000000', 'retry', 1);

    const prechecks = plane.requestsTo(PRECHECK_PATH);
    expect(prechecks.length).toBeGreaterThanOrEqual(2);
    const actionIds = prechecks.map((r) => (r.body as { action_id: string }).action_id);
    // A fresh id here would turn "did my $4 land?" into a second $4 action.
    expect(new Set(actionIds).size).toBe(1);
  });

  it('a retried ingest keeps its event_id', async () => {
    plane.failNext(1, 503);

    await deps.runtime.heartbeat('agent-a', 'retry-hb', 1);

    const eventIds = plane
      .requestsTo(EVENT_INGEST_PATH)
      .flatMap((r) => (r.body as { events: { event_id: string }[] }).events)
      .map((e) => e.event_id);
    expect(eventIds.length).toBeGreaterThanOrEqual(2);
    expect(new Set(eventIds).size).toBe(1);
    // Server idempotency then makes the retry harmless.
    expect(plane.storedEventIds.size).toBe(1);
  });

  it('a retried body is byte-identical, not rebuilt', async () => {
    plane.failNext(1, 503);
    plane.scriptPrecheck({ decision: 'allow' });

    await deps.runtime.spend('agent-a', '4.000000', 'retry', 2);

    const bodies = plane.requestsTo(PRECHECK_PATH).map((r) => JSON.stringify(r.body));
    expect(bodies[1]).toBe(bodies[0]);
  });

  it('does NOT retry a 4xx - that is a decision, not a blip', async () => {
    plane.failNext(1, 400);

    await expect(deps.runtime.heartbeat('agent-a', 'bad', 1)).rejects.toThrow(ControlPlaneError);
    expect(plane.requestsTo(EVENT_INGEST_PATH)).toHaveLength(1);
  });
});

describe('policy polling', () => {
  it('reads a snapshot and then sends since_version', async () => {
    plane.setPolicy({
      version: '7',
      agents: [
        { agent_id: 'agent-a', mode: 'budgeted', daily_spend_cap_usd: '25.000000', daily_publish_cap: null },
      ],
    });
    plane.setUnchangedFor('7');

    const first = await deps.client.pollPolicy();
    expect(first.status).toBe('snapshot');
    const version = first.status === 'snapshot' ? first.snapshot.version : '';
    expect(version).toBe('7');

    const second = await deps.client.pollPolicy(version);
    // 304 is the designed steady state, not an error.
    expect(second.status).toBe('unchanged');
  });

  it('surfaces a 401 rather than looping', async () => {
    const client = createControlPlaneClient({
      baseUrl: plane.url,
      apiKey: API_KEY,
      timeoutMs: 2_000,
      sleep: () => Promise.resolve(),
      // No Authorization header at all.
      fetchImpl: (input, init) =>
        fetch(input, { ...init, headers: { 'content-type': 'application/json' } }),
    });

    await expect(client.pollPolicy()).rejects.toThrow(ControlPlaneError);
  });

  it('does not retry a 401', async () => {
    const before = plane.requests.length;
    const client = createControlPlaneClient({
      baseUrl: plane.url,
      apiKey: API_KEY,
      sleep: () => Promise.resolve(),
      fetchImpl: (input, init) =>
        fetch(input, { ...init, headers: { 'content-type': 'application/json' } }),
    });

    await expect(client.pollPolicy()).rejects.toThrow();
    expect(plane.requests.length - before).toBe(1);
  });
});

describe('THE API KEY NEVER REACHES THE OUTPUT', () => {
  it('is absent from a full successful run', async () => {
    plane.setPolicy({ version: '1', agents: [] });
    await registerFleet(deps);
    await runBaseline(deps);
    await runReplay(deps);
    await runUnprecheckedSpend(deps);

    expect(output().length).toBeGreaterThan(0);
    expect(output()).not.toContain(API_KEY);
    expect(output()).not.toContain('hmp_live_');
    expect(output()).not.toMatch(/bearer/i);
    expect(output()).not.toMatch(/authorization/i);
  });

  it('is absent from an error path', async () => {
    plane.failNext(5, 500);

    await expect(deps.runtime.heartbeat('agent-a', 'boom', 1)).rejects.toThrow();
    // The thrown error is what a caller would print.
    try {
      await deps.runtime.heartbeat('agent-a', 'boom', 2);
    } catch (caught: unknown) {
      const printed = String(caught) + JSON.stringify(caught, Object.getOwnPropertyNames(caught));
      expect(printed).not.toContain(API_KEY);
      expect(printed).not.toMatch(/bearer/i);
    }
  });
});

describe('unprechecked spend is an explicit, separate path', () => {
  it('sends a spend event with NO precheck_id and no precheck call', async () => {
    const before = plane.requestsTo(PRECHECK_PATH).length;

    await runUnprecheckedSpend(deps);

    expect(plane.requestsTo(PRECHECK_PATH)).toHaveLength(before);
    const events = plane
      .requestsTo(EVENT_INGEST_PATH)
      .flatMap((r) => (r.body as { events: Record<string, unknown>[] }).events);
    expect(events).toHaveLength(1);
    expect(events[0]?.['type']).toBe('spend.recorded');
    expect(events[0]).not.toHaveProperty('precheck_id');
  });
});
