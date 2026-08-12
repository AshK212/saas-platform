import { randomUUID } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  API_KEY_ID_LENGTH,
  API_KEY_NAMESPACE,
  API_KEY_PREFIX_LENGTH,
  API_KEY_SECRET_BYTES,
  API_KEY_SECRET_LENGTH,
  generateApiKey,
  hashApiKey,
  parseApiKey,
} from '../src/api-keys/tokens';

describe('key format', () => {
  it('uses the documented namespace and fixed-width shape', () => {
    const { key, keyPrefix } = generateApiKey();

    expect(key.startsWith(`${API_KEY_NAMESPACE}_`)).toBe(true);
    expect(keyPrefix).toHaveLength(API_KEY_PREFIX_LENGTH);
    expect(keyPrefix.slice(`${API_KEY_NAMESPACE}_`.length)).toHaveLength(API_KEY_ID_LENGTH);
    expect(key.slice(API_KEY_PREFIX_LENGTH + 1)).toHaveLength(API_KEY_SECRET_LENGTH);
  });

  it('parses correctly even when the random halves contain underscores', () => {
    // base64url includes '_', so a naive split('_') parser would fail
    // intermittently depending on the bytes drawn.
    let sawUnderscore = false;
    for (let i = 0; i < 500; i += 1) {
      const generated = generateApiKey();
      const body = generated.key.slice(`${API_KEY_NAMESPACE}_`.length);
      if (body.includes('_', API_KEY_ID_LENGTH + 1) || body.slice(0, API_KEY_ID_LENGTH).includes('_')) {
        sawUnderscore = true;
      }
      expect(parseApiKey(generated.key)?.keyPrefix).toBe(generated.keyPrefix);
    }
    expect(sawUnderscore, 'expected the sample to include underscore-bearing keys').toBe(true);
  });

  it('is URL and header safe', () => {
    const { key } = generateApiKey();

    // base64url plus underscores as separators - nothing needing encoding.
    expect(key).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('exposes the prefix as the leading portion of the key', () => {
    const { key, keyPrefix } = generateApiKey();

    expect(key.startsWith(`${keyPrefix}_`)).toBe(true);
  });
});

describe('entropy', () => {
  it('uses 256 bits for the secret half', () => {
    expect(API_KEY_SECRET_BYTES).toBe(32);
  });

  it('does not repeat across a large sample', () => {
    const keys = new Set(Array.from({ length: 5_000 }, () => generateApiKey().key));

    expect(keys.size).toBe(5_000);
  });

  it('does not repeat the public prefix either', () => {
    // The prefix is unique in the database, so collisions matter operationally.
    const prefixes = new Set(Array.from({ length: 5_000 }, () => generateApiKey().keyPrefix));

    expect(prefixes.size).toBe(5_000);
  });

  it('keeps the public prefix free of secret material', () => {
    const { key, keyPrefix } = generateApiKey();
    const secret = key.slice(keyPrefix.length + 1);

    // The prefix is independent random material, so no part of the secret can
    // be recovered from it.
    expect(keyPrefix).not.toContain(secret);
    expect(secret).not.toContain(keyPrefix);
  });

  it('cannot authenticate from the prefix alone', () => {
    const { key, keyPrefix } = generateApiKey();

    expect(parseApiKey(keyPrefix)).toBeNull();
    expect(hashApiKey(keyPrefix)).not.toBe(hashApiKey(key));
  });
});

describe('hashing', () => {
  it('is deterministic, so the digest can be an indexed lookup key', () => {
    const { key } = generateApiKey();

    expect(hashApiKey(key)).toBe(hashApiKey(key));
  });

  it('produces a SHA-256 hex digest', () => {
    expect(hashApiKey('anything')).toMatch(/^[0-9a-f]{64}$/);
  });

  it('never returns the plaintext', () => {
    const { key, secretHash } = generateApiKey();

    expect(secretHash).not.toBe(key);
    expect(secretHash).not.toContain(key);
    // Nor any recognisable fragment of it.
    expect(secretHash).not.toContain(key.slice(-12));
  });

  it('covers the full key, binding prefix and secret together', () => {
    const { key, secretHash } = generateApiKey();
    const secretOnly = key.slice(API_KEY_PREFIX_LENGTH + 1);

    // Hashing only the secret half would let the two halves be recombined.
    expect(secretHash).toBe(hashApiKey(key));
    expect(secretHash).not.toBe(hashApiKey(secretOnly));
  });

  it('is sensitive to a single character change', () => {
    const { key } = generateApiKey();
    const tweaked = `${key.slice(0, -1)}${key.endsWith('A') ? 'B' : 'A'}`;

    expect(hashApiKey(tweaked)).not.toBe(hashApiKey(key));
  });
});

describe('parsing', () => {
  it('accepts a generated key and derives matching lookup values', () => {
    const generated = generateApiKey();

    const parsed = parseApiKey(generated.key);

    expect(parsed?.keyPrefix).toBe(generated.keyPrefix);
    expect(parsed?.secretHash).toBe(generated.secretHash);
  });

  it('rejects a UUID', () => {
    // A UUID is an identifier, not a credential - and lower entropy.
    expect(parseApiKey(randomUUID())).toBeNull();
  });

  it.each([
    ['empty string', ''],
    ['wrong namespace', 'stripe_live_AbCdEfGhIjKl_' + 'a'.repeat(43)],
    ['missing secret', 'hmp_live_AbCdEfGhIjKl'],
    ['extra segment', `hmp_live_AbCdEfGhIjKl_${'a'.repeat(43)}_extra`],
    ['short key id', `hmp_live_short_${'a'.repeat(43)}`],
    ['short secret', 'hmp_live_AbCdEfGhIjKl_tooshort'],
    ['non base64url chars', `hmp_live_AbCdEfGhIjK!_${'a'.repeat(43)}`],
    ['sql fragment', "' OR 1=1 --"],
    ['bearer prefix included', `Bearer hmp_live_AbCdEfGhIjKl_${'a'.repeat(43)}`],
  ])('rejects %s', (_label, value) => {
    expect(parseApiKey(value)).toBeNull();
  });

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['number', 12_345],
    ['object', {}],
  ])('rejects non-string %s', (_label, value) => {
    expect(parseApiKey(value)).toBeNull();
  });

  it('a structurally valid but unissued key parses yet will not authenticate', () => {
    // Parsing is a cheap filter, not a security control.
    const forged = `hmp_live_${'A'.repeat(12)}_${'B'.repeat(43)}`;

    expect(parseApiKey(forged)).not.toBeNull();
  });
});

describe('no weak randomness', () => {
  it('the token module does not reference Math.random', async () => {
    const { readFileSync } = await import('node:fs');
    const path = await import('node:path');
    const { fileURLToPath } = await import('node:url');

    const source = readFileSync(
      path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'api-keys', 'tokens.ts'),
      'utf8',
    );

    // Comments are stripped so documentation that NAMES the forbidden API -
    // explaining why it is not used - is not a false positive.
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

    expect(code).not.toContain('Math.random');
    expect(code).toContain('randomBytes');
  });
});
