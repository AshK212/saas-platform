import { z } from 'zod';

/**
 * Response contract for `GET /healthz`.
 *
 * Deliberately minimal: the health endpoint is a liveness probe for Render and
 * for CI smoke checks. It must never expose build metadata, environment values
 * or governance state.
 */
export const healthResponseSchema = z.object({
  status: z.literal('ok'),
});

export type HealthResponse = z.infer<typeof healthResponseSchema>;

/** Canonical path of the liveness endpoint, shared so callers cannot drift. */
export const HEALTH_PATH = '/healthz' as const;
