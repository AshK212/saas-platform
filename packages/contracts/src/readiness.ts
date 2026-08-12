import { z } from 'zod';

/**
 * Response contract for `GET /readyz`.
 *
 * READINESS vs LIVENESS
 * ---------------------
 * `/healthz` answers "is this process alive?" and never touches a dependency.
 * `/readyz` answers "can this process serve database-backed traffic?".
 * An orchestrator restarts on liveness failure but only withholds traffic on
 * readiness failure, so conflating them causes restart loops during a database
 * outage the process cannot fix.
 *
 * DELIBERATELY COARSE
 * -------------------
 * The status enum is the entire public surface. No error text, no host, no
 * driver message and no connection detail is ever returned, because `/readyz`
 * is typically reachable without authentication. Detailed diagnostics stay
 * server-side.
 */

/** Per-dependency readiness state. */
export const dependencyReadinessSchema = z.enum(['ok', 'unconfigured', 'unreachable']);

export type DependencyReadiness = z.infer<typeof dependencyReadinessSchema>;

export const readinessResponseSchema = z.object({
  status: z.enum(['ready', 'not_ready']),
  checks: z.object({
    database: dependencyReadinessSchema,
  }),
});

export type ReadinessResponse = z.infer<typeof readinessResponseSchema>;

/** Canonical path of the readiness endpoint, shared so callers cannot drift. */
export const READINESS_PATH = '/readyz' as const;
