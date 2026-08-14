import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * SOURCE GUARDRAILS for precheck-linked event settlement (Step 18).
 *
 * The behavioural suites prove the code is right today. These defend the
 * properties that would fail SILENTLY - where a wrong implementation still
 * returns 200, still stores the event, and only shows up as money that was
 * spent but never charged.
 *
 * Four things must stay true:
 *
 *   1. The linked path cannot reach the ledger. Not "does not"; CANNOT - the
 *      module imports no ledger repository at all.
 *   2. The receipt lookup is workspace-scoped IN SQL, never compared in JS.
 *   3. The duplicate decision precedes every side-effectful or rejecting step.
 *   4. Receipts stay immutable: no consumption flag, no settlement writer.
 *
 * Each is mutation-probed in the Step 18 report.
 */

const API_SRC = path.resolve(import.meta.dirname, '..', 'src');
const DB_SRC = path.resolve(API_SRC, '..', '..', '..', 'packages', 'db', 'src');

function read(file: string): string {
  return readFileSync(file, 'utf8');
}

/** Source with comments stripped, so prose about a pattern cannot trip it. */
function code(file: string): string {
  return read(file)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '');
}

const INGEST_STORE = path.join(API_SRC, 'events', 'store.ts');
const SETTLEMENT = path.join(API_SRC, 'events', 'settlement.ts');
const RECEIPTS_REPO = path.join(DB_SRC, 'repositories', 'receipts.ts');

describe('THE LINKED EVENT PATH CANNOT DEBIT THE LEDGER', () => {
  /**
   * Step 19 gave event ingest a ledger, so "imports nothing" is no longer the
   * invariant. The narrower - and now load-bearing - one is that the debit is
   * gated on the ABSENCE of a validated receipt, in exactly two places.
   */
  it('EVERY ledger commit is gated on the absence of a precheck', () => {
    const source = code(INGEST_STORE);

    // PROBE C. Both the lock-selection filter and the debit itself carry the
    // same guard, so neither can drift without the other.
    const commits = [...source.matchAll(/await ledger\.commitSpend\(/g)];
    expect(commits).toHaveLength(1);

    for (const gate of [
      "event.type === 'spend.recorded' && !linkedReceipt.has(index)",
    ]) {
      // Once for the lock set, once for the debit.
      expect([...source.matchAll(new RegExp(gate.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'))])
        .toHaveLength(2);
    }
  });

  it('the classification is receipt PRESENCE, never receipt content', () => {
    const source = code(INGEST_STORE);

    // A `watch` precheck committed nothing. If the debit keyed off the
    // receipt's mode instead of its presence, a watch-linked event would
    // retroactively commit on its behalf.
    expect(source).not.toContain('appliedMode');
    expect(source).not.toMatch(/receipt\.(?:decision|category|appliedMode)\s*===[\s\S]{0,80}commitSpend/);
  });

  it('event ingest never commits a publish', () => {
    const source = code(INGEST_STORE);

    // Publishes are counted by the precheck only. There is no
    // `publish.recorded` event, and an `agent.action` reporting one must not
    // increment a counter the precheck already moved.
    expect(source).not.toContain('commitPublish');
  });

  it('event ingest never READS the ledger for a decision', () => {
    const source = code(INGEST_STORE);

    // Recording is not deciding: nothing here compares committed usage to
    // anything. `findDailyLedger` is the observability read and has no place
    // on a write path.
    expect(source).not.toContain('findDailyLedger');
  });

  it('the settlement rules touch no persistence at all', () => {
    const source = code(SETTLEMENT);

    // A pure function over an event and a receipt. It cannot debit because it
    // cannot reach anything.
    for (const forbidden of [
      'createLedgerRepository',
      'commitSpend',
      'commitPublish',
      '.insert(',
      '.update(',
      '.delete(',
      '.transaction(',
      'await ',
    ]) {
      expect(source, forbidden).not.toContain(forbidden);
    }
  });

  it('the settlement module imports only money helpers from the db package', () => {
    const source = code(SETTLEMENT);
    const dbImport = /import\s*\{([\s\S]*?)\}\s*from\s*'@hybrid\/db'/.exec(source);

    expect(dbImport).not.toBeNull();
    const imported = (dbImport?.[1] ?? '')
      .split(',')
      .map((name) => name.trim())
      .filter((name) => name.length > 0)
      .sort();

    // Exactly the exact-arithmetic tools, and nothing that can reach a table.
    expect(imported).toEqual(['MoneyError', 'parseUsdToMicros']);
  });

  it('event ingest reads no policy', () => {
    const source = code(INGEST_STORE);

    // Events never change or consult what is permitted.
    for (const policy of [
      'createPolicyReadRepository',
      'createPolicyMutationRepository',
      'listEffectivePolicies',
      'agentPolicies',
    ]) {
      expect(source, policy).not.toContain(policy);
    }
  });

  it('event ingest creates no plane-owned block', () => {
    const source = code(INGEST_STORE);

    // A runtime block reported by the client is legitimate; a PLANE block is
    // the control plane's own denial, and ingest makes no decisions.
    expect(source).toContain('resolveOrCreateRuntimeBlock');
    expect(source).not.toContain('createPlaneBlockRepository');
    expect(source).not.toContain('createForDeniedPrecheck');
  });
});

describe('MONEY IS COMPARED EXACTLY', () => {
  it('the amount check uses micro-dollar bigint, never a float', () => {
    const source = code(SETTLEMENT);

    // A comparison deciding whether $400 passes as $4 is the last place a
    // double belongs.
    expect(source).toContain('parseUsdToMicros');
    for (const float of ['parseFloat', 'Number(', 'toFixed', 'parseInt', '* 100', 'Math.']) {
      expect(source, float).not.toContain(float);
    }
  });

  it('it fails closed on an unparseable amount', () => {
    const source = code(SETTLEMENT);

    // An amount we cannot parse is an amount we cannot claim matches.
    expect(source).toContain('MoneyError');
    expect(source).toMatch(/catch[\s\S]{0,200}return false/);
  });

  it('the amount comes from a TYPED field, never from payload', () => {
    const source = code(SETTLEMENT);

    // `payload` is inert by construction. A governance-critical number hidden
    // in free-form JSON is the silent hole the strict contract prevents.
    expect(source).toContain('event.amount_usd');
    expect(source).not.toContain('payload');
  });
});

describe('THE RECEIPT LOOKUP IS WORKSPACE-SCOPED IN SQL', () => {
  it('findById carries the tenant predicate', () => {
    const source = code(RECEIPTS_REPO);

    // PROBE C. Fetching globally and comparing workspace ids in JavaScript
    // would make a forgotten comparison a cross-tenant leak.
    expect(source).toMatch(
      /findById:[\s\S]{0,400}?\.where\(and\(receiptScopePredicate\(scope\), eq\(precheckReceipts\.id, receiptId\)\)\)/,
    );
  });

  it('every receipt read in the repository is scoped', () => {
    const source = code(RECEIPTS_REPO);

    // Counting rather than spot-checking: a new query added without the
    // predicate changes the balance and fails here.
    const selects = [...source.matchAll(/\.from\(precheckReceipts\)/g)].length;
    const scoped = [...source.matchAll(/receiptScopePredicate\(scope\)/g)].length;

    expect(selects).toBeGreaterThan(0);
    expect(scoped).toBeGreaterThanOrEqual(selects);
  });

  it('ingest never compares a workspace id in JavaScript', () => {
    const source = code(INGEST_STORE);

    expect(source).not.toMatch(/workspaceId\s*===|===\s*\w*[Ww]orkspaceId/);
    // The scope comes from the credential and goes into the repository.
    expect(source).toContain('const scope = credential.scope;');
  });

  it('the settlement rules do not attempt tenancy themselves', () => {
    const source = code(SETTLEMENT);

    // Tenancy is enforced one level up, by the receipt never being returned.
    // A second check here would imply the first might be missing.
    expect(source).not.toContain('workspaceId');
    expect(source).not.toContain('scope');
  });
});

describe('THE DUPLICATE DECISION STILL COMES FIRST', () => {
  const source = code(INGEST_STORE);

  const positionOf = (needle: string): number => {
    const at = source.indexOf(needle);
    if (at < 0) expect.unreachable(`store.ts no longer contains ${needle}`);
    return at;
  };

  it('settlement validation happens after the duplicate check', () => {
    // PROBE B. Settlement is side-effect-free but it can REJECT. Running it
    // first would turn a replay carrying a stale or forged precheck_id into a
    // 400 instead of a duplicate - the changed-replay defect in a new form.
    expect(positionOf('eventRepo.findByEventId(')).toBeLessThan(
      positionOf('receiptRepo.findById('),
    );
    expect(positionOf('eventRepo.findByEventId(')).toBeLessThan(
      positionOf('checkPrecheckLinkage('),
    );
  });

  it('the duplicate branch does not examine the linkage', () => {
    // The `continue` must be reached before anything reads precheck_id.
    const duplicateBranch = source.slice(
      positionOf('eventRepo.findByEventId('),
      positionOf('agentRepo.discover('),
    );

    expect(duplicateBranch).toContain('duplicates += 1');
    expect(duplicateBranch).toContain('continue');
    expect(duplicateBranch).not.toContain('precheck_id');
  });

  it('linkage validation runs inside the ingest transaction', () => {
    // A separate transaction could commit the event and then fail validation,
    // or validate against a receipt that rolls back underneath it.
    expect(positionOf('db.transaction(')).toBeLessThan(positionOf('receiptRepo.findById('));
    // Exactly one transaction in the whole module.
    expect([...source.matchAll(/\.transaction\(/g)]).toHaveLength(1);
    // The repositories are built on the transaction handle, never on `db`.
    expect(source).toContain('createPrecheckReceiptRepository(tx, scope)');
  });

  it('a rejected linkage rolls the whole batch back', () => {
    expect(source).toContain('throw new UnresolvedReferenceError(unresolved)');
    // Collected and thrown after the loop, so no partial batch commits.
    expect(positionOf('unresolved.push(')).toBeLessThan(
      positionOf('throw new UnresolvedReferenceError'),
    );
  });
});

describe('RECEIPTS REMAIN IMMUTABLE', () => {
  it('the receipt repository still has no update or delete', () => {
    const source = code(RECEIPTS_REPO);

    // Step 18 adds a READ. Nothing here may become writable.
    expect(source).not.toContain('.update(');
    expect(source).not.toContain('.delete(');
    const inserts = [...source.matchAll(/\.insert\(/g)];
    expect(inserts).toHaveLength(1);
  });

  it('there is no consumption flag anywhere', () => {
    // Marking a receipt "settled" would make historical evidence mutable, and
    // would need its own concurrency story. The linkage lives on the EVENT.
    for (const file of [INGEST_STORE, SETTLEMENT, RECEIPTS_REPO]) {
      const source = code(file);
      for (const flag of ['consumed', 'settledAt', 'settled_at', 'isSettled', 'markSettled']) {
        expect(source, `${path.basename(file)}: ${flag}`).not.toContain(flag);
      }
    }
  });

  it('no generic receipt-consumption writer exists', () => {
    const source = code(INGEST_STORE);

    for (const writer of ['receiptRepo.insert(', 'receiptRepo.update(', 'consumeReceipt']) {
      expect(source, writer).not.toContain(writer);
    }
  });

  it('the linkage is stored on the EVENT row', () => {
    const source = code(INGEST_STORE);

    expect(source).toContain('linkedReceipt.set(index, receipt.id)');
    expect(source).toContain('precheckReceiptId: linkedReceipt.get(index)');
  });
});

describe('the live transcription has not drifted', () => {
  /**
   * `packages/db` cannot import from `apps/`, so its live suite transcribes
   * the ingest path rather than calling it. The live suite is the ONLY place
   * both the precheck debit and the event path touch one real `ledger_daily`,
   * so a drift there would quietly remove the strongest evidence for the
   * headline claim.
   *
   * `apps/api` depends on both packages and is the only place they can be
   * compared.
   */
  const liveRaw = read(
    path.join(DB_SRC, '..', 'tests', 'settlement.live.test.ts'),
  );
  const live = liveRaw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

  it('the transcription exists and names its source', () => {
    expect(live).toContain('async function settleEvent(');
    expect(liveRaw).toContain('apps/api/src/events/store.ts');
  });

  it('it takes the duplicate decision first, exactly as production does', () => {
    const duplicateAt = live.indexOf('eventRepo.findByEventId(');
    const receiptAt = live.indexOf('receiptRepo.findById(');
    const insertAt = live.indexOf('eventRepo.insertIfNew(');

    expect(duplicateAt).toBeGreaterThan(-1);
    expect(duplicateAt).toBeLessThan(receiptAt);
    expect(duplicateAt).toBeLessThan(insertAt);
  });

  /**
   * The transcribed ingest function ALONE.
   *
   * Scoped deliberately: the seeding helper legitimately commits to the ledger
   * and the assertions legitimately read `precheckReceipts` directly - that is
   * the precheck half and the verification half. Only the ingest half is under
   * these rules, so a file-wide check would flag correct code forever.
   */
  const settleBody = live.slice(
    live.indexOf('async function settleEvent('),
    live.indexOf('describe.skipIf'),
  );

  it('it resolves the receipt through the SAME scoped repository method', () => {
    expect(settleBody).toContain('createPrecheckReceiptRepository(tx, scope)');
    expect(settleBody).toContain('receiptRepo.findById(');
    // Never a hand-rolled query, which could omit the tenant predicate.
    expect(settleBody).not.toContain('.from(precheckReceipts)');
    expect(settleBody).not.toContain('.select(');
  });

  it('THE TRANSCRIBED PATH NEVER DEBITS', () => {
    expect(settleBody.length).toBeGreaterThan(0);
    for (const ledger of ['lockDailyLedger', 'commitSpend', 'commitPublish', 'ledgerDaily']) {
      expect(settleBody, ledger).not.toContain(ledger);
    }
  });

  it('it compares money as exact integers, never as floats', () => {
    expect(live).toContain('function toMicros(');
    expect(live).toContain('1_000_000n');
    for (const float of ['parseFloat', 'toFixed']) {
      expect(live, float).not.toContain(float);
    }
  });

  it('it applies the same five rules in the same order', () => {
    const order = [
      'receipt.agentId !== agent.id',
      'category === null',
      "receipt.decision === 'deny'",
      'receipt.category !== category',
      'toMicros(event.amountUsd) !== toMicros(receipt.requestedAmountUsd)',
    ].map((needle) => live.indexOf(needle));

    expect(order).not.toContain(-1);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it('it gates on TEST_DATABASE_URL and never falls back', () => {
    expect(live).toContain("process.env['TEST_DATABASE_URL']");
    expect(live).not.toContain("process.env['DATABASE_URL']");
    expect(live).toContain('describe.skipIf(!hasTestDatabase)');
  });
});

describe('the fake and production share one rule', () => {
  it('the memory event store calls checkPrecheckLinkage rather than reimplementing it', () => {
    // A transcribed copy could drift and quietly accept a claim production
    // rejects, making every route test prove the wrong thing.
    const fake = code(path.join(API_SRC, '..', 'tests', 'helpers', 'memory-event-store.ts'));

    expect(fake).toContain('checkPrecheckLinkage(');
    expect(fake).toContain("from '../../src/events/settlement'");
  });

  it('the fake debits on the SAME gate as production', () => {
    // Step 19 gave the fake a ledger on purpose - shared with the precheck
    // fake, so `$4 not $8` is a real in-process assertion rather than a
    // property that holds because the event store had nowhere to write.
    //
    // It must classify identically, or the route tests prove the wrong thing.
    const fake = code(path.join(API_SRC, '..', 'tests', 'helpers', 'memory-event-store.ts'));

    expect(fake).toContain("event.type === 'spend.recorded' && precheckReceiptId === null");
    expect([...fake.matchAll(/\.commitSpend\(/g)]).toHaveLength(1);

    // Same server instant, same day derivation as production. Scoped to the
    // ARGUMENT of the day derivation: storing `occurred_at` on the event row
    // is correct and has nothing to do with which day is debited.
    const days = [...fake.matchAll(/toUtcAccountingDay\(([^)]*)\)/g)].map((m) => m[1]);
    expect(days).toEqual(['now']);
  });

  it('both fakes share ONE ledger', () => {
    // Production has one `ledger_daily`. Two independent fakes would make a
    // double debit unobservable in process.
    const eventFake = code(path.join(API_SRC, '..', 'tests', 'helpers', 'memory-event-store.ts'));
    const precheckFake = code(
      path.join(API_SRC, '..', 'tests', 'helpers', 'memory-precheck-store.ts'),
    );

    for (const fake of [eventFake, precheckFake]) {
      expect(fake).toContain("from './memory-ledger'");
      expect(fake).toContain('shared');
    }
  });
});
