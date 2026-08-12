import { describe, expect, it } from 'vitest';

import { checkDatabaseReadiness, type ReadinessQueryable } from '../src/readiness';

function queryableThatSucceeds(): ReadinessQueryable {
  return { query: () => Promise.resolve({ rows: [{ '?column?': 1 }] }) };
}

function queryableThatFails(message: string): ReadinessQueryable {
  return { query: () => Promise.reject(new Error(message)) };
}

describe('checkDatabaseReadiness', () => {
  it('reports "unconfigured" when no database is wired up', async () => {
    const result = await checkDatabaseReadiness(undefined);

    expect(result.status).toBe('unconfigured');
  });

  it('distinguishes unconfigured from unreachable', async () => {
    // These are operationally different: one is a deployment gap, the other an
    // outage. Collapsing them would misdirect whoever is paged.
    const unconfigured = await checkDatabaseReadiness(undefined);
    const unreachable = await checkDatabaseReadiness(queryableThatFails('ECONNREFUSED'));

    expect(unconfigured.status).toBe('unconfigured');
    expect(unreachable.status).toBe('unreachable');
  });

  it('reports "ok" with a latency measurement on success', async () => {
    const result = await checkDatabaseReadiness(queryableThatSucceeds());

    expect(result.status).toBe('ok');
    expect(result.latencyMs).toBeTypeOf('number');
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('issues a schema-independent probe statement', async () => {
    const seen: string[] = [];
    const result = await checkDatabaseReadiness({
      query: (sql: string) => {
        seen.push(sql);
        return Promise.resolve({});
      },
    });

    expect(seen).toEqual(['SELECT 1']);
    expect(result.status).toBe('ok');
  });

  it('reports "unreachable" instead of throwing when the query fails', async () => {
    const result = await checkDatabaseReadiness(queryableThatFails('ECONNREFUSED'));

    expect(result.status).toBe('unreachable');
    expect(result.diagnostic).toContain('ECONNREFUSED');
  });

  it('redacts credentials from driver diagnostics', async () => {
    const leaky = queryableThatFails(
      'failed to connect to postgresql://appuser:sup3rs3cret@db.example.com/appdb',
    );

    const result = await checkDatabaseReadiness(leaky);

    expect(result.status).toBe('unreachable');
    expect(result.diagnostic).not.toContain('sup3rs3cret');
    expect(result.diagnostic).not.toContain('appuser');
  });

  it('caps diagnostic length so a huge driver error cannot flood logs', async () => {
    const result = await checkDatabaseReadiness(queryableThatFails('x'.repeat(5_000)));

    expect(result.diagnostic?.length).toBeLessThanOrEqual(300);
  });

  it('times out rather than hanging on an unresponsive database', async () => {
    const neverResolves: ReadinessQueryable = { query: () => new Promise(() => {}) };

    const result = await checkDatabaseReadiness(neverResolves, { timeoutMs: 25 });

    expect(result.status).toBe('unreachable');
    expect(result.diagnostic).toContain('exceeded');
  });

  it('never rejects, whatever the queryable does', async () => {
    const hostile: ReadinessQueryable = {
      query: () => {
        throw new Error('synchronous explosion');
      },
    };

    await expect(checkDatabaseReadiness(hostile)).resolves.toMatchObject({
      status: 'unreachable',
    });
  });
});
