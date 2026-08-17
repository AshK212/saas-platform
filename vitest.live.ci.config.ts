import { defineConfig } from 'vitest/config';

/**
 * The live suite as CI runs it.
 *
 * Identical to `vitest.live.config.ts` except for one deliberate exclusion, and
 * it exists so that exclusion is visible in the repository rather than buried in
 * a command-line flag.
 *
 * ─── WHY NEON CONNECTIVITY IS EXCLUDED ────────────────────────────────────
 *
 * `neon-connectivity.live.test.ts` is the Step 2 probe for the PRODUCTION
 * database. It gates on `DATABASE_URL`, not `TEST_DATABASE_URL`, and it asks
 * questions about the deployed Neon endpoint - readiness, server version,
 * interactive transactions and advisory locks through the pooler.
 *
 * CI has no Neon. It has a disposable `postgres:17` container, and
 * `DATABASE_URL` is deliberately scoped to the migration step alone so the live
 * suites cannot reach it. So in CI that suite would skip - and the integration
 * job's whole contract is that NOTHING skips, because a skipped live suite is
 * indistinguishable from a job that never had a database.
 *
 * Two wrong ways to resolve that, and why:
 *
 *   - Set `DATABASE_URL` for the test step too. That breaks the invariant every
 *     live suite depends on, for the sake of one non-behavioural probe.
 *   - Point the probe at the container. It would then report "Neon
 *     connectivity: OK" having contacted a local container that is not Neon,
 *     which is worse than not running it at all.
 *
 * So it is excluded here, explicitly, and CI does NOT verify Neon-specific
 * connectivity. That stays a staging-time check, recorded as a known gap in
 * docs/ci.md.
 *
 * Everything else runs - including the AC-20 cross-tenant acceptance, which is
 * the reason this job exists.
 *
 * ─── WHY THIS DOES NOT IMPORT THE OTHER CONFIG ────────────────────────────
 *
 * `mergeConfig` would express the "same, plus one exclusion" relationship
 * directly, but the import cannot satisfy both toolchains: Vite's native config
 * loader wants an explicit `.ts` extension, and TypeScript rejects one without
 * `allowImportingTsExtensions`. Rather than weaken a compiler option for a test
 * config, the settings are declared here in full.
 *
 * The obvious hazard - this file drifting from the other, so CI silently stops
 * collecting a suite - is covered by an assertion in `tests/ci-contract.test.ts`
 * that the two `include` globs are identical.
 */
export default defineConfig({
  test: {
    // MUST stay identical to vitest.live.config.ts. Asserted by the CI contract.
    include: ['apps/*/tests/**/*.live.test.ts', 'packages/*/tests/**/*.live.test.ts'],
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      // Requires a real Neon endpoint. See above.
      '**/neon-connectivity.live.test.ts',
    ],
    environment: 'node',
    // In CI a live run that collected nothing is a failure, not a valid
    // outcome - the opposite of the local default. `check-live-coverage.mjs`
    // enforces that on the counts; this makes vitest refuse it too.
    passWithNoTests: false,
    reporters: ['default'],
    testTimeout: 30_000,
  },
});
