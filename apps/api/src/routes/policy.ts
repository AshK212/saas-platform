import {
  POLICY_POLL_PATH,
  policyPollQuerySchema,
  policySnapshotSchema,
} from '@hybrid/contracts';
import { Hono } from 'hono';

import { apiKeyUnauthorizedBody, authenticateApiKeyRequest } from '../api-keys/authenticate.js';
import type { ApiKeyStore } from '../api-keys/store.js';
import type { Clock } from '../auth/clock.js';
import type { PolicyStore } from '../policy/store.js';

/**
 * `GET /v1/policy` - machine policy polling.
 *
 * MACHINE AUTHENTICATION ONLY
 * ---------------------------
 * `Authorization: Bearer <workspace API key>`. A browser session cookie is
 * never consulted, so operator authentication cannot substitute for machine
 * authentication - asserted by test. The operator-facing policy surface arrives
 * in Step 13 on its own route.
 *
 * THE WORKSPACE COMES FROM THE CREDENTIAL
 * ---------------------------------------
 * The path has no workspace segment, the query schema is strict and defines
 * only `since_version`, and no header is consulted for tenancy. A caller
 * sending `?workspace_id=...` gets a 400 for the unknown parameter - it is not
 * ignored, because a silently-ignored tenant selector is a field someone later
 * decides to honour.
 *
 * READ-ONLY
 * ---------
 * This route writes nothing: no policy rows, no version increment, no
 * `last_seen_at`, no ledger, no events. Polling is configuration retrieval, not
 * agent activity.
 *
 * NOT AN ENFORCEMENT POINT. A `paused` mode is reported faithfully and nothing
 * acts on it here; precheck decisions and the kill switch are later steps.
 */

const SERVICE_UNAVAILABLE = 503;
const UNAUTHORIZED = 401;
const BAD_REQUEST = 400;
const NOT_MODIFIED = 304;

const UNAVAILABLE_BODY = { error: 'policy_unavailable' } as const;
const INVALID_QUERY_BODY = { error: 'invalid_query' } as const;

export interface PolicyRouteOptions {
  readonly policyStore: PolicyStore | undefined;
  readonly apiKeyStore: ApiKeyStore | undefined;
  readonly clock: Clock;
}

export function createPolicyRoutes(options: PolicyRouteOptions): Hono {
  const routes = new Hono();
  const { policyStore, apiKeyStore, clock } = options;

  routes.get(POLICY_POLL_PATH, async (c) => {
    if (policyStore === undefined || apiKeyStore === undefined) {
      return c.json(UNAVAILABLE_BODY, SERVICE_UNAVAILABLE);
    }

    const auth = await authenticateApiKeyRequest(c, { store: apiKeyStore, clock });
    if (!auth.ok) {
      // One identical 401 for every failure category.
      return c.json(apiKeyUnauthorizedBody(), UNAUTHORIZED);
    }

    const parsed = policyPollQuerySchema.safeParse(c.req.query());
    if (!parsed.success) {
      return c.json(INVALID_QUERY_BODY, BAD_REQUEST);
    }

    // VERSION FIRST. The common answer to a 30-second poll is "unchanged", and
    // establishing that costs one primary-key read rather than a join over
    // every agent.
    const version = await policyStore.getVersion(auth.credential);

    if (parsed.data.since_version !== undefined) {
      // Compared as BigInt, not as JS numbers or strings: string comparison
      // would order "10" before "9", and Number would lose precision on a
      // bigint. Both inputs are already validated as decimal integers.
      const since = BigInt(parsed.data.since_version);
      const current = BigInt(version);

      if (since === current) {
        // 304 carries NO BODY. `c.body(null, 304)` rather than `c.json(...)`,
        // because a 304 with a JSON payload is malformed and some clients
        // would cache the stale bytes.
        return c.body(null, NOT_MODIFIED);
      }

      // A caller AHEAD of the server is stale divergence - a restored backup,
      // a rolled-back deploy, or a corrupted local cache. Returning 304 would
      // freeze it in that wrong state forever, so it gets the authoritative
      // snapshot and self-corrects. `since > current` falls through here.
    }

    const snapshot = await policyStore.getSnapshot(auth.credential);

    // A known workspace always has a version and always yields a valid
    // snapshot. Zero agents is a legitimate `{version, agents: []}` - no agent
    // is ever invented to avoid an empty array.
    return c.json(
      policySnapshotSchema.parse({ version: snapshot.version, agents: snapshot.agents }),
    );
  });

  return routes;
}
