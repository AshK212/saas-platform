#!/usr/bin/env node
/**
 * Fails when the committed migrations do not match the TypeScript schema.
 *
 * ─── THE DEFECT THIS CATCHES ──────────────────────────────────────────────
 *
 * `drizzle-kit check` validates that the migration journal is internally
 * consistent - that its entries are ordered, hashed and not contradictory. It
 * is a real check, and it is not this one.
 *
 * It cannot see a schema change that was never generated. Edit
 * `packages/db/src/schema/*.ts`, add a column, commit, and `db:check` still
 * says "Everything's fine": the journal it is validating is untouched and
 * therefore still consistent. The drift is between the schema and the journal,
 * and only regeneration exposes it.
 *
 * That failure mode is quiet and expensive. The application typechecks against
 * the new column, the tests pass against a database built from the schema, and
 * the missing DDL surfaces at deploy time - or worse, in a production migration
 * that was never reviewed.
 *
 * ─── HOW ──────────────────────────────────────────────────────────────────
 *
 * Run the generator and require that it changed nothing under git. If a
 * migration was needed, one appears (or the journal moves), the tree is dirty,
 * and this fails with the diff.
 *
 * ─── WHAT IT DELIBERATELY DOES NOT DO ─────────────────────────────────────
 *
 * It does not commit anything. A generated migration is a reviewable artifact:
 * it names constraints, orders DDL, and can silently drop a column. CI
 * proposing schema changes on the author's behalf is how an unreviewed
 * destructive migration reaches main.
 *
 * It also restores the working tree afterwards, so running this locally is
 * side-effect free even when it fails - the developer is told to run
 * `pnpm db:generate` themselves and inspect the result.
 */

import { execFileSync, execSync } from 'node:child_process';
import { exit } from 'node:process';

/** Only these paths may change; nothing else should move during generation. */
const MIGRATION_PATHS = ['packages/db/migrations'];

function git(...args) {
  return execFileSync('git', args, { encoding: 'utf8' }).trim();
}

function status() {
  // Porcelain over the migration directory only, so an unrelated dirty file in
  // a developer's tree does not masquerade as schema drift.
  return git('status', '--porcelain', '--', ...MIGRATION_PATHS);
}

const before = status();
if (before !== '') {
  console.error('[schema-drift] The migration directory has uncommitted changes:');
  console.error(before);
  console.error('[schema-drift] Commit or stash them before checking for drift.');
  exit(2);
}

console.log('[schema-drift] running the generator...');
try {
  // A shell string rather than execFileSync: pnpm is a `.cmd` shim on Windows,
  // which Node 20 refuses to spawn directly. There is no untrusted input here.
  // Generation reads the schema files; it never opens a connection.
  execSync('pnpm run db:generate', {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
} catch (error) {
  console.error('[schema-drift] db:generate FAILED:');
  console.error(String(error.stdout ?? ''));
  console.error(String(error.stderr ?? ''));
  exit(1);
}

const after = status();
if (after === '') {
  console.log('[schema-drift] OK: the committed migrations match the schema.');
  exit(0);
}

console.error('[schema-drift] FAILED: the schema and the committed migrations disagree.');
console.error('');
console.error('Generation produced changes, which means a schema edit was made without');
console.error('generating its migration:');
console.error('');
console.error(after);
console.error('');
console.error('Run `pnpm db:generate`, REVIEW the generated SQL, and commit it.');
console.error('CI will not generate or commit migrations on your behalf.');

// Leave the tree as it was found, so a failing local run is side-effect free.
try {
  const untracked = git('ls-files', '--others', '--exclude-standard', '--', ...MIGRATION_PATHS);
  for (const file of untracked.split('\n').filter((line) => line !== '')) {
    execFileSync('git', ['clean', '-f', '--', file], { encoding: 'utf8' });
  }
  git('checkout', '--', ...MIGRATION_PATHS);
  console.error('');
  console.error('[schema-drift] The working tree was restored; nothing was left behind.');
} catch {
  console.error('');
  console.error('[schema-drift] NOTE: could not restore the tree automatically.');
  console.error('[schema-drift] Inspect `git status packages/db/migrations` yourself.');
}

exit(1);
