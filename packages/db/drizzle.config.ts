import { defineConfig } from 'drizzle-kit';

/**
 * drizzle-kit configuration.
 *
 * `DATABASE_URL` is read from the environment at CLI invocation time and is
 * never committed or logged.
 *
 * Commands split into two groups:
 *   - offline (`generate`, `check`) diff the schema against the migration
 *     history and never open a connection, so they work without a credential;
 *   - online (`migrate`, `push`, `pull`, `up`, `studio`) require a real
 *     database.
 *
 * The guard below fails an online command immediately with an actionable
 * message, rather than letting the driver emit an opaque connection error.
 */

const databaseUrl = process.env['DATABASE_URL']?.trim() ?? '';

const COMMANDS_REQUIRING_DATABASE = new Set(['migrate', 'push', 'pull', 'up', 'studio']);

const invokedCommand = process.argv.find((argument) =>
  COMMANDS_REQUIRING_DATABASE.has(argument),
);

if (invokedCommand !== undefined && databaseUrl === '') {
  throw new Error(
    `drizzle-kit ${invokedCommand} requires DATABASE_URL. Set it in the environment before running this command; it is never read from source control.`,
  );
}

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/schema/index.ts',
  out: './migrations',
  dbCredentials: {
    url: databaseUrl,
  },
  strict: true,
  verbose: true,
});
