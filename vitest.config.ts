import { defineConfig } from 'vitest/config';

/**
 * Root Vitest configuration.
 *
 * Tests live in `tests/` directories next to the code they exercise, which
 * keeps them out of every package's emitted `dist/` output. Discovery is
 * repo-wide so a new app or package is picked up without further wiring.
 *
 * The root `tests/` directory holds suites that belong to the REPOSITORY
 * rather than to any app or package - currently the AC-21 CI contract, which
 * asserts properties of `.github/workflows/ci.yml`. It is collected here so
 * weakening the pipeline breaks `pnpm test` like any other regression.
 *
 * `*.live.test.ts` is excluded here on purpose: those tests require real
 * credentials. They run only via `pnpm test:db` (see vitest.live.config.ts), so
 * the default suite stays runnable on any machine and in CI without secrets.
 */
export default defineConfig({
  test: {
    include: [
      'apps/*/tests/**/*.test.ts',
      'packages/*/tests/**/*.test.ts',
      'tests/**/*.test.ts',
    ],
    exclude: ['**/node_modules/**', '**/dist/**', '**/*.live.test.ts'],
    environment: 'node',
    passWithNoTests: false,
    reporters: ['default'],
  },
});
