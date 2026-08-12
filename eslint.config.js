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
          paths: [
            {
              name: '@hybrid/config/server',
              message:
                'Server configuration must never be imported into browser code. Use the browser-safe @hybrid/config entry point.',
            },
          ],
          patterns: [
            {
              group: ['@hybrid/db', '@hybrid/db/*'],
              message: 'The database package is server-only and must not reach the browser bundle.',
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
