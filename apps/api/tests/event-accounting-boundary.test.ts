import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * SOURCE GUARDRAILS for authoritative event accounting (Step 19).
 *
 * Event ingest now moves money. Every property below fails SILENTLY if broken:
 * the request still returns 200, the event still stores, and the damage is a
 * ledger that disagrees with reality.
 *
 * Six things must stay true:
 *
 *   1. The debit is gated on the ABSENCE of a validated receipt - not on what
 *      the receipt says, and not on whether the ledger happened to move.
 *   2. Mutation goes through `LockedDailyLedger`. No direct UPDATE, no
 *      unlocked helper.
 *   3. The accounting day comes from the server instant that also stamps
 *      `received_at`. `occurred_at` can never select it.
 *   4. No policy is read. Recording is not deciding.
 *   5. Lock families are acquired whole, each in a deterministic total order,
 *      before the next family is touched.
 *   6. One transaction owns all of it.
 *
 * Each is mutation-probed in the Step 19 report.
 */

const API_SRC = path.resolve(import.meta.dirname, '..', 'src');
const DB_SRC = path.resolve(API_SRC, '..', '..', '..', 'packages', 'db', 'src');

const INGEST_STORE = path.join(API_SRC, 'events', 'store.ts');
const LEDGER_REPO = path.join(DB_SRC, 'repositories', 'ledger.ts');

function read(file: string): string {
  return readFileSync(file, 'utf8');
}

/** Source with comments stripped, so prose about a pattern cannot trip it. */
function code(file: string): string {
  return read(file)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '');
}

const ingest = code(INGEST_STORE);

const positionOf = (needle: string, source = ingest): number => {
  const at = source.indexOf(needle);
  if (at < 0) expect.unreachable(`store.ts no longer contains ${needle}`);
  return at;
};

describe('THE DEBIT IS GATED ON THE ABSENCE OF A PRECHECK', () => {
  const GATE = "event.type === 'spend.recorded' && !linkedReceipt.has(index)";

  it('exactly one commitSpend exists, and it is behind the gate', () => {
    // PROBE C. A precheck already committed the usage for a linked event;
    // debiting again is the $4-becomes-$8 defect.
    const commits = [...ingest.matchAll(/\.commitSpend\(/g)];
    expect(commits).toHaveLength(1);

    const gateAt = ingest.lastIndexOf(GATE);
    expect(gateAt).toBeGreaterThan(-1);
    expect(gateAt).toBeLessThan(positionOf('.commitSpend('));

    // No branch reopens between the gate and the debit. An `else` or a second
    // `if (event` would mean the debit is reachable on some other condition.
    // A `throw` guard in between is fine - it only narrows.
    const between = ingest.slice(gateAt, positionOf('.commitSpend('));
    expect(between).not.toContain('else');
    expect(between).not.toContain('if (event');
  });

  it('the lock set uses the SAME gate as the debit', () => {
    // Two gates that could drift apart would mean either a lock taken for
    // nothing, or - far worse - a debit against a row nobody locked.
    expect([...ingest.matchAll(new RegExp(GATE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'))])
      .toHaveLength(2);
  });

  it('classification never reads receipt CONTENT', () => {
    // A `watch` precheck deliberately committed nothing. Keying off its mode,
    // its decision, or "the ledger did not move" would make its follow-up
    // event commit on its behalf.
    for (const content of ['appliedMode', 'appliedSpendCapUsd', "=== 'watch'", 'decision ===']) {
      expect(ingest, content).not.toContain(content);
    }
  });

  it('no publish is ever committed from an event', () => {
    // There is no `publish.recorded`, and an `agent.action` reporting a
    // publish must not increment a counter the precheck already moved.
    expect(ingest).not.toContain('commitPublish');
  });

  it('the ledger is never READ for a decision', () => {
    // Recording is not deciding. Nothing here compares committed usage to
    // anything, so the observability read has no place on this path.
    expect(ingest).not.toContain('findDailyLedger');
  });
});

describe('MUTATION GOES THROUGH THE LOCKED CAPABILITY', () => {
  it('ingest obtains the capability and commits only through it', () => {
    // PROBE B. Step 14's correction made the locked capability the ONLY way to
    // mutate a ledger row; an unlocked read-modify-write is the lost-update
    // defect that correction removed.
    expect(ingest).toContain('ledgerRepo.lockDailyLedger(');
    expect(ingest).toContain('await ledger.commitSpend(');
  });

  it('ingest issues no direct ledger SQL', () => {
    for (const direct of [
      'ledgerDaily',
      'spendCommittedUsd',
      '.update(',
      'addSpend',
      'setSpend',
      'incrementSpend',
    ]) {
      expect(ingest, direct).not.toContain(direct);
    }
  });

  it('the unsafe API still does not exist on the repository', () => {
    const ledger = code(LEDGER_REPO);

    // `commitSpend` must remain reachable only from the object built AFTER the
    // row lock is held. Two independent checks:
    expect(ledger).toContain('function createLockedLedger(');

    // 1. The repository interface exposes exactly the two safe methods.
    const iface = ledger.slice(
      ledger.indexOf('export interface LedgerRepository {'),
      ledger.indexOf('export class LedgerRowMissingError'),
    );
    expect(iface).toContain('findDailyLedger(');
    expect(iface).toContain('lockDailyLedger(');
    expect(iface).not.toContain('commitSpend');
    expect(iface).not.toContain('commitPublish');

    // 2. Every definition of a commit method sits inside `createLockedLedger`,
    //    which is module-private and only called after `lockForUpdate`.
    const lockedFactoryAt = ledger.indexOf('function createLockedLedger(');
    const repositoryBodyAt = ledger.indexOf('async findDailyLedger(');
    for (const match of ledger.matchAll(/async commit(?:Spend|Publish)\(/g)) {
      expect(match.index).toBeGreaterThan(lockedFactoryAt);
      expect(match.index).toBeLessThan(repositoryBodyAt);
    }
  });

  it('capacity is checked before the write, not left to the column', () => {
    const ledger = code(LEDGER_REPO);

    // An overflow must surface as a typed error and roll the batch back, never
    // as a truncated or wrapped total.
    expect(ledger).toContain('addMicros(parseUsdToMicros(');
  });
});

describe('THE ACCOUNTING DAY IS THE SERVER’S', () => {
  it('derives from the SAME instant that stamps received_at', () => {
    // PROBE D. Two clock reads could put `received_at` on day N and the debit
    // on day N+1 for one event accepted at midnight.
    const days = [...ingest.matchAll(/toUtcAccountingDay\(([^)]*)\)/g)].map((m) => m[1]);
    expect(days).toEqual(['now']);
    expect(ingest).toContain('receivedAt: now');
  });

  it('reads the clock zero times - the instant is injected', () => {
    for (const clock of ['new Date()', 'Date.now(']) {
      expect(ingest, clock).not.toContain(clock);
    }
    // The one `new Date(...)` is parsing the client's reported timestamp.
    const constructions = [...ingest.matchAll(/new Date\(([^)]*)\)/g)].map((m) => m[1]);
    expect(constructions).toEqual(['event.occurred_at']);
  });

  it('occurred_at CANNOT select the ledger day', () => {
    // It is stored as untrusted client metadata and used nowhere else.
    const occurrences = [...ingest.matchAll(/occurred_at/g)];
    expect(occurrences.length).toBeGreaterThan(0);

    const dayLine = ingest.slice(
      positionOf('const accountingDay ='),
      positionOf('const accountingDay =') + 120,
    );
    expect(dayLine).not.toContain('occurred_at');
    expect(dayLine).toContain('toUtcAccountingDay(now)');
  });

  it('the day is computed ONCE, outside the per-event loop', () => {
    expect(positionOf('const accountingDay =')).toBeLessThan(positionOf('db.transaction('));
  });
});

describe('RECORDING IS NOT DECIDING', () => {
  it('ingest reads no policy', () => {
    // PROBE E. Rejecting already-incurred spend because a cap would be
    // exceeded would make the ledger a statement about policy rather than
    // about money, and would hide the overspend an operator most needs.
    for (const policy of [
      'createPolicyReadRepository',
      'createPolicyMutationRepository',
      'listEffectivePolicies',
      'agentPolicies',
      'dailySpendCapUsd',
      'requiresLedger',
      'decide(',
    ]) {
      expect(ingest, policy).not.toContain(policy);
    }
  });

  it('ingest creates no synthetic receipt', () => {
    // An unprechecked spend records no decision, because none was made.
    expect(ingest).not.toContain('receiptRepo.insert(');
    expect(ingest).not.toContain('InsertReceiptInput');
  });

  it('ingest creates no plane-owned block', () => {
    // An over-cap report is not a denial. Runtime blocks stay client-owned.
    expect(ingest).toContain('resolveOrCreateRuntimeBlock');
    expect(ingest).not.toContain('createPlaneBlockRepository');
    expect(ingest).not.toContain('createForDeniedPrecheck');
  });

  it('no cap comparison exists anywhere on the path', () => {
    expect(ingest).not.toMatch(/committed[\s\S]{0,40}[<>]=?/);
    expect(ingest).not.toContain('remaining');
  });
});

describe('LOCK ORDER IS DETERMINISTIC AND LAYERED', () => {
  it('ALL event identity locks precede any ledger lock', () => {
    // PROBE F. Interleaving the families would let one batch hold a ledger row
    // while waiting for an event lock another batch holds.
    expect(positionOf('lockRepo.lockEvents(')).toBeLessThan(
      positionOf('ledgerRepo.lockDailyLedger('),
    );
  });

  it('the duplicate decision precedes every lock beyond the event family', () => {
    // A duplicate must never reach agent resolution or accounting.
    const duplicateAt = positionOf('eventRepo.findByEventId(');
    expect(duplicateAt).toBeLessThan(positionOf('agentRepo.discover('));
    expect(duplicateAt).toBeLessThan(positionOf('ledgerRepo.lockDailyLedger('));
    expect(duplicateAt).toBeLessThan(positionOf('.commitSpend('));
  });

  it('agent rows are resolved in deterministic order, before the ledger', () => {
    // `discover` is an upsert and takes a row lock, so two batches naming the
    // same agents in opposite sequence could deadlock without a sort.
    expect(ingest).toContain(
      'const externalIds = [...new Set(fresh.map(({ event }) => event.agent_id))].sort();',
    );
    expect(positionOf('agentRepo.discover(')).toBeLessThan(
      positionOf('ledgerRepo.lockDailyLedger('),
    );
  });

  it('LEDGER ROWS ARE LOCKED IN A DETERMINISTIC TOTAL ORDER', () => {
    // The multi-agent batch hazard: [A,B] against [B,A] deadlocks unless both
    // compute the same sequence.
    const keysAt = positionOf('const ledgerKeys = [');
    const lockAt = positionOf('ledgerRepo.lockDailyLedger(');
    const block = ingest.slice(keysAt, lockAt);

    expect(block).toContain('.sort(');
    expect(keysAt).toBeLessThan(lockAt);
  });

  it('every ledger lock is acquired before any debit', () => {
    expect(positionOf('ledgerRepo.lockDailyLedger(')).toBeLessThan(positionOf('.commitSpend('));
  });

  it('locks are acquired sequentially, never raced', () => {
    // `Promise.all` over lock acquisition would forfeit the ordering that is
    // the entire deadlock guard.
    expect(ingest).not.toContain('Promise.all');
    expect(ingest).not.toContain('Promise.allSettled');
  });

  it('one capability per agent-day, reused across the batch', () => {
    // Re-locking per event would be redundant, and re-reading would be stale.
    expect(ingest).toContain('ledgerByAgent');
    expect(ingest).toContain('ledgerByAgent.get(agent.id)');
    expect([...ingest.matchAll(/lockDailyLedger\(/g)]).toHaveLength(1);
  });
});

describe('ONE TRANSACTION OWNS ALL OF IT', () => {
  it('exactly one transaction is opened', () => {
    expect([...ingest.matchAll(/\.transaction\(/g)]).toHaveLength(1);
  });

  it('EVERY repository is built on the transaction handle', () => {
    // One built on `db` would run outside the transaction, and a debit that
    // committed while its event rolled back is money with no audit row.
    const factories = [...ingest.matchAll(/create\w+Repository\((\w+),/g)].map((m) => m[1]);

    expect(factories.length).toBeGreaterThanOrEqual(5);
    expect(new Set(factories)).toEqual(new Set(['tx']));
  });

  it('the ledger repository opens no nested transaction', () => {
    const ledger = code(LEDGER_REPO);

    // It must join the caller's transaction, never start its own - a nested
    // one would commit independently of the event.
    expect(ledger).not.toContain('.transaction(');
  });

  it('the insert precedes the debit', () => {
    // If the constraint reveals a duplicate the advisory lock somehow missed,
    // no money has moved yet.
    expect(positionOf('eventRepo.insertIfNew(')).toBeLessThan(positionOf('.commitSpend('));
  });

  it('a duplicate discovered at the constraint debits nothing', () => {
    const branch = ingest.slice(
      positionOf('if (inserted === null)'),
      positionOf('.commitSpend('),
    );

    expect(branch).toContain('duplicates += 1');
    expect(branch).toContain('continue');
  });

  it('no compensating write exists - rollback is the compensation', () => {
    for (const compensation of ['refund', 'credit(', 'reverse(', 'undoSpend', 'rollbackSpend']) {
      expect(ingest, compensation).not.toContain(compensation);
    }
  });
});

describe('the live transcription has not drifted', () => {
  /**
   * `packages/db` cannot import from `apps/`, so its live suite transcribes
   * the staged transaction. That suite is the ONLY place concurrency and
   * deadlock can be observed at all, so a drift there would silently remove
   * the only evidence for three money-critical properties.
   */
  const liveRaw = read(path.join(DB_SRC, '..', 'tests', 'event-accounting.live.test.ts'));
  const live = liveRaw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

  it('the transcription exists and names its source', () => {
    expect(live).toContain('async function ingestBatch(');
    expect(liveRaw).toContain('apps/api/src/events/store.ts');
  });

  it('it keeps the phase order', () => {
    const order = [
      'lockEvents(',
      'eventRepo.findByEventId(',
      'agentRepo.discover(',
      'receiptRepo.findById(',
      'ledgerRepo.lockDailyLedger(',
      'eventRepo.insertIfNew(',
      '.commitSpend(',
    ].map((needle) => live.indexOf(needle));

    expect(order).not.toContain(-1);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it('it sorts both lock families deterministically', () => {
    expect(live).toContain('.sort()');
    expect(live).toContain(
      '.sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))',
    );
  });

  it('it gates the debit on the ABSENCE of a precheck', () => {
    expect(live).toContain("e.type === 'spend.recorded' && !linked.has(e.eventId)");
    expect(live).toContain("event.type === 'spend.recorded' && !linked.has(event.eventId)");
  });

  it('it derives the day from the injected instant', () => {
    const days = [...live.matchAll(/toUtcAccountingDay\(([^)]*)\)/g)].map((m) => m[1]);
    // `now` inside the transcription, plus the suite's own fixed DAY constant.
    expect(new Set(days)).toEqual(new Set(['now', 'NOW']));
  });

  it('it gates on TEST_DATABASE_URL and never falls back', () => {
    expect(live).toContain("process.env['TEST_DATABASE_URL']");
    expect(live).not.toContain("process.env['DATABASE_URL']");
    expect(live).toContain('describe.skipIf(!hasTestDatabase)');
  });
});

describe('MONEY IS EXACT', () => {
  it('no float arithmetic anywhere in event ingest', () => {
    for (const float of ['parseFloat', 'toFixed', 'Number(', 'parseInt', 'Math.']) {
      expect(ingest, float).not.toContain(float);
    }
  });

  it('the amount comes from the TYPED field, never from payload', () => {
    expect(ingest).toContain('commitSpend(event.amount_usd)');
  });

  it('no exactly-once bookkeeping column was invented', () => {
    // Event identity plus one transaction already provides the guarantee. A
    // flag would be redundant state that could disagree with the event row.
    for (const flag of ['settled', 'accounted', 'processed', 'debited']) {
      expect(ingest, flag).not.toContain(flag);
    }
  });
});
