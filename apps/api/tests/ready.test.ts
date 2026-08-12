import { readinessResponseSchema, READINESS_PATH } from '@hybrid/contracts';
import { describe, expect, it } from 'vitest';

import { createApp } from '../src/app';
import { type DatabaseReadinessProbe } from '../src/routes/ready';

function appWith(probeDatabase: DatabaseReadinessProbe): ReturnType<typeof createApp> {
  return createApp({ probeDatabase });
}

describe('GET /readyz', () => {
  it('returns 200 and "ready" when the database answers', async () => {
    const response = await appWith(() => Promise.resolve('ok')).request(READINESS_PATH);

    expect(response.status).toBe(200);

    const body: unknown = await response.json();
    expect(body).toEqual({ status: 'ready', checks: { database: 'ok' } });
    expect(readinessResponseSchema.safeParse(body).success).toBe(true);
  });

  it('returns 503 and "not_ready" when the database is unconfigured', async () => {
    const response = await appWith(() => Promise.resolve('unconfigured')).request(READINESS_PATH);

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      status: 'not_ready',
      checks: { database: 'unconfigured' },
    });
  });

  it('returns 503 and "not_ready" when the database is unreachable', async () => {
    const response = await appWith(() => Promise.resolve('unreachable')).request(READINESS_PATH);

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      status: 'not_ready',
      checks: { database: 'unreachable' },
    });
  });

  it('degrades to 503 rather than 500 when the probe itself throws', async () => {
    const response = await appWith(() =>
      Promise.reject(new Error('driver exploded')),
    ).request(READINESS_PATH);

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      status: 'not_ready',
      checks: { database: 'unreachable' },
    });
  });

  it('leaks no diagnostic detail to the client', async () => {
    // /readyz is typically unauthenticated, so the body is the whole attack
    // surface. It must carry a status and nothing else.
    const secretBearing = new Error(
      'connect ECONNREFUSED postgresql://appuser:sup3rs3cret@ep-x.aws.neon.tech/appdb',
    );

    const response = await appWith(() => Promise.reject(secretBearing)).request(READINESS_PATH);
    const raw = await response.text();

    expect(raw).not.toContain('sup3rs3cret');
    expect(raw).not.toContain('appuser');
    expect(raw).not.toContain('neon.tech');
    expect(raw).not.toContain('ECONNREFUSED');
    expect(JSON.parse(raw)).toEqual({ status: 'not_ready', checks: { database: 'unreachable' } });
  });

  it('keeps a deterministic response shape across every outcome', async () => {
    for (const state of ['ok', 'unconfigured', 'unreachable'] as const) {
      const response = await appWith(() => Promise.resolve(state)).request(READINESS_PATH);
      const body: unknown = await response.json();

      expect(readinessResponseSchema.safeParse(body).success).toBe(true);
      expect(Object.keys(body as object).sort()).toEqual(['checks', 'status']);
    }
  });
});
