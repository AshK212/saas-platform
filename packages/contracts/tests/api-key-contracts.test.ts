import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import * as contracts from '../src/index';
import {
  apiKeyListResponseSchema,
  apiKeySummarySchema,
  createApiKeyResponseSchema,
  issuedApiKeySchema,
} from '../src/api-keys';

/**
 * Guardrails for the credential contracts.
 *
 * A contract field is the single most likely place a future handler will
 * populate without thinking, so the surface itself is asserted rather than
 * relying on each handler being careful.
 */

const CONTRACTS_SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');

const FORBIDDEN_FIELDS = ['secretHash', 'secret_hash', 'hash', 'secret', 'token', 'password'];

/** Keys a schema accepts, discovered by parsing a maximal object. */
function schemaKeys(schema: { shape: Record<string, unknown> }): string[] {
  return Object.keys(schema.shape);
}

describe('no hash or secret reaches a client contract', () => {
  it.each([
    ['apiKeySummarySchema', apiKeySummarySchema],
    ['issuedApiKeySchema', issuedApiKeySchema],
  ])('%s exposes no hash-like field', (_label, schema) => {
    for (const key of schemaKeys(schema)) {
      expect(FORBIDDEN_FIELDS.filter((f) => f !== 'token')).not.toContain(key);
    }
  });

  it('summary metadata carries no plaintext key at all', () => {
    // The list/revoke surfaces must be incapable of returning a key.
    expect(schemaKeys(apiKeySummarySchema)).not.toContain('key');
  });

  it('plaintext exists in exactly one contract', () => {
    const withPlaintext = Object.entries(contracts)
      .filter(([name]) => name.endsWith('Schema'))
      .filter(([, value]) => {
        const shape = (value as { shape?: Record<string, unknown> }).shape;
        return shape !== undefined && Object.keys(shape).includes('key');
      })
      .map(([name]) => name);

    expect(withPlaintext).toEqual(['issuedApiKeySchema']);
  });

  it('the issuance response is the only wrapper carrying a key', () => {
    const issuance = createApiKeyResponseSchema.shape.apiKey;
    const listItem = apiKeyListResponseSchema.shape.apiKeys;

    expect(schemaKeys(issuance as never)).toContain('key');
    expect(JSON.stringify(listItem)).not.toContain('"key"');
  });

  it('no contract source file mentions a secret hash', () => {
    for (const file of readdirSync(CONTRACTS_SRC).filter((f) => f.endsWith('.ts'))) {
      const source = readFileSync(path.join(CONTRACTS_SRC, file), 'utf8');
      const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

      expect(code, file).not.toContain('secretHash');
      expect(code, file).not.toContain('secret_hash');
    }
  });
});

describe('no per-key permission surface exists', () => {
  it('credential contracts define no scopes, permissions or expiry', () => {
    const source = readFileSync(path.join(CONTRACTS_SRC, 'api-keys.ts'), 'utf8');
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

    // Every key is simply workspace-bound. A partially-enforced capability
    // field would be worse than none.
    for (const forbidden of ['scopes', 'permissions', 'capabilities', 'expiresAt']) {
      expect(code, forbidden).not.toContain(forbidden);
    }
  });

  it('no policy, precheck or ledger contract has been added yet', () => {
    // `agents.ts` arrived in Step 8 and `events.ts` in Step 9. These three
    // belong to later steps and must not appear early.
    const files = readdirSync(CONTRACTS_SRC);

    expect(files).not.toContain('policy.ts');
    expect(files).not.toContain('precheck.ts');
    expect(files).not.toContain('ledger.ts');
    expect(files).not.toContain('receipts.ts');
  });

  it('the agent contract carries no policy or credential surface', () => {
    const source = readFileSync(path.join(CONTRACTS_SRC, 'agents.ts'), 'utf8');
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

    // Registration must not be a route to policy, caps or tenant selection.
    for (const forbidden of ['mode', 'cap', 'paused', 'policy', 'secret', 'workspace_id']) {
      expect(code, forbidden).not.toContain(forbidden);
    }
  });
});

describe('issuance response shape', () => {
  it('accepts a full issued key', () => {
    const parsed = createApiKeyResponseSchema.safeParse({
      apiKey: {
        id: '11111111-1111-4111-8111-111111111111',
        name: 'Simulator',
        keyPrefix: 'hmp_live_AbCdEfGhIjKl',
        status: 'active',
        createdAt: new Date().toISOString(),
        lastUsedAt: null,
        revokedAt: null,
        key: `hmp_live_AbCdEfGhIjKl_${'a'.repeat(43)}`,
      },
    });

    expect(parsed.success).toBe(true);
  });

  it('rejects a summary that smuggles an extra field', () => {
    // Zod strips unknown keys by default, so a leaked hash cannot survive
    // serialisation through the contract.
    const parsed = apiKeySummarySchema.parse({
      id: '11111111-1111-4111-8111-111111111111',
      name: 'Simulator',
      keyPrefix: 'hmp_live_AbCdEfGhIjKl',
      status: 'revoked',
      createdAt: new Date().toISOString(),
      lastUsedAt: null,
      revokedAt: new Date().toISOString(),
      secretHash: 'a'.repeat(64),
    });

    expect(Object.keys(parsed)).not.toContain('secretHash');
  });
});
