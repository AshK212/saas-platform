import type { ActionCategory, IngestEvent } from '@hybrid/contracts';
import { describe, expect, it } from 'vitest';

import {
  checkPrecheckLinkage,
  effectiveCategory,
  type SettlementReceipt,
} from '../src/events/settlement';

/**
 * The settlement rules, exhaustively, as a PURE FUNCTION.
 *
 * The route suite proves the rules are wired in and that a rejection rolls the
 * batch back. This proves the rules themselves are right across every
 * combination, which would be prohibitively slow to enumerate over HTTP.
 *
 * The property being defended is narrow and total: a linked event does not
 * debit, so the link must be TRUE. Anything this function wrongly accepts
 * becomes spend the plane records and never charges for.
 */

const AGENT = '33333333-3333-4333-8333-333333333333';
const OTHER_AGENT = '44444444-4444-4444-8444-444444444444';

const CATEGORIES: ActionCategory[] = ['llm_call', 'tool_call', 'spend', 'publish', 'other'];

function receipt(overrides: Partial<SettlementReceipt> = {}): SettlementReceipt {
  return {
    id: '55555555-5555-4555-8555-555555555555',
    agentId: AGENT,
    category: 'spend',
    decision: 'allow',
    requestedAmountUsd: '4.000000',
    requestedPublishCount: null,
    ...overrides,
  };
}

const spend = (overrides: Partial<IngestEvent> = {}): IngestEvent =>
  ({
    type: 'spend.recorded',
    event_id: 'evt-1',
    agent_id: 'agent-a',
    amount_usd: '4.000000',
    provider: 'openai',
    ...overrides,
  }) as IngestEvent;

const action = (category: ActionCategory, overrides: Partial<IngestEvent> = {}): IngestEvent =>
  ({
    type: 'agent.action',
    event_id: 'evt-1',
    agent_id: 'agent-a',
    category,
    ...overrides,
  }) as IngestEvent;

const blocked = (category: ActionCategory, overrides: Record<string, unknown> = {}): IngestEvent =>
  ({
    type: 'action.blocked',
    event_id: 'evt-1',
    agent_id: 'agent-a',
    category,
    rule: 'daily_spend_cap',
    reason: 'Daily spend cap reached.',
    ...(category === 'spend' ? { amount_usd: '4.000000' } : {}),
    ...(category === 'publish' ? { count: 1 } : {}),
    ...overrides,
  }) as IngestEvent;

const heartbeat = (): IngestEvent =>
  ({ type: 'heartbeat', event_id: 'evt-1', agent_id: 'agent-a' }) as IngestEvent;

/** Shorthand: did the check pass? */
const ok = (event: IngestEvent, r: SettlementReceipt, agentId = AGENT): boolean =>
  checkPrecheckLinkage(event, r, agentId).ok;

const why = (event: IngestEvent, r: SettlementReceipt, agentId = AGENT): string => {
  const result = checkPrecheckLinkage(event, r, agentId);
  return result.ok ? '' : result.message;
};

describe('the effective category reconciles two vocabularies', () => {
  it('spend.recorded is a spend, though it carries no category field', () => {
    // The event type already says what it is. This is the only place the event
    // vocabulary and the action-category vocabulary meet.
    expect(effectiveCategory(spend())).toBe('spend');
  });

  it.each(CATEGORIES)('agent.action reports its own category (%s)', (category) => {
    expect(effectiveCategory(action(category))).toBe(category);
  });

  it.each(CATEGORIES)('action.blocked reports its own category (%s)', (category) => {
    expect(effectiveCategory(blocked(category))).toBe(category);
  });

  it('a heartbeat has NO governed category', () => {
    expect(effectiveCategory(heartbeat())).toBeNull();
  });
});

describe('agent consistency', () => {
  it('accepts the agent the receipt was issued for', () => {
    expect(ok(spend(), receipt())).toBe(true);
  });

  it('REJECTS a receipt belonging to another agent', () => {
    // Otherwise one prechecked $4 absolves spend across the entire fleet.
    expect(why(spend(), receipt(), OTHER_AGENT)).toBe(
      'precheck_id belongs to a different agent.',
    );
  });

  it('checks the agent FIRST, before any other mismatch is reported', () => {
    // Ordering matters for the message a caller sees: the agent is the most
    // fundamental mismatch, and reporting a category error for someone else's
    // receipt would be misleading.
    const wrongEverything = receipt({ category: 'publish', decision: 'deny' });

    expect(why(spend(), wrongEverything, OTHER_AGENT)).toBe(
      'precheck_id belongs to a different agent.',
    );
  });

  it('compares INTERNAL uuids, not the wire agent id', () => {
    // The receipt stores `agents.id`; the wire carries `agents.external_id`.
    // Comparing the wire value would compare a name to a uuid and never match.
    expect(ok(spend({ agent_id: 'completely-different-name' } as Partial<IngestEvent>), receipt())).toBe(
      true,
    );
  });
});

describe('event type', () => {
  it('REJECTS a heartbeat carrying a precheck', () => {
    // A liveness ping is not the completion of a governed action.
    expect(why(heartbeat(), receipt())).toBe('A heartbeat cannot reference a precheck.');
  });

  it.each([
    ['spend.recorded', spend()],
    ['agent.action', action('spend')],
    ['action.blocked', blocked('spend')],
  ])('%s may reference a matching allow', (_label, event) => {
    expect(ok(event, receipt())).toBe(true);
  });
});

describe('decision consistency', () => {
  it.each([
    ['spend.recorded', spend()],
    ['agent.action', action('spend')],
  ])('%s REJECTS a denied receipt', (_label, event) => {
    // A denial is not permission. If this were allowed, every refused action
    // could report its spend as already accounted for.
    expect(why(event, receipt({ decision: 'deny' }))).toBe(
      'precheck_id references a denied decision.',
    );
  });

  it('action.blocked MAY reference a denied receipt', () => {
    // The coherent direction: a runtime reporting back the denial it received.
    expect(ok(blocked('spend'), receipt({ decision: 'deny' }))).toBe(true);
  });

  it('action.blocked MAY reference an allowed receipt', () => {
    // Also real: the plane allowed it, the runtime refused for its own reason.
    // Rejecting this would force a runtime to choose between reporting its
    // block and reporting which decision preceded it.
    expect(ok(blocked('spend'), receipt({ decision: 'allow' }))).toBe(true);
  });
});

describe('category consistency', () => {
  it.each(CATEGORIES.filter((c) => c !== 'spend'))(
    'REJECTS a %s receipt as spend.recorded evidence',
    (category) => {
      // An untracked category must not become spend authorization merely by
      // being referenced.
      expect(why(spend(), receipt({ category, requestedAmountUsd: null }))).toBe(
        `precheck_id references a ${category} decision, not spend.`,
      );
    },
  );

  it('every category matches only itself, across all 25 combinations', () => {
    const results: string[] = [];
    for (const eventCategory of CATEGORIES) {
      for (const receiptCategory of CATEGORIES) {
        const accepted = ok(
          action(eventCategory),
          receipt({ category: receiptCategory, requestedAmountUsd: null }),
        );
        if (accepted !== (eventCategory === receiptCategory)) {
          results.push(`${eventCategory} vs ${receiptCategory} -> ${String(accepted)}`);
        }
      }
    }

    expect(results).toEqual([]);
  });

  it('a spend receipt is not publish evidence', () => {
    expect(why(action('publish'), receipt({ category: 'spend' }))).toBe(
      'precheck_id references a spend decision, not publish.',
    );
  });
});

describe('AMOUNT CONSISTENCY', () => {
  it('accepts the exact authorized amount', () => {
    expect(ok(spend({ amount_usd: '4.000000' } as Partial<IngestEvent>), receipt())).toBe(true);
  });

  it.each(['4', '4.0', '4.00', '4.0000', '4.000000'])(
    'treats %s as the same money as 4.000000',
    (written) => {
      // All are valid wire forms of the same value. String equality would
      // reject four of these five.
      expect(ok(spend({ amount_usd: written } as Partial<IngestEvent>), receipt())).toBe(true);
    },
  );

  it('REJECTS an inflated amount', () => {
    expect(why(spend({ amount_usd: '400.000000' } as Partial<IngestEvent>), receipt())).toBe(
      'amount_usd does not match the amount this precheck authorized.',
    );
  });

  it('REJECTS an amount SMALLER than authorized', () => {
    // Under-reporting is also a mismatch. The receipt records what was
    // authorized and committed; an event claiming less is not evidence of it,
    // and treating it as settled would leave the difference unexplained.
    expect(ok(spend({ amount_usd: '1.000000' } as Partial<IngestEvent>), receipt())).toBe(false);
  });

  it('REJECTS a ONE MICRO-DOLLAR difference in either direction', () => {
    expect(ok(spend({ amount_usd: '4.000001' } as Partial<IngestEvent>), receipt())).toBe(false);
    expect(ok(spend({ amount_usd: '3.999999' } as Partial<IngestEvent>), receipt())).toBe(false);
  });

  it('distinguishes amounts a DOUBLE would conflate', () => {
    // 0.1 + 0.2 !== 0.3 in IEEE-754. A float comparison could accept a
    // mismatch here; micro-dollar bigint cannot.
    const r = receipt({ requestedAmountUsd: '0.300000' });

    expect(ok(spend({ amount_usd: '0.300000' } as Partial<IngestEvent>), r)).toBe(true);
    expect(ok(spend({ amount_usd: '0.300001' } as Partial<IngestEvent>), r)).toBe(false);
  });

  it('compares exactly at the top of the storable range', () => {
    const r = receipt({ requestedAmountUsd: '99999999.999999' });

    expect(ok(spend({ amount_usd: '99999999.999999' } as Partial<IngestEvent>), r)).toBe(true);
    expect(ok(spend({ amount_usd: '99999999.999998' } as Partial<IngestEvent>), r)).toBe(false);
  });

  it('REJECTS an amount when the receipt authorized none', () => {
    // A receipt with no amount cannot vouch for one. Reachable only through a
    // category match, so this is the last line of defence rather than the
    // first.
    expect(why(spend(), receipt({ requestedAmountUsd: null }))).toBe(
      'precheck_id references a decision with no authorized amount.',
    );
  });

  it('checks the amount on a blocked SPEND too', () => {
    const r = receipt({ decision: 'deny', requestedAmountUsd: '41.000000' });

    expect(ok(blocked('spend', { amount_usd: '41.000000' }), r)).toBe(true);
    expect(ok(blocked('spend', { amount_usd: '4.000000' }), r)).toBe(false);
  });

  it('has nothing to compare when the event carries no amount', () => {
    // `agent.action` has no amount field even for category spend. The absence
    // is not a mismatch; there is simply no claim to check.
    expect(ok(action('spend'), receipt())).toBe(true);
  });

  it('does not compare a publish COUNT', () => {
    // One precheck is one publish, and `agent.action` carries no count. There
    // is no quantity claim to verify - only that no second increment happens,
    // which is a property of the ingest path, not of this function.
    expect(ok(action('publish'), receipt({ category: 'publish', requestedAmountUsd: null, requestedPublishCount: 1 }))).toBe(
      true,
    );
  });
});

describe('the function is pure and total', () => {
  it('returns a message for every rejection', () => {
    const rejections = [
      checkPrecheckLinkage(spend(), receipt(), OTHER_AGENT),
      checkPrecheckLinkage(heartbeat(), receipt(), AGENT),
      checkPrecheckLinkage(spend(), receipt({ decision: 'deny' }), AGENT),
      checkPrecheckLinkage(spend(), receipt({ category: 'publish' }), AGENT),
      checkPrecheckLinkage(spend({ amount_usd: '9.000000' } as Partial<IngestEvent>), receipt(), AGENT),
      checkPrecheckLinkage(spend(), receipt({ requestedAmountUsd: null }), AGENT),
    ];

    for (const result of rejections) {
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.message.length).toBeGreaterThan(0);
        // Client-safe: no uuid, no internal id, no SQL.
        expect(result.message).not.toContain(AGENT);
        expect(result.message).not.toMatch(/select|from |where /i);
      }
    }
  });

  it('does not mutate the receipt it was given', () => {
    const r = receipt();
    const before = JSON.stringify(r);

    checkPrecheckLinkage(spend({ amount_usd: '400.000000' } as Partial<IngestEvent>), r, AGENT);
    checkPrecheckLinkage(spend(), r, AGENT);

    // Receipts are immutable historical evidence, including in memory.
    expect(JSON.stringify(r)).toBe(before);
  });

  it('is deterministic', () => {
    const r = receipt();
    const first = checkPrecheckLinkage(spend(), r, AGENT);
    const second = checkPrecheckLinkage(spend(), r, AGENT);

    expect(first).toEqual(second);
  });
});
