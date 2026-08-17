#!/usr/bin/env node
/**
 * Guards against the most dangerous kind of green CI: an integration job that
 * reports success having executed nothing.
 *
 * ─── THE FAILURE THIS EXISTS TO PREVENT ───────────────────────────────────
 *
 * Every live suite gates itself on `TEST_DATABASE_URL` and skips when it is
 * absent. That is correct locally - a developer without PostgreSQL should be
 * able to run `pnpm test:db` and be told "skipped", not handed a red build.
 *
 * But the same mechanism means a CI job whose database never came up, whose
 * URL was mistyped, or whose variable was renamed will print
 *
 *     Tests  236 skipped (236)
 *
 * and exit 0. Vitest is behaving correctly; the job is simply not testing
 * anything. A pipeline that treats that as integration success is worse than
 * having no integration job at all, because it manufactures confidence.
 *
 * So: whenever `TEST_DATABASE_URL` IS configured, every live test must actually
 * run. Zero skipped, and a non-zero number of them passed.
 *
 * ─── WHY A JSON REPORT AND NOT AN EXIT CODE ───────────────────────────────
 *
 * The exit code cannot distinguish "everything passed" from "everything
 * skipped" - both are 0. The counts can, so this reads them.
 *
 * ─── LOCAL BEHAVIOUR IS DELIBERATELY UNCHANGED ────────────────────────────
 *
 * With no `TEST_DATABASE_URL`, this script asserts the opposite expectation:
 * skipping is the correct outcome and is reported as such. It never demands
 * that a developer install PostgreSQL to run the ordinary suites.
 */

import { readFileSync } from 'node:fs';
import { argv, env, exit } from 'node:process';

const reportPath = argv[2];
if (reportPath === undefined || reportPath === '') {
  console.error('usage: check-live-coverage.mjs <vitest-json-report>');
  exit(2);
}

const configured = (env['TEST_DATABASE_URL'] ?? '').trim() !== '';

let report;
try {
  report = JSON.parse(readFileSync(reportPath, 'utf8'));
} catch (error) {
  console.error(`[live-coverage] cannot read ${reportPath}: ${String(error)}`);
  exit(2);
}

const total = Number(report.numTotalTests ?? 0);
const passed = Number(report.numPassedTests ?? 0);
const failed = Number(report.numFailedTests ?? 0);
const skipped = Number(report.numPendingTests ?? 0);

console.log(
  `[live-coverage] total=${total} passed=${passed} failed=${failed} skipped=${skipped}`,
);

if (!configured) {
  // ─── IN CI, AN ABSENT URL IS ITSELF THE FAILURE ─────────────────────────
  //
  // Closing the loop on the whole point of this script. Without this branch a
  // renamed variable, a typo in the job definition, or a `services:` block that
  // silently failed to start would land here, print "skipped is not passed",
  // exit 0, and produce a green integration job that ran nothing - the exact
  // outcome the rest of this file exists to prevent, arrived at by a different
  // route.
  //
  // The integration job's contract is that it PROVIDES a database. If it has
  // not, the job is broken and must say so.
  if ((env['CI'] ?? '').trim() !== '') {
    console.error('[live-coverage] FAILED: TEST_DATABASE_URL is not set, but CI is.');
    console.error('  The integration job is required to provide a disposable PostgreSQL');
    console.error('  service. A CI run with no database configured is a broken job, not a');
    console.error('  skipped one.');
    exit(1);
  }

  // Local, no database. Skipping is the correct, expected outcome - and it is
  // NOT reported as integration success anywhere.
  console.log('[live-coverage] TEST_DATABASE_URL is not set (local run).');
  console.log('[live-coverage] SKIPPED IS NOT PASSED: live behaviour is unverified.');
  if (passed > 0) {
    // Would mean a suite ran without a database, i.e. a gate is missing.
    console.error('[live-coverage] FAILED: tests executed with no TEST_DATABASE_URL configured.');
    exit(1);
  }
  exit(0);
}

// A database IS configured, so every live test must have run.
const problems = [];
if (total === 0) {
  problems.push('no live tests were collected at all');
}
if (skipped > 0) {
  problems.push(
    `${skipped} live test(s) skipped despite TEST_DATABASE_URL being configured - ` +
      'the database is unreachable, the variable is not visible to the test step, ' +
      'or a suite gate is wrong',
  );
}
if (passed === 0) {
  problems.push('no live test passed');
}
if (failed > 0) {
  problems.push(`${failed} live test(s) failed`);
}

if (problems.length > 0) {
  console.error('[live-coverage] FAILED:');
  for (const problem of problems) {
    console.error(`  - ${problem}`);
  }
  exit(1);
}

console.log(`[live-coverage] OK: all ${passed} live tests executed against real PostgreSQL.`);
exit(0);
