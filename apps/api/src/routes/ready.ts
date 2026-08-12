import {
  type DependencyReadiness,
  readinessResponseSchema,
  READINESS_PATH,
} from '@hybrid/contracts';
import { Hono } from 'hono';

/**
 * Readiness routes.
 *
 * The probe is injected rather than constructed here, so the route is testable
 * without a database and the API never owns driver lifecycle detail.
 */
export type DatabaseReadinessProbe = () => Promise<DependencyReadiness>;

/** HTTP 503: the process is alive but must not receive dependent traffic yet. */
const SERVICE_UNAVAILABLE = 503;

export function createReadinessRoutes(probeDatabase: DatabaseReadinessProbe): Hono {
  const routes = new Hono();

  routes.get(READINESS_PATH, async (c) => {
    let database: DependencyReadiness;
    try {
      database = await probeDatabase();
    } catch {
      // A probe that throws is itself a readiness failure, never a 500. The
      // error is intentionally not inspected here so nothing from the driver
      // can reach the response body.
      database = 'unreachable';
    }

    const body = readinessResponseSchema.parse({
      status: database === 'ok' ? 'ready' : 'not_ready',
      checks: { database },
    });

    return c.json(body, database === 'ok' ? 200 : SERVICE_UNAVAILABLE);
  });

  return routes;
}
