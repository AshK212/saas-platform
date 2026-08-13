import { describe, expect, it } from 'vitest';

import {
  actionBlockedEventSchema,
  agentActionEventSchema,
  decimalUsdSchema,
  eventIngestErrorSchema,
  eventIngestRequestSchema,
  eventIngestResponseSchema,
  eventSchema,
  heartbeatEventSchema,
  MAX_EVENTS_PER_BATCH,
  spendRecordedEventSchema,
  toValidationIssues,
  type IngestEvent,
} from '../src/events';

const AGENT = 'agent-a';
const PRECHECK_UUID = '11111111-1111-4111-8111-111111111111';

function heartbeat(eventId: string): IngestEvent {
  return { type: 'heartbeat', event_id: eventId, agent_id: AGENT };
}

describe('agent.action', () => {
  it.each(['llm_call', 'tool_call', 'spend', 'publish', 'other'] as const)(
    'accepts category %s',
    (category) => {
      const parsed = agentActionEventSchema.safeParse({
        type: 'agent.action',
        event_id: 'evt-1',
        agent_id: AGENT,
        category,
      });

      expect(parsed.success).toBe(true);
    },
  );

  it('requires a category', () => {
    // An action the plane cannot categorise cannot be governed.
    expect(
      agentActionEventSchema.safeParse({
        type: 'agent.action',
        event_id: 'evt-1',
        agent_id: AGENT,
      }).success,
    ).toBe(false);
  });

  it('rejects an unknown category', () => {
    expect(
      agentActionEventSchema.safeParse({
        type: 'agent.action',
        event_id: 'evt-1',
        agent_id: AGENT,
        category: 'database_write',
      }).success,
    ).toBe(false);
  });

  it('accepts optional occurred_at, precheck_id and payload', () => {
    const parsed = agentActionEventSchema.safeParse({
      type: 'agent.action',
      event_id: 'evt-1',
      agent_id: AGENT,
      category: 'llm_call',
      occurred_at: '2026-08-12T10:00:00.000Z',
      precheck_id: PRECHECK_UUID,
      payload: { model: 'gpt-x', tokens: 1200 },
    });

    expect(parsed.success).toBe(true);
  });
});

describe('spend.recorded', () => {
  it('accepts a decimal amount and provider', () => {
    const parsed = spendRecordedEventSchema.safeParse({
      type: 'spend.recorded',
      event_id: 'evt-101',
      agent_id: AGENT,
      amount_usd: '1.250000',
      provider: 'openai',
    });

    expect(parsed.success).toBe(true);
  });

  it.each([
    ['missing amount', { provider: 'openai' }],
    ['missing provider', { amount_usd: '1.000000' }],
    ['empty provider', { amount_usd: '1.000000', provider: '' }],
  ])('rejects %s', (_label, extra) => {
    expect(
      spendRecordedEventSchema.safeParse({
        type: 'spend.recorded',
        event_id: 'evt-101',
        agent_id: AGENT,
        ...extra,
      }).success,
    ).toBe(false);
  });

  it('accepts any vendor-neutral provider label', () => {
    // Not an enum - pinning today's vendors would couple governance to a list.
    for (const provider of ['openai', 'anthropic', 'internal', 'self-hosted-llama']) {
      expect(
        spendRecordedEventSchema.safeParse({
          type: 'spend.recorded',
          event_id: 'evt-1',
          agent_id: AGENT,
          amount_usd: '0.010000',
          provider,
        }).success,
        provider,
      ).toBe(true);
    }
  });

  it('rejects a category field - spend.recorded is already the category', () => {
    expect(
      spendRecordedEventSchema.safeParse({
        type: 'spend.recorded',
        event_id: 'evt-1',
        agent_id: AGENT,
        amount_usd: '1.000000',
        provider: 'openai',
        category: 'spend',
      }).success,
    ).toBe(false);
  });
});

describe('exact decimal USD', () => {
  it.each(['0', '0.000001', '0.100000', '1.250000', '25.000000', '41.000000', '99999999.999999'])(
    'accepts %s',
    (value) => {
      expect(decimalUsdSchema.safeParse(value).success, value).toBe(true);
    },
  );

  it('REJECTS a seventh decimal rather than rounding it', () => {
    // Silently rounding an authoritative amount is exactly the loss this
    // contract exists to prevent.
    expect(decimalUsdSchema.safeParse('0.0000009').success).toBe(false);
  });

  it.each([
    ['negative', '-5.000000'],
    ['positive sign', '+5.000000'],
    ['exponent', '4.1e1'],
    ['capital exponent', '4.1E1'],
    ['NaN', 'NaN'],
    ['Infinity', 'Infinity'],
    ['nine integer digits', '100000000.000000'],
    ['bare fraction', '.5'],
    ['trailing dot', '1.'],
    ['leading zero', '01.500000'],
    ['comma separator', '1,250.00'],
    ['whitespace', ' 1.00 '],
    ['currency symbol', '$1.00'],
    ['empty', ''],
  ])('rejects %s', (_label, value) => {
    expect(decimalUsdSchema.safeParse(value).success, value).toBe(false);
  });

  it('rejects a JSON number, forcing the string contract', () => {
    // A JSON number is an IEEE-754 double in every mainstream parser.
    expect(decimalUsdSchema.safeParse(1.25).success).toBe(false);
    expect(
      spendRecordedEventSchema.safeParse({
        type: 'spend.recorded',
        event_id: 'evt-1',
        agent_id: AGENT,
        amount_usd: 41.0,
        provider: 'openai',
      }).success,
    ).toBe(false);
  });

  it('stays inside numeric(14, 6) capacity', () => {
    // The largest representable value, and the first one that is not.
    expect(decimalUsdSchema.safeParse('99999999.999999').success).toBe(true);
    expect(decimalUsdSchema.safeParse('99999999.9999999').success).toBe(false);
  });
});

describe('action.blocked', () => {
  const base = {
    type: 'action.blocked' as const,
    event_id: 'evt-b1',
    agent_id: AGENT,
    rule: 'daily_publish_cap',
    reason: 'Daily publish cap reached',
  };

  it('accepts a publish denial with a count', () => {
    const parsed = actionBlockedEventSchema.safeParse({
      ...base,
      category: 'publish',
      count: 6,
      block_id: 'client-block-123',
    });

    expect(parsed.success).toBe(true);
  });

  it('accepts a spend denial with an amount', () => {
    const parsed = actionBlockedEventSchema.safeParse({
      ...base,
      category: 'spend',
      rule: 'daily_spend_cap',
      reason: 'Daily spend cap reached',
      amount_usd: '41.000000',
    });

    expect(parsed.success).toBe(true);
  });

  it('requires amount_usd for a spend denial (AC-08 explainability)', () => {
    expect(actionBlockedEventSchema.safeParse({ ...base, category: 'spend' }).success).toBe(false);
  });

  it('requires count for a publish denial (AC-11 explainability)', () => {
    expect(actionBlockedEventSchema.safeParse({ ...base, category: 'publish' }).success).toBe(
      false,
    );
  });

  it('rejects amount_usd on a non-spend denial', () => {
    // Ambiguous: which number explains the denial?
    expect(
      actionBlockedEventSchema.safeParse({
        ...base,
        category: 'publish',
        count: 6,
        amount_usd: '1.000000',
      }).success,
    ).toBe(false);
  });

  it('rejects count on a non-publish denial', () => {
    expect(
      actionBlockedEventSchema.safeParse({
        ...base,
        category: 'spend',
        amount_usd: '41.000000',
        count: 3,
      }).success,
    ).toBe(false);
  });

  it('makes block_id optional and treats it as an opaque string', () => {
    expect(
      actionBlockedEventSchema.safeParse({ ...base, category: 'other' }).success,
    ).toBe(true);
    expect(
      actionBlockedEventSchema.safeParse({
        ...base,
        category: 'other',
        block_id: 'client-block-123',
      }).success,
    ).toBe(true);
  });

  it.each([
    ['missing rule', { category: 'other', rule: undefined }],
    ['empty rule', { category: 'other', rule: '' }],
    ['missing reason', { category: 'other', reason: undefined }],
    ['empty reason', { category: 'other', reason: '' }],
    ['negative count', { category: 'publish', count: -1 }],
    ['fractional count', { category: 'publish', count: 1.5 }],
  ])('rejects %s', (_label, patch) => {
    expect(actionBlockedEventSchema.safeParse({ ...base, ...patch }).success).toBe(false);
  });
});

describe('heartbeat', () => {
  it('accepts the minimal shape', () => {
    expect(
      heartbeatEventSchema.safeParse({ type: 'heartbeat', event_id: 'hb-1', agent_id: AGENT })
        .success,
    ).toBe(true);
  });

  it.each([
    ['a spend amount', { amount_usd: '1.000000' }],
    ['a provider', { provider: 'openai' }],
    ['a category', { category: 'llm_call' }],
  ])('rejects a heartbeat carrying %s', (_label, extra) => {
    // A heartbeat that looked like it recorded spend would be an accounting
    // hole; strict rejects it rather than dropping the field.
    expect(
      heartbeatEventSchema.safeParse({
        type: 'heartbeat',
        event_id: 'hb-1',
        agent_id: AGENT,
        ...extra,
      }).success,
    ).toBe(false);
  });
});

describe('common envelope', () => {
  it.each([
    ['missing event_id', { agent_id: AGENT }],
    ['empty event_id', { event_id: '', agent_id: AGENT }],
    ['over-long event_id', { event_id: 'x'.repeat(201), agent_id: AGENT }],
    ['missing agent_id', { event_id: 'e1' }],
    ['empty agent_id', { event_id: 'e1', agent_id: '' }],
    ['over-long agent_id', { event_id: 'e1', agent_id: 'x'.repeat(121) }],
  ])('rejects %s', (_label, fields) => {
    expect(heartbeatEventSchema.safeParse({ type: 'heartbeat', ...fields }).success).toBe(false);
  });

  it('accepts a non-UUID event_id', () => {
    // Agent ecosystems generate ULIDs, KSUIDs and prefixed ids.
    for (const id of ['evt_01HX', '01ARZ3NDEKTSV4RRFFQ69G5FAV', 'hb-123']) {
      expect(heartbeatEventSchema.safeParse(heartbeat(id)).success, id).toBe(true);
    }
  });

  it.each([
    ['no timezone', '2026-08-12T10:00:00'],
    ['date only', '2026-08-12'],
    ['garbage', 'yesterday'],
    ['epoch number', 1_754_995_200],
  ])('rejects occurred_at that is %s', (_label, occurredAt) => {
    expect(
      heartbeatEventSchema.safeParse({ ...heartbeat('e1'), occurred_at: occurredAt }).success,
    ).toBe(false);
  });

  it.each([
    ['not a uuid', 'precheck-1'],
    ['truncated uuid', '11111111-1111-4111-8111'],
  ])('rejects precheck_id that is %s', (_label, precheckId) => {
    expect(
      heartbeatEventSchema.safeParse({ ...heartbeat('e1'), precheck_id: precheckId }).success,
    ).toBe(false);
  });

  it('keeps event_id, precheck_id and block_id as distinct identities', () => {
    const parsed = actionBlockedEventSchema.parse({
      type: 'action.blocked',
      event_id: 'evt-1',
      agent_id: AGENT,
      category: 'other',
      rule: 'r',
      reason: 'why',
      precheck_id: PRECHECK_UUID,
      block_id: 'client-block-1',
    });

    expect(parsed.event_id).not.toBe(parsed.precheck_id);
    expect(parsed.event_id).not.toBe(parsed.block_id);
    expect(parsed.precheck_id).not.toBe(parsed.block_id);
  });
});

describe('strict envelopes reject unknown fields', () => {
  it('rejects a mistyped amount field instead of silently dropping it', () => {
    // The motivating case: this must NOT become a valid spend with no amount.
    const parsed = spendRecordedEventSchema.safeParse({
      type: 'spend.recorded',
      event_id: 'evt-1',
      agent_id: AGENT,
      amout_usd: '41.00',
      provider: 'openai',
    });

    expect(parsed.success).toBe(false);
  });

  it.each([
    ['workspace_id', { workspace_id: '11111111-1111-4111-8111-111111111111' }],
    ['workspaceId', { workspaceId: '11111111-1111-4111-8111-111111111111' }],
    ['tenant_id', { tenant_id: 'acme' }],
    ['tenantId', { tenantId: 'acme' }],
  ])('rejects tenant authority field %s', (_label, extra) => {
    expect(heartbeatEventSchema.safeParse({ ...heartbeat('e1'), ...extra }).success).toBe(false);
  });

  it.each([
    ['mode', { mode: 'paused' }],
    ['daily_spend_cap_usd', { daily_spend_cap_usd: '0.000000' }],
    ['daily_publish_cap', { daily_publish_cap: 0 }],
    ['policy_version', { policy_version: 2 }],
    ['paused', { paused: true }],
  ])('rejects policy mutation field %s', (_label, extra) => {
    // Events describe what happened; they never change what is permitted.
    expect(heartbeatEventSchema.safeParse({ ...heartbeat('e1'), ...extra }).success).toBe(false);
  });

  it.each([
    ['api_key', { api_key: 'hmp_live_x' }],
    ['authorization', { authorization: 'Bearer x' }],
    ['session_token', { session_token: 'x' }],
    ['share_token', { share_token: 'x' }],
  ])('rejects credential field %s', (_label, extra) => {
    expect(heartbeatEventSchema.safeParse({ ...heartbeat('e1'), ...extra }).success).toBe(false);
  });

  it('rejects an internal database id being passed as the agent identity', () => {
    expect(
      heartbeatEventSchema.safeParse({ ...heartbeat('e1'), agent_uuid: PRECHECK_UUID }).success,
    ).toBe(false);
  });
});

describe('payload extensibility', () => {
  it('accepts arbitrary runtime metadata', () => {
    expect(
      heartbeatEventSchema.safeParse({
        ...heartbeat('e1'),
        payload: { region: 'eu', nested: { attempt: 2 }, tags: ['a', 'b'] },
      }).success,
    ).toBe(true);
  });

  it.each(['workspace_id', 'workspaceId', 'tenant_id', 'tenantId'])(
    'rejects %s inside the payload',
    (key) => {
      // A tripwire: putting tenancy in the payload signals a misunderstanding.
      expect(
        heartbeatEventSchema.safeParse({ ...heartbeat('e1'), payload: { [key]: 'x' } }).success,
      ).toBe(false);
    },
  );

  it('does not let a governed field hide in the payload', () => {
    // amount_usd inside payload is inert metadata, NOT a spend amount - the
    // event is still a heartbeat and records no money.
    const parsed = heartbeatEventSchema.parse({
      ...heartbeat('e1'),
      payload: { amount_usd: '41.000000' },
    });

    expect(parsed.type).toBe('heartbeat');
    expect(parsed).not.toHaveProperty('amount_usd');
  });

  it('rejects a non-object payload', () => {
    for (const payload of ['string', 42, true, ['a']]) {
      expect(heartbeatEventSchema.safeParse({ ...heartbeat('e1'), payload }).success).toBe(false);
    }
  });
});

describe('batch request', () => {
  it('accepts a mixed batch of every event type', () => {
    const parsed = eventIngestRequestSchema.safeParse({
      events: [
        { type: 'heartbeat', event_id: 'e1', agent_id: AGENT },
        { type: 'agent.action', event_id: 'e2', agent_id: AGENT, category: 'llm_call' },
        {
          type: 'spend.recorded',
          event_id: 'e3',
          agent_id: AGENT,
          amount_usd: '1.250000',
          provider: 'openai',
        },
        {
          type: 'action.blocked',
          event_id: 'e4',
          agent_id: AGENT,
          category: 'publish',
          rule: 'daily_publish_cap',
          reason: 'cap reached',
          count: 6,
        },
      ],
    });

    expect(parsed.success).toBe(true);
  });

  it('rejects an empty batch', () => {
    expect(eventIngestRequestSchema.safeParse({ events: [] }).success).toBe(false);
  });

  it('rejects a missing events array', () => {
    expect(eventIngestRequestSchema.safeParse({}).success).toBe(false);
  });

  it(`accepts exactly ${String(MAX_EVENTS_PER_BATCH)} events`, () => {
    const events = Array.from({ length: MAX_EVENTS_PER_BATCH }, (_v, i) =>
      heartbeat(`e${String(i)}`),
    );

    expect(eventIngestRequestSchema.safeParse({ events }).success).toBe(true);
  });

  it('rejects an oversized batch', () => {
    const events = Array.from({ length: MAX_EVENTS_PER_BATCH + 1 }, (_v, i) =>
      heartbeat(`e${String(i)}`),
    );

    expect(eventIngestRequestSchema.safeParse({ events }).success).toBe(false);
  });

  it('REJECTS duplicate event_id within one batch', () => {
    // Almost certainly a client bug, and it would make accepted/duplicates
    // counts ambiguous. Cross-request replay is a different, supported path.
    const parsed = eventIngestRequestSchema.safeParse({
      events: [heartbeat('same'), heartbeat('other'), heartbeat('same')],
    });

    if (parsed.success) {
      expect.unreachable('duplicate event_id must be rejected');
    }
    expect(JSON.stringify(parsed.error.issues)).toContain('Duplicate event_id');
  });

  it('rejects unknown top-level request fields', () => {
    expect(
      eventIngestRequestSchema.safeParse({
        events: [heartbeat('e1')],
        workspace_id: '11111111-1111-4111-8111-111111111111',
      }).success,
    ).toBe(false);
  });

  it('rejects the whole batch when one event is invalid', () => {
    // No partial acceptance: the caller must never be unsure what landed.
    const parsed = eventIngestRequestSchema.safeParse({
      events: [heartbeat('e1'), { type: 'spend.recorded', event_id: 'e2', agent_id: AGENT }],
    });

    expect(parsed.success).toBe(false);
  });
});

describe('response and error contracts', () => {
  it('accepts an aggregate ingest result', () => {
    expect(eventIngestResponseSchema.safeParse({ accepted: 3, duplicates: 2 }).success).toBe(true);
  });

  it('supports the AC-13 replay shape', () => {
    // Second submission of the same batch: nothing new, all duplicates, 200.
    expect(eventIngestResponseSchema.safeParse({ accepted: 0, duplicates: 5 }).success).toBe(true);
  });

  it.each([
    ['negative accepted', { accepted: -1, duplicates: 0 }],
    ['fractional duplicates', { accepted: 0, duplicates: 1.5 }],
    ['extra field', { accepted: 1, duplicates: 0, failed: 2 }],
  ])('rejects %s', (_label, body) => {
    expect(eventIngestResponseSchema.safeParse(body).success).toBe(false);
  });

  it('produces client-safe validation issues with no Zod internals', () => {
    const parsed = eventIngestRequestSchema.safeParse({
      events: [{ type: 'spend.recorded', event_id: 'e1', agent_id: AGENT }],
    });
    if (parsed.success) {
      expect.unreachable('incomplete spend event must be rejected');
    }

    const issues = toValidationIssues(parsed.error);
    const body = { error: 'invalid_batch' as const, issues };

    expect(eventIngestErrorSchema.safeParse(body).success).toBe(true);
    for (const issue of issues) {
      // Path and message only - no code, no expected/received, no union detail.
      expect(Object.keys(issue).sort()).toEqual(['message', 'path']);
    }
  });

  it('caps the number of reported issues', () => {
    const events = Array.from({ length: 30 }, (_v, i) => ({
      type: 'spend.recorded',
      event_id: `e${String(i)}`,
      agent_id: AGENT,
    }));
    const parsed = eventIngestRequestSchema.safeParse({ events });
    if (parsed.success) {
      expect.unreachable('batch of incomplete spend events must be rejected');
    }

    expect(toValidationIssues(parsed.error).length).toBeLessThanOrEqual(20);
  });
});

describe('discriminated union routing', () => {
  it('rejects an unknown event type', () => {
    expect(
      eventSchema.safeParse({ type: 'agent.thought', event_id: 'e1', agent_id: AGENT }).success,
    ).toBe(false);
  });

  it('rejects a missing type', () => {
    expect(eventSchema.safeParse({ event_id: 'e1', agent_id: AGENT }).success).toBe(false);
  });

  it('reports the problem against the correct variant', () => {
    const parsed = eventSchema.safeParse({
      type: 'spend.recorded',
      event_id: 'e1',
      agent_id: AGENT,
      provider: 'openai',
    });
    if (parsed.success) {
      expect.unreachable('spend event without an amount must be rejected');
    }

    // Discriminated: the issue names the missing amount, not "no union member".
    expect(JSON.stringify(parsed.error.issues)).toContain('amount_usd');
  });
});
