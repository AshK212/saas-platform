import {
  EVENT_INGEST_PATH,
  eventIngestRequestSchema,
  eventIngestResponseSchema,
  toValidationIssues,
  type EventIngestRequest,
  type EventIngestResponse,
  type IngestEvent,
} from '@hybrid/contracts';
import { describe, expect, it } from 'vitest';

import { createApp } from '../src/app';

/**
 * Proves the shared event contracts are usable from the API package, and that
 * Step 9 added no route.
 *
 * The contracts themselves are tested in `packages/contracts`. This file only
 * checks the seam: that a consumer can import, type against and validate with
 * them, and that nothing has been mounted early.
 */

describe('the API package can consume the event contracts', () => {
  it('type-checks a well-formed batch', () => {
    // Compile-time proof: this object must satisfy the exported type.
    const request: EventIngestRequest = {
      events: [
        { type: 'heartbeat', event_id: 'hb-1', agent_id: 'agent-a' },
        {
          type: 'spend.recorded',
          event_id: 'evt-1',
          agent_id: 'agent-a',
          amount_usd: '1.250000',
          provider: 'openai',
        },
      ],
    };

    expect(eventIngestRequestSchema.safeParse(request).success).toBe(true);
  });

  it('type-checks an ingest response', () => {
    const response: EventIngestResponse = { accepted: 1, duplicates: 1 };

    expect(eventIngestResponseSchema.safeParse(response).success).toBe(true);
  });

  it('narrows a parsed event by its discriminant', () => {
    const parsed = eventIngestRequestSchema.parse({
      events: [
        {
          type: 'spend.recorded',
          event_id: 'evt-1',
          agent_id: 'agent-a',
          amount_usd: '41.000000',
          provider: 'openai',
        },
      ],
    });

    const event: IngestEvent | undefined = parsed.events[0];
    if (event?.type !== 'spend.recorded') {
      expect.unreachable('discriminant should narrow to spend.recorded');
    }

    // `amount_usd` is reachable only after narrowing - the union is doing work.
    expect(event.amount_usd).toBe('41.000000');
  });

  it('renders client-safe issues for a rejected batch', () => {
    const parsed = eventIngestRequestSchema.safeParse({ events: [] });
    if (parsed.success) {
      expect.unreachable('empty batch must be rejected');
    }

    const issues = toValidationIssues(parsed.error);

    expect(issues.length).toBeGreaterThan(0);
    expect(Object.keys(issues[0] ?? {}).sort()).toEqual(['message', 'path']);
  });
});

describe('the ingest path exposes writes only', () => {
  // No stores wired: the Step 9 assertion that this path 404s was replaced in
  // Step 10 by the stronger claim that it is mounted for POST ONLY, and that an
  // unconfigured database degrades it to 503 rather than taking liveness down.
  const app = createApp({ probeDatabase: () => Promise.resolve('ok') });

  it('answers POST, reporting 503 while unconfigured', async () => {
    const response = await app.request(EVENT_INGEST_PATH, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ events: [] }),
    });

    // Mounted (not 404), and unavailable rather than crashing.
    expect(response.status).toBe(503);
  });

  it('still returns 404 for a GET on the ingest path', async () => {
    // Reading events back is Step 11. Step 10 added no read surface.
    expect((await app.request(EVENT_INGEST_PATH)).status).toBe(404);
  });

  it('leaves liveness unaffected', async () => {
    expect((await app.request('/healthz')).status).toBe(200);
  });
});
