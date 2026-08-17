import { randomBytes } from 'node:crypto';

import { DEMO_SLUG_PATTERN, MAX_DEMO_SLUG_LENGTH } from '@hybrid/contracts';

/**
 * Public demo slug generation.
 *
 * ─── A LOCATOR, NOT A CREDENTIAL ──────────────────────────────────────────
 *
 * This is the opposite of `share/tokens.ts` in intent, and the difference is
 * worth stating because the two look superficially alike.
 *
 * A share token is a 256-bit secret whose unguessability IS the security. A
 * demo slug is meant to be published - printed in a deck, pasted into a
 * website - so it protects nothing and is not asked to. The `demo_enabled`
 * flag is what gates access, checked in SQL on every request.
 *
 * The random suffix here is therefore for UNIQUENESS and to avoid tenant names
 * colliding, not for secrecy. It is deliberately short enough to read aloud.
 *
 * ─── WHAT THE SLUG MUST NOT REVEAL ────────────────────────────────────────
 *
 * The workspace NAME is the operator's own public-facing label and appears on
 * the demo page anyway, so deriving a readable prefix from it leaks nothing
 * the visitor is not about to see. What must never appear:
 *
 *   - the internal workspace UUID (a database identity someone would try
 *     against other endpoints)
 *   - any email, credential prefix or secret metadata
 *
 * A guard test asserts the generated slug contains no uuid-shaped fragment.
 */

/** 5 bytes -> 8 base32-ish chars. Enough that collisions are a non-event. */
const SUFFIX_BYTES = 5;

/** Lowercase alphanumerics only, so the slug matches the contract pattern. */
const ALPHABET = 'abcdefghijkmnpqrstuvwxyz23456789';

/** Keeps the readable half short so the whole slug stays quotable. */
const MAX_PREFIX_LENGTH = 24;

/**
 * Turns a workspace name into a URL-safe fragment.
 *
 * Returns an empty string when nothing usable survives - a name of only
 * punctuation or non-Latin script is perfectly legitimate, and the caller
 * falls back to a bare random slug rather than mangling it.
 */
export function slugifyName(name: string): string {
  const cleaned = name
    .toLowerCase()
    .normalize('NFKD')
    // Strip combining marks so "Café" becomes "cafe" rather than "caf".
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_PREFIX_LENGTH)
    .replace(/-+$/g, '');

  return DEMO_SLUG_PATTERN.test(cleaned) ? cleaned : '';
}

/** Collision-resistant suffix. `crypto.randomBytes`, never `Math.random`. */
function randomSuffix(): string {
  const bytes = randomBytes(SUFFIX_BYTES);
  let out = '';
  for (const byte of bytes) {
    out += ALPHABET[byte % ALPHABET.length];
  }
  return out;
}

/**
 * Generates a public demo slug.
 *
 * `<readable-name>-<random>` when the name yields something usable, otherwise
 * `demo-<random>`. Always within the contract's length and pattern.
 */
export function generateDemoSlug(workspaceName: string): string {
  const prefix = slugifyName(workspaceName);
  const suffix = randomSuffix();
  const base = prefix === '' ? 'demo' : prefix;

  // Trim the readable half, never the random half: the suffix is what makes
  // the slug unique, and shortening it would raise the collision rate.
  const room = MAX_DEMO_SLUG_LENGTH - suffix.length - 1;
  const trimmed = base.slice(0, room).replace(/-+$/g, '');

  return `${trimmed === '' ? 'demo' : trimmed}-${suffix}`;
}
