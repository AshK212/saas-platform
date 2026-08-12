import { defineConfig } from 'vitest/config';

/**
 * Root Vitest configuration.
 *
 * Tests live in `tests/` directories next to the code they exercise, which
 * keeps them out of every package's emitted `dist/` output. Discovery is
 * repo-wide so a new app or package is picked up without further wiring.
 *
 * `*.live.test.ts` is excluded here on purpose: those tests require real
 * credentials. They run only via `pnpm test:db` (see vitest.live.config.ts), so
 * the default suite stays runnable on any machine and in CI without secrets.
 */
export default defineConfig({
  test: {
    include: ['apps/*/tests/**/*.test.ts', 'packages/*/tests/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**', '**/*.live.test.ts'],
    environment: 'node',
    passWithNoTests: false,
    reporters: ['default'],
  },
});
