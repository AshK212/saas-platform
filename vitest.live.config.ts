import { defineConfig } from 'vitest/config';

/**
 * Live-dependency test configuration.
 *
 * Runs ONLY `*.live.test.ts`, which need real external credentials (currently a
 * Neon `DATABASE_URL`). Kept separate from the default suite so that
 * `pnpm test` and CI never depend on a secret, and so a skipped live suite can
 * never be mistaken for a passing one.
 *
 * Run with: pnpm test:db
 *
 * Individual live suites skip themselves when their credential is absent, so
 * this command is safe to run unconfigured - it will report skips, not passes.
 */
export default defineConfig({
  test: {
    include: ['apps/*/tests/**/*.live.test.ts', 'packages/*/tests/**/*.live.test.ts'],
    environment: 'node',
    // A live run with nothing to execute is a valid outcome, not a failure.
    passWithNoTests: true,
    reporters: ['default'],
    // Live probes contact a network service that may be cold-starting.
    testTimeout: 30_000,
  },
});
