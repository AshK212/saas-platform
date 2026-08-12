import { createHash, randomBytes } from 'node:crypto';

/**
 * API-key generation, parsing and hashing.
 *
 * FORMAT
 * ------
 *   hmp_live_<keyId>_<secret>
 *
 *   hmp      product marker (Hybrid Multi-agent Platform)
 *   live     environment/version marker - lets a future `hmp_test_` or a
 *            `hmp_live2_` rotation coexist without ambiguity
 *   keyId    12 base64url chars = 9 bytes = 72 bits. PUBLIC.
 *   secret   43 base64url chars = 32 bytes = 256 bits. SECRET.
 *
 * Example shape (not a real key): `hmp_live_AbCdEfGhIjKl_<43 chars>`
 *
 * WHY THE PUBLIC ID IS SEPARATE RANDOM MATERIAL
 * ---------------------------------------------
 * The common alternative is to use the first N characters of the secret as the
 * lookup prefix. That works, but it publishes part of the secret: storing an
 * 8-character prefix would expose ~48 bits of it. Generating `keyId`
 * independently means the stored `key_prefix` reveals *nothing* about the
 * secret, and the secret keeps its full 256 bits.
 *
 * The prefix is an identifier, never authority - see `hashApiKey`.
 *
 * ENTROPY
 * -------
 * Both halves come from `crypto.randomBytes`, a CSPRNG. Explicitly NOT used:
 * `Math.random` (not cryptographic), timestamps or counters (predictable), or a
 * UUID as the secret (~122 bits, and identifiers leak into logs and URLs).
 *
 * HASHING
 * -------
 * `secret_hash = SHA-256(full key string)`, hex.
 *
 * The digest covers the FULL key, prefix included, so a row cannot be matched
 * by a key carrying a different prefix - the two halves are cryptographically
 * bound rather than merely stored side by side.
 *
 * SHA-256 rather than bcrypt/argon2 for the same reason as Step 5's session
 * tokens: password hashes exist to slow brute force against low-entropy human
 * secrets. Against 256-bit CSPRNG output there is no dictionary to try, so a
 * work factor would add per-request latency while defending against nothing -
 * and would prevent the indexed equality lookup authentication needs. What
 * SHA-256 does provide, and what matters, is one-wayness: a database disclosure
 * yields digests that cannot be replayed as credentials.
 */

const KEY_PREFIX_NAMESPACE = 'hmp_live';

/** 9 bytes -> 12 base64url chars. Public. */
const KEY_ID_BYTES = 9;
const KEY_ID_LENGTH = 12;

/** 32 bytes -> 43 base64url chars. Secret. */
const SECRET_BYTES = 32;
const SECRET_LENGTH = 43;

const BASE64URL = /^[A-Za-z0-9_-]+$/;

/** A freshly generated key, split into the parts persistence needs. */
export interface GeneratedApiKey {
  /** Full plaintext. Returned to the operator ONCE, never stored. */
  readonly key: string;
  /** Non-secret public half stored as `key_prefix`. */
  readonly keyPrefix: string;
  /** SHA-256 of `key`, stored as `secret_hash`. */
  readonly secretHash: string;
}

/** Generates a new API key. The plaintext exists only in the returned object. */
export function generateApiKey(): GeneratedApiKey {
  const keyId = randomBytes(KEY_ID_BYTES).toString('base64url');
  const secret = randomBytes(SECRET_BYTES).toString('base64url');

  const keyPrefix = `${KEY_PREFIX_NAMESPACE}_${keyId}`;
  const key = `${keyPrefix}_${secret}`;

  return { key, keyPrefix, secretHash: hashApiKey(key) };
}

/**
 * Hashes a full key for storage and lookup.
 *
 * Deterministic and unsalted by design: the digest IS the lookup key, so a
 * per-row salt would make indexed retrieval impossible. Safe precisely because
 * the input carries 256 bits of random material.
 */
export function hashApiKey(key: string): string {
  return createHash('sha256').update(key, 'utf8').digest('hex');
}

/** The non-secret and secret halves of a presented key. */
export interface ParsedApiKey {
  readonly keyPrefix: string;
  readonly secretHash: string;
}

/**
 * Fixed offsets within a well-formed key.
 *
 * PARSED BY POSITION, NOT BY SPLITTING ON '_'.
 *
 * base64url's alphabet includes `-` and `_`, so the random halves can
 * themselves contain underscores. Splitting on `_` would therefore break for
 * roughly any key whose random material happens to include one - an
 * intermittent, data-dependent failure. Every segment here is fixed-width, so
 * slicing by index is exact regardless of the bytes drawn.
 */
const NAMESPACE_WITH_SEPARATOR = `${KEY_PREFIX_NAMESPACE}_`;
const KEY_ID_START = NAMESPACE_WITH_SEPARATOR.length;
const KEY_ID_END = KEY_ID_START + KEY_ID_LENGTH;
/** Position of the separator between the public id and the secret. */
const SECRET_SEPARATOR_INDEX = KEY_ID_END;
const SECRET_START = SECRET_SEPARATOR_INDEX + 1;
const KEY_LENGTH = SECRET_START + SECRET_LENGTH;

/** Length of the stored `key_prefix` (`hmp_live_<keyId>`). */
export const API_KEY_PREFIX_LENGTH = KEY_ID_END;

/**
 * Structurally validates a presented key and derives its lookup values.
 *
 * A filter, not a security control - the security comes from the hash match.
 * Its job is to reject obviously malformed input without a database round trip,
 * and to make "a UUID is not an API key" a hard structural fact.
 *
 * @returns null when the value is not a well-formed key of this format.
 */
export function parseApiKey(value: unknown): ParsedApiKey | null {
  if (typeof value !== 'string' || value.length !== KEY_LENGTH) {
    return null;
  }
  if (!value.startsWith(NAMESPACE_WITH_SEPARATOR)) {
    return null;
  }
  if (value[SECRET_SEPARATOR_INDEX] !== '_') {
    return null;
  }

  const keyId = value.slice(KEY_ID_START, KEY_ID_END);
  const secret = value.slice(SECRET_START);
  if (!BASE64URL.test(keyId) || !BASE64URL.test(secret)) {
    return null;
  }

  return {
    keyPrefix: value.slice(0, KEY_ID_END),
    secretHash: hashApiKey(value),
  };
}

export const API_KEY_NAMESPACE = KEY_PREFIX_NAMESPACE;
export const API_KEY_SECRET_BYTES = SECRET_BYTES;
export const API_KEY_ID_LENGTH = KEY_ID_LENGTH;
export const API_KEY_SECRET_LENGTH = SECRET_LENGTH;
