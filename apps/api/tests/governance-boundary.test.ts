import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * SOURCE GUARDRAILS for the Step 17 governance read path.
 *
 * The behavioural suite in `governance-routes.test.ts` proves the routes
 * currently behave correctly. These assert the STRUCTURE that keeps them
 * correct, because several of the properties below fail silently:
 *
 *   - a `lockDailyLedger` in the read path would still render the right number
 *     while serializing the fleet view against live enforcement and creating
 *     accounting rows for agents that did nothing
 *   - re-deriving a receipt's explanation from current policy would look right
 *     until the day someone changed a cap
 *   - an API-key path onto these routes would work perfectly, for the wrong
 *     principal
 *
 * Each guard below is mutation-probed in the Step 17 report.
 */

const API_SRC = path.resolve(import.meta.dirname, '..', 'src');

function read(...segments: string[]): string {
  return readFileSync(path.join(API_SRC, ...segments), 'utf8');
}

/** Source with comments stripped, so prose about a pattern cannot trip it. */
function code(...segments: string[]): string {
  return read(...segments)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '');
}

const ROUTES = 'routes/governance.ts';
const READ_STORE = 'governance/read-store.ts';
/**
 * Shared row -> wire mappers.
 *
 * Extracted in Step 21 so the AC-18 share surface presents receipts and blocks
 * through the SAME code as the operator surface rather than a copy that could
 * drift. Authority differs between the two; the data does not.
 */
const READ_MODELS = 'read-models.ts';

describe('the governance routes are GET-only', () => {
  it('registers no mutating verb', () => {
    const source = code(ROUTES);

    // Behaviour and structure both: the route suite proves POST/PUT/PATCH/
    // DELETE currently 404, and this proves there is no handler to reach.
    for (const verb of ['post', 'put', 'patch', 'delete', 'all', 'on(']) {
      expect(source, verb).not.toContain(`routes.${verb}`);
    }
  });

  it('registers exactly the four documented read routes', () => {
    const source = code(ROUTES);
    const registrations = [...source.matchAll(/routes\.get\(/g)];

    expect(registrations).toHaveLength(4);
    for (const constant of ['RECEIPTS_PATH', 'RECEIPT_PATH', 'BLOCKS_PATH', 'BLOCK_PATH']) {
      expect(source, constant).toContain(`routes.get(${constant}`);
    }
  });

  it('never widens beyond receipts and blocks', () => {
    const source = code(ROUTES);

    // Exports, rollups, gone-dark and email digests are all deferred. A path
    // literal for any of them here would be scope creep with a URL.
    for (const forbidden of ['/export', '/rollup', '/summary', '/digest', '/share', '/report']) {
      expect(source, forbidden).not.toContain(forbidden);
    }
  });
});

describe('the governance routes authenticate a HUMAN, not a machine', () => {
  it('consults the session, never an API key', () => {
    const source = code(ROUTES);

    expect(source).toContain('requireAuthenticatedUser');
    // A runtime that can be denied must not be able to read the whole tenant's
    // denial history.
    for (const machineAuth of ['apiKey', 'ApiKey', 'authenticateApiKey', 'bearer', 'Bearer']) {
      expect(source, machineAuth).not.toContain(machineAuth);
    }
  });

  it('takes the workspace from the authorization result, never from input', () => {
    const source = code(ROUTES);

    // The path parameter is an ASSERTION to be checked, not authority. It goes
    // into `workspaceStore.authorize` and the scope comes back out; nothing
    // downstream reads it again.
    expect(source).toContain('workspaceStore.authorize');
    expect(source).toContain('gate.authorized');

    // Body, header and query are never a source of tenancy.
    expect(source).not.toMatch(/req\.(?:header|query)\(\s*['"](?:x-)?workspace/i);
    expect(source).not.toMatch(/workspaceId:\s*(?:body|parsed\.data)/);
  });

  it('answers a foreign or malformed id with an identical 404', () => {
    const source = code(ROUTES);

    // Never 403: distinguishing "not yours" from "no such thing" is an
    // existence oracle across tenants.
    expect(source).not.toContain('403');
    expect(source).toContain('NOT_FOUND_BODY');
    expect(source).toContain('UUID_PATTERN.test');
  });
});

describe('THE READ PATH TAKES NO LOCK AND CREATES NOTHING', () => {
  it('uses findDailyLedger and NEVER lockDailyLedger', () => {
    const source = code(READ_STORE);

    expect(source).toContain('findDailyLedger');
    // PROBE D. Locking here would serialize a dashboard refresh against live
    // enforcement, and - worse - materialise today's ledger row for every
    // agent in the fleet as a side effect of looking at it.
    expect(source).not.toContain('lockDailyLedger');
    expect(source).not.toContain('LockedDailyLedger');
  });

  it('never commits spend or publishes', () => {
    const source = code(READ_STORE);

    for (const mutation of ['commitSpend', 'commitPublish']) {
      expect(source, mutation).not.toContain(mutation);
    }
  });

  it('opens no transaction and issues no write', () => {
    const source = code(READ_STORE);

    for (const write of ['.transaction(', '.insert(', '.update(', '.delete(', 'upsert']) {
      expect(source, write).not.toContain(write);
    }
  });

  it('builds no write-capable repository', () => {
    const source = code(READ_STORE);

    // The write-side factories exist in the same package and are one import
    // away. None of them belongs here.
    for (const factory of [
      'createPolicyMutationRepository',
      'createPlaneBlockRepository',
      'createEventIngestRepository',
      'createPrecheckLockRepository',
    ]) {
      expect(source, factory).not.toContain(factory);
    }
  });

  it('computes absent usage as zero without persisting it', () => {
    const source = code(READ_STORE);

    // A workspace whose operator opened a dashboard must not thereby acquire
    // accounting rows for agents that did nothing all day.
    expect(source).toContain('NO_USAGE');
    expect(source).toMatch(/findDailyLedger\([^)]*\)\)\s*\?\?\s*NO_USAGE/);
  });
});

describe('the live transcription of the fleet read has not drifted', () => {
  /**
   * `packages/db` cannot import from `apps/`, so its live suite transcribes
   * the fleet composition rather than calling it. A drift would mean the live
   * suite no longer tests what production does - and since the live suite is
   * where PROBE D is caught by execution rather than by pattern, that drift
   * would quietly remove the strongest guard on this path.
   *
   * `apps/api` depends on both packages, so this is the only place the two can
   * be compared.
   */
  const liveRaw = readFileSync(
    path.resolve(API_SRC, '..', '..', '..', 'packages', 'db', 'tests', 'governance.live.test.ts'),
    'utf8',
  );
  // Comments stripped: the live suite explains what `lockDailyLedger` would do
  // wrong, and prose about a forbidden call must not read as the call.
  const live = liveRaw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

  it('the transcription exists and is labelled as one', () => {
    expect(live).toContain('async function readFleet(');
    // Named in a comment, so this reads the raw source.
    expect(liveRaw).toContain('apps/api/src/governance/read-store.ts');
  });

  it('it reads the ledger the same way production does', () => {
    // The exact expression, so a swap to `lockDailyLedger` in either file
    // shows up here.
    const production = 'const usage = (await ledgerRepository.findDailyLedger(agent.id, day)) ?? NO_USAGE;';

    expect(code(READ_STORE)).toContain(production);
    expect(live).toContain(production);
    expect(live).not.toContain('lockDailyLedger');
  });

  it('it resolves policy per agent exactly as production does', () => {
    // Iterating the policy list instead of the roster would silently drop any
    // agent the effective-policy view does not return a row for.
    for (const line of [
      'const policyByAgent = new Map(policies.map((row) => [row.id, row]));',
      'const policy = policyByAgent.get(agent.id);',
      "mode: policy?.mode ?? 'watch',",
      'dailySpendCapUsd: policy?.dailySpendCapUsd ?? null,',
      'dailyPublishCap: policy?.dailyPublishCap ?? null,',
    ]) {
      expect(code(READ_STORE), line).toContain(line);
      expect(live, line).toContain(line);
    }
  });

  it('it derives the day once, from the injected instant', () => {
    expect(live).toContain('const day = toUtcAccountingDay(now);');
    expect(code(READ_STORE)).toContain('const day = toUtcAccountingDay(now);');
  });

  it('it reuses the same effective-policy read', () => {
    expect(live).toContain('listEffectivePolicies()');
    expect(code(READ_STORE)).toContain('listEffectivePolicies()');
  });

  it('it defines the same zero-usage default', () => {
    const zero = "{ spendCommittedUsd: '0.000000', publishCountCommitted: 0 } as const";

    expect(code(READ_STORE)).toContain(zero);
    expect(live).toContain(zero);
  });

  it('the live suite still gates on TEST_DATABASE_URL and never falls back', () => {
    // A live suite that reached for `DATABASE_URL` would write test rows into
    // whatever database the developer happened to have configured.
    expect(live).toContain("process.env['TEST_DATABASE_URL']");
    expect(live).not.toContain("process.env['DATABASE_URL']");
    expect(live).toContain('describe.skipIf(!hasTestDatabase)');
  });
});

describe('FLEET USAGE COMES FROM THE LEDGER, NOT FROM EVENTS', () => {
  it('reads no event table or event repository', () => {
    const source = code(READ_STORE);

    // PROBE B. `spend.recorded` events still do not debit the authoritative
    // ledger, so summing them would show a number the plane does not enforce
    // against - and the two would diverge silently.
    for (const eventPath of ['createEventReadRepository', 'eventQueries', 'events.', 'listTimeline']) {
      expect(source, eventPath).not.toContain(eventPath);
    }
  });

  it('performs no aggregation of its own', () => {
    const source = code(READ_STORE);

    for (const aggregate of ['reduce(', 'sum(', 'SUM(', '+=']) {
      expect(source, aggregate).not.toContain(aggregate);
    }
  });

  it('reuses the Step 12 effective-policy read rather than reimplementing it', () => {
    const source = code(READ_STORE);

    // The fleet view and a polling agent must never disagree about what the
    // effective mode is.
    expect(source).toContain('listEffectivePolicies');
  });
});

describe('THE ACCOUNTING DAY IS THE SERVER"S', () => {
  it('derives the day from an injected instant, once per roster', () => {
    const source = code(READ_STORE);

    expect(source).toContain('toUtcAccountingDay(now)');
    // One reading for the whole roster: a request that straddles UTC midnight
    // must not report two different days across its rows.
    expect([...source.matchAll(/toUtcAccountingDay\(/g)]).toHaveLength(1);
  });

  it('never calls the clock itself', () => {
    const source = code(READ_STORE);

    // `now` arrives from the caller's injected clock, which is what makes the
    // UTC-midnight test in the route suite possible at all.
    expect(source).not.toContain('new Date(');
    expect(source).not.toContain('Date.now(');
  });

  it('accepts no day from the caller', () => {
    const routes = code(ROUTES);
    const store = code(READ_STORE);

    for (const source of [routes, store]) {
      expect(source).not.toMatch(/\b(?:day|date|accounting_day|accountingDay)\s*:\s*parsed\.data/);
    }
    // The query schemas are strict, so `?day=` is a 400 rather than ignored.
    expect(routes).toContain('receiptListQuerySchema.safeParse');
    expect(routes).toContain('blockListQuerySchema.safeParse');
  });
});

describe('NO HISTORICAL RECOMPUTATION', () => {
  it('renders a receipt from persisted applied* fields only', () => {
    const source = code(ROUTES);

    // PROBE C. Re-deriving the explanation from current policy would look
    // correct until the first cap change, then quietly rewrite history.
    for (const field of ['appliedMode', 'appliedSpendCapUsd', 'appliedPublishCap']) {
      expect(source, field).toContain(`${field}: row.${field}`);
    }
  });

  it('the receipt path never consults live policy or the ledger', () => {
    const source = code(ROUTES);

    for (const live of [
      'createPolicyReadRepository',
      'listEffectivePolicies',
      'findDailyLedger',
      'ruleForDenyReason',
      'explanationForDenyReason',
    ]) {
      expect(source, live).not.toContain(live);
    }
  });

  it('the persisted reason is passed through, not re-derived', () => {
    // The summary mappers moved to `read-models.ts` in Step 21, so the AC-18
    // share surface presents receipts and blocks through the SAME code rather
    // than a copy that could drift. The invariant is unchanged; only its
    // address is, so this guard follows it.
    const source = code(READ_MODELS);

    expect(source).toContain('reason: row.denyReason === null ? null :');
    // Ownership too: `source` is read from the row, never inferred from
    // whether a receipt happens to be linked.
    expect(source).toContain('source: row.source');
    expect(source).toContain('precheckId: row.precheckReceiptId');
  });

  it('fabricates no receipt for a runtime block', () => {
    const source = code(READ_MODELS);

    // A plugin reporting its own refusal has no plane decision. Inventing one
    // would be a lie about who enforced what.
    //
    // EVERY assignment must read straight from the row - not a fallback, not a
    // lookup, not a synthesised id.
    //
    // Asserted as a property of each occurrence rather than as a count: the
    // module legitimately carries two, one for an event's linkage and one for
    // a block's, and a third would be fine if it obeyed the same rule.
    const assignments = [...source.matchAll(/precheckId:\s*([^,\n]+)/g)].map((m) => m[1]?.trim());

    expect(assignments.length).toBeGreaterThan(0);
    expect(new Set(assignments)).toEqual(new Set(['row.precheckReceiptId']));
  });
});

describe('THE EFFECTIVE WATCH DEFAULT IS MATERIALISED BY EVERY CONSUMER', () => {
  // ─── WHY THIS GUARD EXISTS ────────────────────────────────────────────
  //
  // `listEffectivePolicies` LEFT JOINs `agent_policies`, so `mode` is NULL for
  // an agent with no explicit row. That is the repository's declared contract
  // ("Null when no explicit agent_policies row exists"), paired with
  // `hasExplicitPolicy` — it reports absence faithfully and invents nothing.
  //
  // Materialising Step 12's WATCH default is therefore the COMPOSITION layer's
  // job, and it is a job that can be dropped silently: an agent would simply
  // start reporting `null` mode on the roster, the poll and the editor, and no
  // type would complain because the source type is nullable.
  //
  // A live test asserted 'watch' against the repository and failed with `null`
  // against real PostgreSQL. The right conclusion was not to change the
  // expectation — production genuinely must expose 'watch' — but to assert each
  // layer where it belongs. This pins the composition half.

  const CONSUMERS = [
    { name: 'the operator fleet roster', segments: ['governance', 'read-store.ts'] },
    { name: 'machine policy polling', segments: ['policy', 'store.ts'] },
    { name: 'the operator policy editor', segments: ['policy', 'mutation-store.ts'] },
  ];

  it.each(CONSUMERS)('$name defaults a missing mode to watch', ({ segments }) => {
    const source = read(...segments);

    // Either the literal or the shared constant, but never nothing.
    expect(source).toMatch(/mode:\s*[^\n]*\?\?\s*('watch'|DEFAULT_AGENT_MODE)/);
  });

  it('and none of them invents a cap alongside it', () => {
    // Step 12: watch OBSERVES. A default cap would be enforcement nobody asked
    // for, and a zero would read as "spend nothing" rather than "no cap".
    for (const { segments } of CONSUMERS) {
      const source = read(...segments);

      expect(source).not.toMatch(/dailySpendCapUsd:\s*[^\n]*\?\?\s*'[0-9]/);
      expect(source).not.toMatch(/dailyPublishCap:\s*[^\n]*\?\?\s*[0-9]/);
    }
  });
});
