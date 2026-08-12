import { healthResponseSchema, HEALTH_PATH } from '@hybrid/contracts';
import { describe, expect, it } from 'vitest';

import { createApp } from '../src/app';

/** A probe that fails the test if liveness ever consults it. */
function forbiddenProbe(): never {
  throw new Error('/healthz must not touch the database');
}

describe('GET /healthz', () => {
  it('responds 200 with a contract-valid ok status', async () => {
    const app = createApp({ probeDatabase: forbiddenProbe });

    const response = await app.request(HEALTH_PATH);

    expect(response.status).toBe(200);

    const body: unknown = await response.json();
    expect(body).toEqual({ status: 'ok' });

    // The response must satisfy the shared contract, not just look right.
    expect(healthResponseSchema.safeParse(body).success).toBe(true);
  });

  it('returns JSON content type', async () => {
    const app = createApp({ probeDatabase: forbiddenProbe });

    const response = await app.request(HEALTH_PATH);

    expect(response.headers.get('content-type')).toContain('application/json');
  });

  it('stays 200 when the database probe is unconfigured', async () => {
    const app = createApp({ probeDatabase: () => Promise.resolve('unconfigured') });

    const response = await app.request(HEALTH_PATH);

    expect(response.status).toBe(200);
  });

  it('stays 200 when the database is unreachable', async () => {
    // Liveness must not fail on a dependency outage; that would cause an
    // orchestrator to restart a process that is working correctly.
    const app = createApp({ probeDatabase: () => Promise.resolve('unreachable') });

    const response = await app.request(HEALTH_PATH);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: 'ok' });
  });

  it('never invokes the database probe at all', async () => {
    let probeCalls = 0;
    const app = createApp({
      probeDatabase: () => {
        probeCalls += 1;
        return Promise.resolve('ok');
      },
    });

    await app.request(HEALTH_PATH);

    expect(probeCalls).toBe(0);
  });

  it('does not expose any business route yet', async () => {
    const app = createApp({ probeDatabase: forbiddenProbe });

    const response = await app.request('/v1/events');

    expect(response.status).toBe(404);
  });
});
