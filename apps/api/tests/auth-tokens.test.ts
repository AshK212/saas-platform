import { describe, expect, it } from 'vitest';

import {
  generateToken,
  hashToken,
  isWellFormedToken,
  safeCompareHex,
  TOKEN_ENCODED_LENGTH,
  TOKEN_ENTROPY_BYTES,
} from '../src/auth/tokens';

describe('token entropy', () => {
  it('uses 256 bits of randomness', () => {
    expect(TOKEN_ENTROPY_BYTES).toBe(32);
  });

  it('produces URL-safe tokens of the documented length', () => {
    const token = generateToken();

    expect(token).toHaveLength(TOKEN_ENCODED_LENGTH);
    // base64url only: no +, / or = to be mangled in a URL or an email client.
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('never repeats across a large sample', () => {
    const tokens = new Set(Array.from({ length: 5_000 }, () => generateToken()));

    expect(tokens.size).toBe(5_000);
  });

  it('is not a UUID', () => {
    // A UUID is an identifier by convention and leaks into logs and URLs; it is
    // also lower entropy. Guard against a future "simplification".
    expect(generateToken()).not.toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-/i);
  });
});

describe('token hashing', () => {
  it('is deterministic, so the digest can be an indexed lookup key', () => {
    const token = generateToken();

    expect(hashToken(token)).toBe(hashToken(token));
  });

  it('produces a SHA-256 hex digest', () => {
    expect(hashToken('anything')).toMatch(/^[0-9a-f]{64}$/);
  });

  it('never returns the token itself', () => {
    const token = generateToken();
    const hash = hashToken(token);

    expect(hash).not.toBe(token);
    expect(hash).not.toContain(token);
  });

  it('is one-way for practical purposes: different tokens differ in digest', () => {
    expect(hashToken(generateToken())).not.toBe(hashToken(generateToken()));
  });

  it('is sensitive to a single character change', () => {
    const token = generateToken();
    const tweaked = `${token.slice(0, -1)}${token.endsWith('A') ? 'B' : 'A'}`;

    expect(hashToken(tweaked)).not.toBe(hashToken(token));
  });
});

describe('token format validation', () => {
  it('accepts a generated token', () => {
    expect(isWellFormedToken(generateToken())).toBe(true);
  });

  it.each([
    ['empty string', ''],
    ['too short', 'abc'],
    ['too long', 'a'.repeat(64)],
    ['base64 padding', `${'a'.repeat(42)}=`],
    ['sql fragment', "' OR 1=1 --"],
    ['path traversal', '../../etc/passwd'],
  ])('rejects %s', (_label, value) => {
    expect(isWellFormedToken(value)).toBe(false);
  });

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['number', 12_345],
    ['object', {}],
    ['array', []],
  ])('rejects non-string %s', (_label, value) => {
    expect(isWellFormedToken(value)).toBe(false);
  });
});

describe('safeCompareHex', () => {
  it('matches identical digests', () => {
    const hash = hashToken('x');

    expect(safeCompareHex(hash, hash)).toBe(true);
  });

  it('rejects different digests', () => {
    expect(safeCompareHex(hashToken('a'), hashToken('b'))).toBe(false);
  });

  it('rejects mismatched lengths without throwing', () => {
    expect(safeCompareHex('abcd', hashToken('a'))).toBe(false);
  });

  it('rejects empty input', () => {
    expect(safeCompareHex('', '')).toBe(false);
  });
});
