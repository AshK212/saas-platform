import { createHash, randomBytes } from 'node:crypto';

/**
 * Share-token generation, parsing and hashing.
 *
 * Mirrors `api-keys/tokens.ts` deliberately: the two are the same kind of
 * artifact - a high-entropy bearer credential looked up by a public prefix and
 * authenticated by a digest - and one implementation reasoned about twice is
 * safer than two that drift.
 *
 * FORMAT
 * ------
 *   hmp_share_<shareId>_<secret>
 *
 *   hmp      product marker
 *   share    KIND marker. A share token can never be mistaken for an API key,
 *            by a human reading a log or by `parseApiKey`, which rejects it on
 *            the namespace before anything else.
 *   shareId  12 base64url chars = 9 bytes = 72 bits. PUBLIC.
 *   secret   43 base64url chars = 32 bytes = 256 bits. SECRET.
 *
 * Example shape (not a real token): `hmp_share_AbCdEfGhIjKl_<43 chars>`
 *
 * WHY THE PUBLIC ID IS SEPARATE RANDOM MATERIAL
 * ---------------------------------------------
 * The obvious alternative is to store the first N characters of the secret as
 * the lookup prefix. That publishes part of the secret. Generating `shareId`
 * independently means the stored `token_prefix` - which an operator SEES in
 * the management list - reveals nothing, and the secret keeps all 256 bits.
 *
 * ENTROPY
 * -------
 * `crypto.randomBytes`, a CSPRNG. Explicitly NOT: `Math.random`, a timestamp,
 * a counter, or a bare UUID (~122 bits, and identifiers leak into logs).
 *
 * 256 bits is also what makes this safe to hand out as a public link: there is
 * nothing to guess and no rate limit that could matter at that size.
 *
 * HASHING
 * -------
 * `token_hash = SHA-256(full token)`, hex. The digest covers the FULL token,
 * prefix included, so a row cannot be matched by a token carrying a different
 * prefix - the halves are cryptographically bound rather than merely stored
 * side by side.
 *
 * SHA-256 rather than bcrypt/argon2 for the same reason as sessions and API
 * keys: a work factor defends low-entropy human secrets against dictionaries.
 * Against 256-bit CSPRNG output there is no dictionary, so it would add
 * per-request latency for nothing and would prevent the indexed equality
 * lookup that resolution needs. What SHA-256 does provide, and what matters,
 * is one-wayness: a database disclosure yields digests, not working links.
 */

const SHARE_NAMESPACE = 'hmp_share';

/** 9 bytes -> 12 base64url chars. Public. */
const SHARE_ID_BYTES = 9;
const SHARE_ID_LENGTH = 12;

/** 32 bytes -> 43 base64url chars. Secret. */
const SECRET_BYTES = 32;
const SECRET_LENGTH = 43;

const BASE64URL = /^[A-Za-z0-9_-]+$/;

/** A freshly generated token, split into the parts persistence needs. */
export interface GeneratedShareToken {
  /** Full plaintext. Returned to the operator ONCE, never stored. */
  readonly token: string;
  /** Non-secret public half, stored as `token_prefix`. */
  readonly tokenPrefix: string;
  /** SHA-256 of `token`, stored as `token_hash`. */
  readonly tokenHash: string;
}

/** Generates a new share token. The plaintext exists only in the return value. */
export function generateShareToken(): GeneratedShareToken {
  const shareId = randomBytes(SHARE_ID_BYTES).toString('base64url');
  const secret = randomBytes(SECRET_BYTES).toString('base64url');

  const tokenPrefix = `${SHARE_NAMESPACE}_${shareId}`;
  const token = `${tokenPrefix}_${secret}`;

  return { token, tokenPrefix, tokenHash: hashShareToken(token) };
}

/**
 * Hashes a full token for storage and lookup.
 *
 * Deterministic and unsalted by design: the digest IS the lookup key, so a
 * per-row salt would make indexed retrieval impossible. Safe precisely because
 * the input carries 256 bits of random material.
 */
export function hashShareToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/** The non-secret and secret halves of a presented token. */
export interface ParsedShareToken {
  readonly tokenPrefix: string;
  readonly tokenHash: string;
}

/**
 * Fixed offsets within a well-formed token.
 *
 * PARSED BY POSITION, NOT BY SPLITTING ON '_'. base64url includes `-` and `_`,
 * so the random halves can contain underscores; splitting would fail for
 * roughly any token whose material happens to include one - an intermittent,
 * data-dependent bug. Every segment is fixed-width, so slicing is exact.
 */
const NAMESPACE_WITH_SEPARATOR = `${SHARE_NAMESPACE}_`;
const SHARE_ID_START = NAMESPACE_WITH_SEPARATOR.length;
const SHARE_ID_END = SHARE_ID_START + SHARE_ID_LENGTH;
const SECRET_SEPARATOR_INDEX = SHARE_ID_END;
const SECRET_START = SECRET_SEPARATOR_INDEX + 1;
const TOKEN_LENGTH = SECRET_START + SECRET_LENGTH;

/** Length of the stored `token_prefix`. */
export const SHARE_TOKEN_PREFIX_LENGTH = SHARE_ID_END;

/**
 * Structurally validates a presented token and derives its lookup values.
 *
 * A filter, not a security control - the security is the digest match. Its job
 * is to reject obviously malformed input without a database round trip, and to
 * make "an API key is not a share token" a hard structural fact.
 *
 * @returns null when the value is not a well-formed token of this format.
 */
export function parseShareToken(value: unknown): ParsedShareToken | null {
  if (typeof value !== 'string' || value.length !== TOKEN_LENGTH) {
    return null;
  }
  if (!value.startsWith(NAMESPACE_WITH_SEPARATOR)) {
    return null;
  }
  if (value[SECRET_SEPARATOR_INDEX] !== '_') {
    return null;
  }

  const shareId = value.slice(SHARE_ID_START, SHARE_ID_END);
  const secret = value.slice(SECRET_START);
  if (!BASE64URL.test(shareId) || !BASE64URL.test(secret)) {
    return null;
  }

  return { tokenPrefix: value.slice(0, SHARE_ID_END), tokenHash: hashShareToken(value) };
}

export const SHARE_TOKEN_NAMESPACE = SHARE_NAMESPACE;
export const SHARE_TOKEN_SECRET_BYTES = SECRET_BYTES;
export const SHARE_TOKEN_LENGTH = TOKEN_LENGTH;
