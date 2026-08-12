import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Authentication token generation and hashing.
 *
 * ENTROPY
 * -------
 * Tokens are 32 bytes (256 bits) from `crypto.randomBytes`, a CSPRNG, encoded
 * base64url to 43 URL-safe characters. At 256 bits, online guessing is
 * hopeless and offline enumeration of the hash space is infeasible.
 *
 * Explicitly NOT used: `Math.random` (not cryptographic), timestamps or
 * counters (predictable), or a UUID as the secret. A UUIDv4 carries ~122 bits
 * and, more importantly, is an *identifier* by convention - identifiers end up
 * in logs, URLs and support tickets, so using one as a bearer credential
 * invites disclosure.
 *
 * WHY SHA-256 AND NOT A PASSWORD HASH
 * -----------------------------------
 * bcrypt/argon2 exist to slow brute force against *low-entropy human secrets*.
 * These tokens are 256-bit CSPRNG output, so there is no dictionary to try and
 * no meaningful brute-force advantage to remove: a work factor would add
 * per-request latency while defending against nothing.
 *
 * A fast hash also permits the thing the design needs - an indexed equality
 * lookup on the digest - which a salted password hash cannot support without
 * scanning every row.
 *
 * What SHA-256 does provide, and what actually matters here, is one-wayness: a
 * database disclosure yields digests that cannot be replayed as credentials.
 */

/** 32 bytes = 256 bits of CSPRNG output. */
const TOKEN_BYTES = 32;

/** Length of the base64url encoding of 32 bytes, used for a cheap format check. */
const TOKEN_LENGTH = 43;

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

/** Generates a high-entropy, URL-safe bearer token. */
export function generateToken(): string {
  return randomBytes(TOKEN_BYTES).toString('base64url');
}

/**
 * Hashes a token for storage and lookup.
 *
 * Deterministic and unsalted by design: the digest IS the lookup key, so a
 * per-row salt would make indexed retrieval impossible. Safe precisely because
 * the input is 256-bit random material rather than a guessable secret.
 */
export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/**
 * Cheap structural check before touching the database.
 *
 * Rejects malformed input without a query, and keeps obviously bogus values out
 * of the data layer. It is a filter, not a security control - the security comes
 * from the hash lookup.
 */
export function isWellFormedToken(value: unknown): value is string {
  return typeof value === 'string' && value.length === TOKEN_LENGTH && TOKEN_PATTERN.test(value);
}

/**
 * Constant-time comparison of two hex digests.
 *
 * Database lookup is by equality on an indexed column, so the primary path does
 * not leak timing in a usefully exploitable way. This exists for any in-process
 * digest comparison, where a naive `===` short-circuits on the first differing
 * byte.
 */
export function safeCompareHex(a: string, b: string): boolean {
  if (a.length !== b.length) {
    return false;
  }
  const left = Buffer.from(a, 'hex');
  const right = Buffer.from(b, 'hex');
  if (left.length !== right.length || left.length === 0) {
    return false;
  }
  return timingSafeEqual(left, right);
}

export const TOKEN_ENTROPY_BYTES = TOKEN_BYTES;
export const TOKEN_ENCODED_LENGTH = TOKEN_LENGTH;
