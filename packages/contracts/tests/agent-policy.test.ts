import { describe, expect, it } from 'vitest';

import {
  agentPolicyMutationRequestSchema,
  agentPolicyPath,
  agentPolicyResponseSchema,
  normalizePublishCapInput,
  normalizeSpendCapInput,
} from '../src/agent-policy';

/**
 * Operator policy mutation contract.
 *
 * The normalisation helpers get the most attention here because they sit
 * between an operator's keystrokes and a `numeric(14,6)` column that decides
 * whether a spend cap is exceeded. A silent round in either direction is a
 * money defect, so every rejection below is a value that must NOT be quietly
 * fixed up.
 */

const VALID = {
  mode: 'budgeted',
  daily_spend_cap_usd: '25.000000',
  daily_publish_cap: 5,
} as const;

describe('the request is a complete, strict policy', () => {
  it('accepts a full policy', () => {
    expect(agentPolicyMutationRequestSchema.safeParse(VALID).success).toBe(true);
  });

  it.each(['mode', 'daily_spend_cap_usd', 'daily_publish_cap'])(
    'requires %s',
    (field) => {
      const partial: Record<string, unknown> = { ...VALID };
      delete partial[field];

      // PUT semantics: a partial body would make "clear the cap" and "leave it
      // alone" indistinguishable.
      expect(agentPolicyMutationRequestSchema.safeParse(partial).success).toBe(false);
    },
  );

  it.each([
    ['workspace_id', { workspace_id: 'x' }],
    ['workspaceId', { workspaceId: 'x' }],
    ['tenant_id', { tenant_id: 'x' }],
    ['version', { version: '99' }],
    ['agent_id', { agent_id: 'other' }],
    ['api_key', { api_key: 'hmp_live_x' }],
    ['a typo', { daily_spend_cap: '25' }],
  ])('rejects an extra %s field', (_label, extra) => {
    expect(agentPolicyMutationRequestSchema.safeParse({ ...VALID, ...extra }).success).toBe(false);
  });

  it('accepts only the locked modes', () => {
    for (const mode of ['watch', 'budgeted', 'paused']) {
      expect(agentPolicyMutationRequestSchema.safeParse({ ...VALID, mode }).success, mode).toBe(
        true,
      );
    }
    for (const mode of ['enforce', 'disabled', 'unrestricted', 'WATCH', '']) {
      expect(agentPolicyMutationRequestSchema.safeParse({ ...VALID, mode }).success, mode).toBe(
        false,
      );
    }
  });

  it('rejects a JSON number spend cap', () => {
    // IEEE-754 would make 25.00 arrive as 25.000000000000004 in some clients.
    expect(
      agentPolicyMutationRequestSchema.safeParse({ ...VALID, daily_spend_cap_usd: 25 }).success,
    ).toBe(false);
  });

  it('accepts null for both caps', () => {
    expect(
      agentPolicyMutationRequestSchema.safeParse({
        mode: 'watch',
        daily_spend_cap_usd: null,
        daily_publish_cap: null,
      }).success,
    ).toBe(true);
  });

  it('the response carries only policy and version', () => {
    const parsed = agentPolicyResponseSchema.safeParse({
      policy: { agent_id: 'agent-a', ...VALID },
      version: '2',
    });

    expect(parsed.success).toBe(true);
    // Strict: no internal row id, no workspace id, no other agent.
    expect(
      agentPolicyResponseSchema.safeParse({
        policy: { agent_id: 'agent-a', ...VALID },
        version: '2',
        workspace_id: 'x',
      }).success,
    ).toBe(false);
  });

  it('builds an escaped path', () => {
    expect(agentPolicyPath('ws 1', 'ag/1')).toBe('/v1/workspaces/ws%201/agents/ag%2F1/policy');
  });
});

describe('spend cap normalisation', () => {
  it.each([
    ['25', '25.000000'],
    ['25.0', '25.000000'],
    ['25.00', '25.000000'],
    ['25.000000', '25.000000'],
    ['0', '0.000000'],
    ['0.000000', '0.000000'],
    ['0.1', '0.100000'],
    ['0.000001', '0.000001'],
    ['99999999.999999', '99999999.999999'],
    ['  25  ', '25.000000'],
  ])('normalises %s to %s', (raw, expected) => {
    expect(normalizeSpendCapInput(raw)).toBe(expected);
  });

  it('treats blank as uncapped', () => {
    expect(normalizeSpendCapInput('')).toBeNull();
    expect(normalizeSpendCapInput('   ')).toBeNull();
  });

  it.each([
    ['negative', '-5'],
    ['a plus sign', '+5'],
    ['exponent notation', '2.5e1'],
    ['seven decimals', '1.0000001'],
    ['nine integer digits', '100000000'],
    ['a leading zero', '025'],
    ['a bare dot', '.5'],
    ['a trailing dot', '25.'],
    ['a thousands separator', '1,000'],
    ['a currency symbol', '$25'],
    ['text', 'twenty five'],
    ['NaN', 'NaN'],
    ['Infinity', 'Infinity'],
    ['hex', '0x19'],
    ['two dots', '25.0.0'],
  ])('refuses %s rather than rounding it', (_label, raw) => {
    expect(normalizeSpendCapInput(raw)).toBeUndefined();
  });

  it('produces output the wire contract accepts', () => {
    for (const raw of ['25', '0', '0.1', '99999999.999999']) {
      const normalized = normalizeSpendCapInput(raw);
      expect(
        agentPolicyMutationRequestSchema.safeParse({
          ...VALID,
          daily_spend_cap_usd: normalized,
        }).success,
        raw,
      ).toBe(true);
    }
  });

  it('uses no floating point', () => {
    // 0.1 + 0.2 style drift is the failure this avoids. Pure string padding
    // means the digits typed are the digits stored.
    expect(normalizeSpendCapInput('0.1')).toBe('0.100000');
    expect(normalizeSpendCapInput('0.3')).toBe('0.300000');
    expect(normalizeSpendCapInput.toString()).not.toMatch(/parseFloat|toFixed|Number\(/);
  });
});

describe('publish cap normalisation', () => {
  it.each([
    ['0', 0],
    ['5', 5],
    ['100', 100],
    ['2147483647', 2_147_483_647],
    ['  5  ', 5],
  ])('normalises %s to %i', (raw, expected) => {
    expect(normalizePublishCapInput(raw)).toBe(expected);
  });

  it('treats blank as uncapped', () => {
    expect(normalizePublishCapInput('')).toBeNull();
  });

  it.each([
    ['a decimal', '5.5'],
    ['negative', '-1'],
    ['a plus sign', '+5'],
    ['a leading zero', '05'],
    ['exponent notation', '1e3'],
    ['text', 'five'],
    ['above int4', '2147483648'],
    ['absurd', '99999999999'],
  ])('refuses %s rather than truncating it', (_label, raw) => {
    expect(normalizePublishCapInput(raw)).toBeUndefined();
  });

  it('produces output the wire contract accepts', () => {
    for (const raw of ['0', '5', '2147483647']) {
      expect(
        agentPolicyMutationRequestSchema.safeParse({
          ...VALID,
          daily_publish_cap: normalizePublishCapInput(raw),
        }).success,
        raw,
      ).toBe(true);
    }
  });

  it('keeps ZERO distinct from blank', () => {
    // 0 = nothing permitted. null = no limit.
    expect(normalizePublishCapInput('0')).toBe(0);
    expect(normalizePublishCapInput('')).toBeNull();
  });
});
