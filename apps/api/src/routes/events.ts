import {
  EVENT_INGEST_PATH,
  eventIngestErrorSchema,
  eventIngestRequestSchema,
  eventIngestResponseSchema,
  toValidationIssues,
  type ValidationIssue,
} from '@hybrid/contracts';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';

import { apiKeyUnauthorizedBody, authenticateApiKeyRequest } from '../api-keys/authenticate.js';
import type { ApiKeyStore } from '../api-keys/store.js';
import type { Clock } from '../auth/clock.js';
import { UnresolvedReferenceError, type EventIngestStore } from '../events/store.js';

/**
 * `POST /v1/events` - idempotent event ingest.
 *
 * MACHINE AUTHENTICATION ONLY
 * ---------------------------
 * `Authorization: Bearer <workspace API key>`. A browser session cookie is
 * never consulted here, so operator authentication cannot substitute for
 * machine authentication - asserted by test.
 *
 * THE WORKSPACE COMES FROM THE CREDENTIAL
 * ---------------------------------------
 * The route reads no workspace from anywhere: the path has no workspace
 * segment, the Step 9 request contract is a strict object with no
 * `workspace_id` field, and no header is consulted for tenancy. There is
 * nothing for a caller to point at another tenant.
 *
 * NOT AUTHORITATIVE SPEND ACCOUNTING. A `spend.recorded` event is persisted as
 * an audit record; it does NOT debit the ledger. That is Step 19.
 */

/**
 * Maximum request body, in bytes.
 *
 * Sized from the contract: 100 events x ~1 KB of bounded typed fields is about
 * 100 KB, leaving roughly 9 KB per event for the free-form `payload` object
 * within 1 MiB. Generous for genuine runtime metadata, and small enough that a
 * hostile body is rejected before it is buffered or parsed.
 *
 * Zod bounds the event COUNT and individual field lengths but cannot bound
 * total bytes - `payload` is arbitrary JSON. This limit is the byte-level
 * protection that Step 9 explicitly deferred to here.
 */
export const MAX_EVENT_BODY_BYTES = 1_048_576; // 1 MiB

const SERVICE_UNAVAILABLE = 503;
const UNAUTHORIZED = 401;
const BAD_REQUEST = 400;
const PAYLOAD_TOO_LARGE = 413;

const UNAVAILABLE_BODY = { error: 'events_unavailable' } as const;

export interface EventRouteOptions {
  readonly eventStore: EventIngestStore | undefined;
  readonly apiKeyStore: ApiKeyStore | undefined;
  readonly clock: Clock;
}

/** Builds the Step 9 safe error body. Never carries Zod internals. */
function invalidBatch(issues: ValidationIssue[]): ReturnType<typeof eventIngestErrorSchema.parse> {
  return eventIngestErrorSchema.parse({ error: 'invalid_batch', issues });
}

export function createEventRoutes(options: EventRouteOptions): Hono {
  const routes = new Hono();
  const { eventStore, apiKeyStore, clock } = options;

  routes.post(
    EVENT_INGEST_PATH,
    /**
     * Byte limit runs FIRST, before authentication or parsing, so an oversized
     * body is rejected without being buffered, validated or reaching the store.
     * The 413 body is a fixed code and never echoes any request content.
     */
    bodyLimit({
      maxSize: MAX_EVENT_BODY_BYTES,
      onError: (c) => c.json({ error: 'payload_too_large' }, PAYLOAD_TOO_LARGE),
    }),
    async (c) => {
      if (eventStore === undefined || apiKeyStore === undefined) {
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
        return c.json(
          invalidBatch([{ path: '', message: 'Request body must be valid JSON.' }]),
          BAD_REQUEST,
        );
      }

      // The SHARED Step 9 schema, not a route-local reimplementation - so the
      // HTTP surface cannot drift from the published contract.
      const parsed = eventIngestRequestSchema.safeParse(body);
      if (!parsed.success) {
        return c.json(invalidBatch(toValidationIssues(parsed.error)), BAD_REQUEST);
      }

      try {
        const outcome = await eventStore.ingest(auth.credential, parsed.data.events, clock.now());

        // Duplicates are a normal outcome, not an error: 200 either way.
        return c.json(eventIngestResponseSchema.parse(outcome));
      } catch (error: unknown) {
        if (error instanceof UnresolvedReferenceError) {
          // Explicit failure rather than storing the event with the caller's
          // linkage quietly removed. The whole batch rolled back.
          return c.json(
            invalidBatch(
              error.references.map((reference) => ({
                path: `events.${String(reference.index)}.${reference.field}`,
                message: reference.message,
              })),
            ),
            BAD_REQUEST,
          );
        }
        // Anything else is a genuine failure: the app-level onError handler
        // returns an opaque 500 rather than leaking SQL or driver text.
        throw error;
      }
    },
  );

  return routes;
}
