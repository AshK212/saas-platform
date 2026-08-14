import { PRECHECK_PATH, precheckRequestSchema, precheckResponseSchema } from '@hybrid/contracts';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';

import { apiKeyUnauthorizedBody, authenticateApiKeyRequest } from '../api-keys/authenticate.js';
import type { ApiKeyStore } from '../api-keys/store.js';
import type { Clock } from '../auth/clock.js';
import type { PrecheckStore } from '../precheck/store.js';

/**
 * `POST /v1/actions/precheck` - the governance decision.
 *
 * MACHINE AUTHENTICATION ONLY
 * ---------------------------
 * `Authorization: Bearer <workspace API key>`. A browser session cookie is
 * never consulted: the operator UI CHANGES policy, the runtime ASKS about it.
 * A session that could precheck would blur that separation, and a runtime that
 * could authenticate as an operator could eventually edit its own governance.
 *
 * THE WORKSPACE COMES FROM THE CREDENTIAL
 * ---------------------------------------
 * The path has no workspace segment and the request contract is a strict object
 * with no tenant field. There is nothing for a caller to point elsewhere.
 *
 * EVERY DECISION PRODUCES A RECEIPT. Requests rejected here - bad key,
 * malformed body - never reach the decision, so they correctly produce none:
 * no governance decision was made.
 */

const SERVICE_UNAVAILABLE = 503;
const UNAUTHORIZED = 401;
const BAD_REQUEST = 400;
const PAYLOAD_TOO_LARGE = 413;

const UNAVAILABLE_BODY = { error: 'precheck_unavailable' } as const;
const INVALID_BODY = { error: 'invalid_request' } as const;

/**
 * Maximum request body.
 *
 * A precheck is four short fields; 16 KiB is already generous. Far smaller than
 * the event-ingest limit because there is no free-form payload here, and this
 * is the highest-frequency endpoint in the product.
 */
export const MAX_PRECHECK_BODY_BYTES = 16_384;

export interface PrecheckRouteOptions {
  readonly precheckStore: PrecheckStore | undefined;
  readonly apiKeyStore: ApiKeyStore | undefined;
  readonly clock: Clock;
}

export function createPrecheckRoutes(options: PrecheckRouteOptions): Hono {
  const routes = new Hono();
  const { precheckStore, apiKeyStore, clock } = options;

  routes.post(
    PRECHECK_PATH,
    // Runs first, so an oversized body is refused before it is buffered,
    // authenticated or parsed.
    bodyLimit({
      maxSize: MAX_PRECHECK_BODY_BYTES,
      onError: (c) => c.json({ error: 'payload_too_large' }, PAYLOAD_TOO_LARGE),
    }),
    async (c) => {
      if (precheckStore === undefined || apiKeyStore === undefined) {
        return c.json(UNAVAILABLE_BODY, SERVICE_UNAVAILABLE);
      }

      const auth = await authenticateApiKeyRequest(c, { store: apiKeyStore, clock });
      if (!auth.ok) {
        // One identical 401 for every failure category.
        return c.json(apiKeyUnauthorizedBody(), UNAUTHORIZED);
      }

      let body: unknown;
      try {
        body = await c.req.json();
      } catch {
        return c.json(INVALID_BODY, BAD_REQUEST);
      }

      // The shared contract, not a route-local reimplementation, so the HTTP
      // surface cannot drift from what the simulator and docs describe.
      const parsed = precheckRequestSchema.safeParse(body);
      if (!parsed.success) {
        return c.json(INVALID_BODY, BAD_REQUEST);
      }

      // ONE server clock reading, handed into the decision. The ledger day and
      // the receipt's accounting day both derive from it.
      const outcome = await precheckStore.precheck(auth.credential, parsed.data, clock.now());

      // A denial is a successful governance decision, not an HTTP error: the
      // caller asked and received an authoritative answer. 200 either way, with
      // `decision` carrying the outcome. A 4xx would invite retry logic that
      // hammers a paused agent.
      return c.json(precheckResponseSchema.parse(outcome.response));
    },
  );

  return routes;
}
