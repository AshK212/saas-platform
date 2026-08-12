import { healthResponseSchema, HEALTH_PATH } from '@hybrid/contracts';
import { Hono } from 'hono';

/**
 * Liveness routes.
 *
 * Kept in its own module so that route groups compose in `createApp()` rather
 * than accumulating in a single server file.
 *
 * The response is built through the shared contract schema, so the endpoint and
 * its consumers cannot drift apart silently.
 */
export function createHealthRoutes(): Hono {
  const routes = new Hono();

  routes.get(HEALTH_PATH, (c) => c.json(healthResponseSchema.parse({ status: 'ok' }), 200));

  return routes;
}
