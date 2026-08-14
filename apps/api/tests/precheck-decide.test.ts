import type { ActionCategory } from '@hybrid/contracts';
import { describe, expect, it } from 'vitest';

import { decide, requiresLedger, type AppliedPolicy } from '../src/precheck/decide';

/**
 * The governance decision, exhaustively.
 *
 * This is the part that must be exactly right: it decides whether money may be
 * spent. Being a pure function, every branch is testable without a database,
 * and the cap boundaries are asserted to the micro-dollar.
 */

const ALL_CATEGORIES: ActionCategory[] = ['llm_call', 'tool_call', 'spend', 'publish', 'other'];

const ZERO_USAGE = { spendCommittedUsd: '0.000000', publishCountCommitted: 0 } as const;

const watch: AppliedPolicy = { mode: 'watch', dailySpendCapUsd: null, dailyPublishCap: null };
const paused: AppliedPolicy = { mode: 'paused', dailySpendCapUsd: null, dailyPublishCap: null };
const budgeted = (spend: string | null, publish: number | null): AppliedPolicy => ({
  mode: 'budgeted',
  dailySpendCapUsd: spend,
  dailyPublishCap: publish,
});

describe('watch mode', () => {
  it.each(ALL_CATEGORIES)('allows %s', (category) => {
    const decision = decide({
      category,
      amountUsd: category === 'spend' ? '41.000000' : undefined,
      policy: watch,
      usage: ZERO_USAGE,
    });

    expect(decision.allow).toBe(true);
    expect(decision.reason).toBeUndefined();
  });

  it('NEVER commits, even a $41 spend', () => {
    // Observation mode must not silently behave as budgeted accounting. An
    // operator who has not opted into enforcement has not opted into having
    // usage counted against them either.
    const decision = decide({
      category: 'spend',
      amountUsd: '41.000000',
      policy: watch,
      usage: ZERO_USAGE,
    });

    expect(decision.commit).toBe('none');
  });

  it('never commits a publish', () => {
    expect(decide({ category: 'publish', policy: watch, usage: ZERO_USAGE }).commit).toBe('none');
  });

  it('reports no remaining', () => {
    // There is no cap to have headroom against.
    expect(
      decide({ category: 'spend', amountUsd: '1.000000', policy: watch, usage: ZERO_USAGE })
        .remaining,
    ).toBeNull();
  });

  it('ignores caps that happen to be set', () => {
    // Mode governs; a cap left over from a previous `budgeted` period must not
    // take effect while the operator has chosen watch.
    const withCaps: AppliedPolicy = {
      mode: 'watch',
      dailySpendCapUsd: '5.000000',
      dailyPublishCap: 1,
    };
    const decision = decide({
      category: 'spend',
      amountUsd: '999.000000',
      policy: withCaps,
      usage: { spendCommittedUsd: '900.000000', publishCountCommitted: 99 },
    });

    expect(decision.allow).toBe(true);
    expect(decision.commit).toBe('none');
  });

  it('requires no ledger lock', () => {
    for (const category of ALL_CATEGORIES) {
      expect(requiresLedger(category, 'watch'), category).toBe(false);
    }
  });
});

describe('paused mode', () => {
  it.each(ALL_CATEGORIES)('DENIES %s', (category) => {
    // A pause is a kill switch, not a budget: an agent that can still act "a
    // bit" is not paused. `other` is denied too.
    const decision = decide({
      category,
      amountUsd: category === 'spend' ? '0.000001' : undefined,
      policy: paused,
      usage: ZERO_USAGE,
    });

    expect(decision.allow).toBe(false);
    expect(decision.reason).toBe('paused');
    expect(decision.commit).toBe('none');
  });

  it('reports no remaining, because the denial is not cap-based', () => {
    expect(decide({ category: 'publish', policy: paused, usage: ZERO_USAGE }).remaining).toBeNull();
  });

  it('denies even with headroom available', () => {
    const pausedWithCaps: AppliedPolicy = {
      mode: 'paused',
      dailySpendCapUsd: '100.000000',
      dailyPublishCap: 10,
    };

    expect(
      decide({ category: 'spend', amountUsd: '1.000000', policy: pausedWithCaps, usage: ZERO_USAGE })
        .allow,
    ).toBe(false);
  });

  it('requires no ledger lock', () => {
    for (const category of ALL_CATEGORIES) {
      expect(requiresLedger(category, 'paused'), category).toBe(false);
    }
  });
});

describe('budgeted, untracked categories', () => {
  it.each<ActionCategory>(['llm_call', 'tool_call', 'other'])('allows %s with no cap', (category) => {
    // The locked Credit contract defines no accounting limit for these.
    // Inventing one would enforce a budget nobody configured.
    const decision = decide({ category, policy: budgeted('25.000000', 5), usage: ZERO_USAGE });

    expect(decision.allow).toBe(true);
    expect(decision.commit).toBe('none');
    expect(decision.remaining).toBeNull();
  });

  it.each<ActionCategory>(['llm_call', 'tool_call', 'other'])(
    '%s requires no ledger lock',
    (category) => {
      expect(requiresLedger(category, 'budgeted')).toBe(false);
    },
  );

  it('allows them even when the spend cap is exhausted', () => {
    // A tool call is not spend. Exhausting the money budget must not stop an
    // agent from doing things that cost nothing.
    const decision = decide({
      category: 'tool_call',
      policy: budgeted('25.000000', null),
      usage: { spendCommittedUsd: '25.000000', publishCountCommitted: 0 },
    });

    expect(decision.allow).toBe(true);
  });
});

describe('budgeted spend cap', () => {
  it('AC-07 SHAPE: 20 then 5 then 0.000001 against a $25 cap', () => {
    const cap = budgeted('25.000000', null);

    const first = decide({
      category: 'spend',
      amountUsd: '20.000000',
      policy: cap,
      usage: ZERO_USAGE,
    });
    expect(first.allow).toBe(true);
    expect(first.commit).toBe('spend');
    expect(first.remaining).toEqual({ kind: 'usd', value: '5.000000' });

    const second = decide({
      category: 'spend',
      amountUsd: '5.000000',
      policy: cap,
      usage: { spendCommittedUsd: '20.000000', publishCountCommitted: 0 },
    });
    // Spending the last cent of a budget is WITHIN it: prospective <= cap.
    expect(second.allow).toBe(true);
    expect(second.remaining).toEqual({ kind: 'usd', value: '0.000000' });

    const third = decide({
      category: 'spend',
      amountUsd: '0.000001',
      policy: cap,
      usage: { spendCommittedUsd: '25.000000', publishCountCommitted: 0 },
    });
    // One micro-dollar past the cap is over it.
    expect(third.allow).toBe(false);
    expect(third.reason).toBe('daily_spend_cap_exceeded');
    expect(third.commit).toBe('none');
    expect(third.remaining).toEqual({ kind: 'usd', value: '0.000000' });
  });

  it('AC-08 SHAPE: $41 against a $25 cap denies with full headroom reported', () => {
    const decision = decide({
      category: 'spend',
      amountUsd: '41.000000',
      policy: budgeted('25.000000', null),
      usage: ZERO_USAGE,
    });

    expect(decision.allow).toBe(false);
    expect(decision.reason).toBe('daily_spend_cap_exceeded');
    expect(decision.commit).toBe('none');
    // Remaining reflects CURRENT committed usage, not the refused request.
    // Subtracting what was denied would report headroom never consumed.
    expect(decision.remaining).toEqual({ kind: 'usd', value: '25.000000' });
  });

  it.each([
    ['20.000000', '5.000000', true, '0.000000'],
    ['20.000000', '4.999999', true, '0.000001'],
    ['20.000000', '5.000001', false, '5.000000'],
    ['0.000000', '25.000000', true, '0.000000'],
    ['24.999999', '0.000001', true, '0.000000'],
    ['25.000000', '0.000000', true, '0.000000'],
  ])(
    'committed %s + requested %s against $25 -> allow=%s remaining=%s',
    (committed, requested, allow, remaining) => {
      const decision = decide({
        category: 'spend',
        amountUsd: requested,
        policy: budgeted('25.000000', null),
        usage: { spendCommittedUsd: committed, publishCountCommitted: 0 },
      });

      expect(decision.allow).toBe(allow);
      expect(decision.remaining).toEqual({ kind: 'usd', value: remaining });
    },
  );

  it('a zero-amount spend at the cap is allowed', () => {
    // prospective == cap, which is within it. Nothing is consumed.
    const decision = decide({
      category: 'spend',
      amountUsd: '0.000000',
      policy: budgeted('25.000000', null),
      usage: { spendCommittedUsd: '25.000000', publishCountCommitted: 0 },
    });

    expect(decision.allow).toBe(true);
    expect(decision.commit).toBe('spend');
  });

  it('uses exact arithmetic where floats would drift', () => {
    // 10.10 + 10.20 + 4.70 is exactly 25.00; as doubles it is
    // 24.999999999999996, which would leave phantom headroom.
    const decision = decide({
      category: 'spend',
      amountUsd: '4.700000',
      policy: budgeted('25.000000', null),
      usage: { spendCommittedUsd: '20.300000', publishCountCommitted: 0 },
    });

    expect(decision.allow).toBe(true);
    expect(decision.remaining).toEqual({ kind: 'usd', value: '0.000000' });
  });

  it('FLOORS remaining at zero when a cap was lowered below usage', () => {
    // The operator dropped a $100 cap to $25 after $41 was spent. The honest
    // answer is no headroom, never "-16".
    const decision = decide({
      category: 'spend',
      amountUsd: '1.000000',
      policy: budgeted('25.000000', null),
      usage: { spendCommittedUsd: '41.000000', publishCountCommitted: 0 },
    });

    expect(decision.allow).toBe(false);
    expect(decision.remaining).toEqual({ kind: 'usd', value: '0.000000' });
  });

  it('a zero cap denies any positive spend', () => {
    const decision = decide({
      category: 'spend',
      amountUsd: '0.000001',
      policy: budgeted('0.000000', null),
      usage: ZERO_USAGE,
    });

    expect(decision.allow).toBe(false);
    expect(decision.remaining).toEqual({ kind: 'usd', value: '0.000000' });
  });

  it('requires a ledger lock', () => {
    expect(requiresLedger('spend', 'budgeted')).toBe(true);
  });

  it('does not touch the publish counter', () => {
    expect(
      decide({
        category: 'spend',
        amountUsd: '1.000000',
        policy: budgeted('25.000000', 5),
        usage: ZERO_USAGE,
      }).commit,
    ).toBe('spend');
  });
});

describe('budgeted publish cap', () => {
  it('AC-11 SHAPE: a cap of 5 allows the first five and denies the sixth', () => {
    const policy = budgeted(null, 5);
    const outcomes = Array.from({ length: 6 }, (_v, i) =>
      decide({
        category: 'publish',
        policy,
        usage: { spendCommittedUsd: '0.000000', publishCountCommitted: i },
      }),
    );

    expect(outcomes.map((o) => o.allow)).toEqual([true, true, true, true, true, false]);
    expect(outcomes.slice(0, 5).map((o) => o.remaining)).toEqual([
      { kind: 'publish', value: 4 },
      { kind: 'publish', value: 3 },
      { kind: 'publish', value: 2 },
      { kind: 'publish', value: 1 },
      { kind: 'publish', value: 0 },
    ]);
    expect(outcomes[5]?.reason).toBe('daily_publish_cap_exceeded');
    expect(outcomes[5]?.commit).toBe('none');
    expect(outcomes[5]?.remaining).toEqual({ kind: 'publish', value: 0 });
  });

  it('increments by exactly one', () => {
    // One precheck is one intended publish; the contract accepts no count.
    expect(
      decide({
        category: 'publish',
        policy: budgeted(null, 5),
        usage: { spendCommittedUsd: '0.000000', publishCountCommitted: 2 },
      }).remaining,
    ).toEqual({ kind: 'publish', value: 2 });
  });

  it('a zero cap denies the first publish', () => {
    const decision = decide({ category: 'publish', policy: budgeted(null, 0), usage: ZERO_USAGE });

    expect(decision.allow).toBe(false);
    expect(decision.remaining).toEqual({ kind: 'publish', value: 0 });
  });

  it('floors remaining at zero when the count already exceeds the cap', () => {
    const decision = decide({
      category: 'publish',
      policy: budgeted(null, 5),
      usage: { spendCommittedUsd: '0.000000', publishCountCommitted: 9 },
    });

    expect(decision.allow).toBe(false);
    expect(decision.remaining).toEqual({ kind: 'publish', value: 0 });
  });

  it('does not touch committed spend', () => {
    expect(
      decide({ category: 'publish', policy: budgeted('25.000000', 5), usage: ZERO_USAGE }).commit,
    ).toBe('publish');
  });

  it('requires a ledger lock', () => {
    expect(requiresLedger('publish', 'budgeted')).toBe(true);
  });
});

describe('budgeted but UNCAPPED still records', () => {
  it('allows and COMMITS a spend with a null cap', () => {
    // The ledger is authoritative committed usage independent of whether a cap
    // currently exists. If an operator adds a cap later today, the morning's
    // spend is already counted rather than silently forgiven.
    const decision = decide({
      category: 'spend',
      amountUsd: '41.000000',
      policy: budgeted(null, null),
      usage: ZERO_USAGE,
    });

    expect(decision.allow).toBe(true);
    expect(decision.commit).toBe('spend');
    expect(decision.remaining).toBeNull();
  });

  it('allows and COMMITS a publish with a null cap', () => {
    const decision = decide({
      category: 'publish',
      policy: budgeted(null, null),
      usage: { spendCommittedUsd: '0.000000', publishCountCommitted: 99 },
    });

    expect(decision.allow).toBe(true);
    expect(decision.commit).toBe('publish');
    expect(decision.remaining).toBeNull();
  });

  it('an uncapped spend still needs the ledger lock', () => {
    // It commits, so it must be serialized like any other commit.
    expect(requiresLedger('spend', 'budgeted')).toBe(true);
  });

  it('a null spend cap does not uncap publishes', () => {
    const decision = decide({
      category: 'publish',
      policy: budgeted(null, 2),
      usage: { spendCommittedUsd: '0.000000', publishCountCommitted: 2 },
    });

    expect(decision.allow).toBe(false);
  });
});

describe('the two counters never interfere', () => {
  it('an exhausted publish cap does not block spend', () => {
    const decision = decide({
      category: 'spend',
      amountUsd: '1.000000',
      policy: budgeted('25.000000', 5),
      usage: { spendCommittedUsd: '0.000000', publishCountCommitted: 99 },
    });

    expect(decision.allow).toBe(true);
  });

  it('an exhausted spend cap does not block publish', () => {
    const decision = decide({
      category: 'publish',
      policy: budgeted('25.000000', 5),
      usage: { spendCommittedUsd: '25.000000', publishCountCommitted: 0 },
    });

    expect(decision.allow).toBe(true);
  });
});
