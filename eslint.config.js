import js from '@eslint/js';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';
import tseslint from 'typescript-eslint';

/**
 * Flat ESLint configuration for the monorepo.
 *
 * TYPE-AWARE LINTING
 * ------------------
 * This baseline uses the TypeScript parser and TypeScript-specific rules, but
 * deliberately not the type-checked rule sets. Type correctness is already
 * enforced end to end by `tsc --build` under a strict `tsconfig.base.json`, so
 * type-aware linting would duplicate that work while adding project-service
 * wiring that has to be maintained for every new package. It can be enabled
 * later without changing any source file.
 *
 * There are no blanket rule suppressions here. The only inline disables in the
 * repo are two `no-console` exemptions on process entry points, each with a
 * stated reason.
 */
export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      '**/coverage/**',
      '**/.vite/**',
      '**/*.tsbuildinfo',
      'packages/db/migrations/**',
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  // Shared rules for every linted file.
  {
    rules: {
      'no-console': 'error',
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'no-implicit-coercion': 'error',
      'prefer-const': 'error',
      'no-var': 'error',
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
      ],
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
    },
  },

  // Tenant-isolation guardrail for application code.
  //
  // Tenant-owned data must be reached through @hybrid/db repositories, which
  // are bound to a WorkspaceScope. Importing the raw schema tables or the query
  // builder into an app makes `db.select().from(events)` - with no workspace
  // predicate - a one-line cross-tenant leak. Blocking the import keeps that
  // shape out of application code entirely.
  //
  // packages/db itself is exempt: it is where the scoped queries are written.
  {
    files: ['apps/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: '@hybrid/db/schema',
              message:
                'Do not query schema tables directly from an application. Use a workspace-scoped repository from @hybrid/db; raw table access bypasses tenant isolation.',
            },
            {
              name: 'drizzle-orm',
              message:
                'Application code must not build ad-hoc queries. Add a workspace-scoped repository method in @hybrid/db instead.',
            },
          ],
          patterns: [
            {
              group: ['drizzle-orm/*'],
              message:
                'Application code must not build ad-hoc queries. Add a workspace-scoped repository method in @hybrid/db instead.',
            },
          ],
        },
      ],
    },
  },

  // THE REFERENCE CLIENT IS AN ORDINARY API CONSUMER.
  //
  // The simulator exists to prove the PUBLIC API is sufficient to run a
  // governed fleet. That proof is worthless if it can reach behind the API:
  // one `@hybrid/db` import and it is reading the ledger directly rather than
  // demonstrating that a real runtime could.
  //
  // Stricter than the app-wide rule above, which only blocks raw schema and
  // query-builder access. Here the whole database package is off limits, and
  // so are the API's internals - a runtime integrating against this contract
  // will have neither.
  {
    files: ['apps/simulator/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: '@hybrid/config/server',
              message:
                'The reference client is not a server. It receives configuration from the environment.',
            },
          ],
          patterns: [
            {
              group: ['@hybrid/db', '@hybrid/db/*'],
              message:
                'The reference client must reach the control plane over HTTP only. Importing the database package would make it privileged, and it would stop proving the public API is sufficient.',
            },
            {
              group: ['drizzle-orm', 'drizzle-orm/*', 'pg'],
              message:
                'The reference client has no database access of any kind.',
            },
            {
              group: ['../../api/*', '**/apps/api/*'],
              message:
                'The reference client must not import API internals. It is a consumer of the published HTTP contract.',
            },
          ],
        },
      ],
    },
  },

  // Server-side and tooling code runs on Node.
  {
    files: [
      'apps/api/**/*.ts',
      'apps/simulator/**/*.ts',
      'packages/**/*.ts',
      '*.ts',
      '*.js',
      'apps/web/vite.config.ts',
    ],
    languageOptions: {
      globals: globals.node,
    },
  },

  // Browser code. Server configuration must never be imported here.
  {
    files: ['apps/web/src/**/*.{ts,tsx}'],
    languageOptions: {
      globals: globals.browser,
      parserOptions: {
        ecmaFeatures: { jsx: true },
      },
    },
    plugins: {
      'react-hooks': reactHooks,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      'no-restricted-imports': [
        'error',
        {
          // Flat-config rules replace rather than merge, so this block restates
          // the app-wide tenant-isolation restrictions alongside the
          // browser-specific ones. The @hybrid/db pattern below is broader than
          // the app-wide rule and already covers @hybrid/db/schema.
          paths: [
            {
              name: '@hybrid/config/server',
              message:
                'Server configuration must never be imported into browser code. Use the browser-safe @hybrid/config entry point.',
            },
            {
              name: 'drizzle-orm',
              message:
                'Application code must not build ad-hoc queries, and the query builder must not reach the browser bundle.',
            },
          ],
          patterns: [
            {
              group: ['@hybrid/db', '@hybrid/db/*'],
              message: 'The database package is server-only and must not reach the browser bundle.',
            },
            {
              group: ['drizzle-orm/*'],
              message:
                'Application code must not build ad-hoc queries, and the query builder must not reach the browser bundle.',
            },
          ],
        },
      ],
    },
  },

  // Test files.
  {
    files: ['**/tests/**/*.ts'],
    languageOptions: {
      globals: globals.node,
    },
  },
);
