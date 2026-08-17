#!/usr/bin/env node
/**
 * Runs the live PostgreSQL suites in CI and reports BOTH signals.
 *
 * ─── THE DEFECT THIS REPLACES ─────────────────────────────────────────────
 *
 * The first real GitHub Actions run failed with this, and nothing else:
 *
 *     JSON report written to /home/runner/.../.vitest-live-report.json
 *     ELIFECYCLE Command failed with exit code 1.
 *
 * No test names. No assertions. No counts. Two mistakes produced that:
 *
 *   1. `--reporter=json` REPLACES the default reporter rather than adding to
 *      it, so every failure message went to a file and nothing was printed.
 *      The file was then discarded with the runner.
 *
 *   2. The command was `vitest ... && node check-live-coverage.mjs ...`, so
 *      when vitest exited non-zero the coverage checker never ran. A run that
 *      both failed AND skipped reported neither.
 *
 * The evidence existed on the runner and was thrown away. This script makes
 * both signals unconditional.
 *
 * ─── WHAT IT GUARANTEES ───────────────────────────────────────────────────
 *
 *   - vitest runs with the DEFAULT reporter (human-readable failures, streamed
 *     to the Actions log) AND the json reporter (machine-readable counts).
 *   - the coverage checker runs whatever vitest did - passed, failed, skipped,
 *     or collected nothing.
 *   - the exit status is non-zero if EITHER failed, and zero only if both
 *     passed. A failing suite can never be laundered into a green job.
 *
 * ─── WHY NODE AND NOT SHELL ───────────────────────────────────────────────
 *
 * `a; b; exit $((...))` is where this logic usually lives, and it is where it
 * usually goes wrong - exit-status capture differs between sh, bash and
 * PowerShell, and the repository is developed on Windows and run on Linux.
 * Explicit statuses in one readable file behave identically on both.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import process from 'node:process';

const REPORT_PATH = '.vitest-live-report.json';
const CONFIG = 'vitest.live.ci.config.ts';
const CHECKER = path.join('scripts', 'check-live-coverage.mjs');

/**
 * The vitest CLI entry, resolved through package metadata.
 *
 * Not `node_modules/vitest/vitest.mjs`, which is a guess about layout that
 * pnpm's store structure does not guarantee, and not `pnpm exec vitest`, which
 * would mean spawning a `.cmd` shim on Windows that Node 20 refuses to launch
 * directly. Reading the package's own `bin` field is correct on both.
 */
function resolveVitestBin() {
  // ─── A TEST SEAM THAT CANNOT LAUNDER CI ─────────────────────────────────
  //
  // Proving the exit-status combination below requires driving vitest to exit
  // 0 and 1 on demand, which no real database-less run can do. This override
  // lets the contract tests point it at a stub.
  //
  // It is REFUSED when CI is set. Otherwise it would be the one hole in a
  // script whose entire purpose is that a failing suite cannot be turned
  // green - someone could point it at `true` and the job would pass having
  // run nothing. Refusing loudly is better than trusting nobody sets it.
  const override = process.env['LIVE_CI_VITEST_BIN'];
  if (override !== undefined && override !== '') {
    if ((process.env['CI'] ?? '').trim() !== '') {
      console.error('[live-ci] FAILED: LIVE_CI_VITEST_BIN is set, but so is CI.');
      console.error('  This override exists only so the orchestration tests can drive');
      console.error('  exit statuses. It must never decide what CI executes.');
      process.exit(1);
    }
    return override;
  }

  const require = createRequire(import.meta.url);
  const manifestPath = require.resolve('vitest/package.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const bin = typeof manifest.bin === 'string' ? manifest.bin : manifest.bin?.vitest;
  if (typeof bin !== 'string') {
    throw new Error('vitest package declares no bin entry');
  }
  return path.resolve(path.dirname(manifestPath), bin);
}

/** Runs a command with inherited stdio so its output streams to the log. */
function run(command, args) {
  const result = spawnSync(command, args, { stdio: 'inherit', shell: false });
  if (result.error !== undefined) {
    console.error(`[live-ci] could not start ${command}: ${result.error.message}`);
    return 127;
  }
  // A signal death has no exit code; treat it as a failure rather than as 0.
  if (result.status === null) {
    console.error(`[live-ci] ${command} terminated by signal ${String(result.signal)}`);
    return 1;
  }
  return result.status;
}

// ── 1. The suites, with BOTH reporters ─────────────────────────────────────
//
// `--reporter=default` is what a human reads. `--reporter=json` is what
// check-live-coverage.mjs reads. Removing either one re-creates half of the
// original defect, so the CI contract test asserts both are present.
console.log('[live-ci] running live suites (default + json reporters)...');
const vitestStatus = run(process.execPath, [
  resolveVitestBin(),
  'run',
  '--config',
  CONFIG,
  '--reporter=default',
  '--reporter=json',
  `--outputFile=${REPORT_PATH}`,
]);

console.log(`[live-ci] vitest exited ${String(vitestStatus)}`);

// ── 2. A compact failure summary, derived from the report ──────────────────
//
// The default reporter above is the primary evidence and already prints full
// diffs and stacks. This adds a short roll-up at the END of the log, because
// GitHub shows the tail of a step first and a reader should not have to scroll
// through 230 results to learn which handful broke.
function summarizeFailures() {
  if (!existsSync(REPORT_PATH)) {
    return;
  }
  let report;
  try {
    report = JSON.parse(readFileSync(REPORT_PATH, 'utf8'));
  } catch {
    return;
  }

  const failures = [];
  for (const suite of report.testResults ?? []) {
    for (const assertion of suite.assertionResults ?? []) {
      if (assertion.status === 'failed') {
        // FIRST line only. The default reporter already printed the full
        // stack; repeating it here would bury the roll-up it exists to be.
        const first = (assertion.failureMessages ?? [])[0] ?? '';
        failures.push({
          name: assertion.fullName ?? assertion.title ?? '(unnamed test)',
          message: String(first).split('\n')[0]?.trim() ?? '',
        });
      }
    }
  }

  if (failures.length === 0) {
    return;
  }

  console.error('');
  console.error(`[live-tests] FAILED: ${String(failures.length)} test(s)`);
  for (const failure of failures) {
    console.error(`  - ${failure.name}`);
    if (failure.message !== '') {
      console.error(`      ${failure.message}`);
    }
  }
  console.error('');
}

summarizeFailures();

// ── 3. The coverage checker, ALWAYS ────────────────────────────────────────
//
// Unconditional by design. Its answer is orthogonal to vitest's: a run can
// fail AND have skipped, and the original `&&` meant we learned neither. The
// skipped-but-green case is the one that would otherwise look like success.
let checkerStatus;
if (!existsSync(REPORT_PATH)) {
  // Vitest produced no report at all - it crashed before writing one, or the
  // path is wrong. Either way the coverage question is unanswerable, and
  // unanswerable is a failure, not a pass.
  console.error(`[live-ci] FAILED: no report at ${REPORT_PATH}; coverage cannot be verified.`);
  checkerStatus = 1;
} else {
  console.log('[live-ci] verifying live coverage...');
  checkerStatus = run(process.execPath, [CHECKER, REPORT_PATH]);
  console.log(`[live-ci] coverage checker exited ${String(checkerStatus)}`);
}

// ── 4. One deterministic status ────────────────────────────────────────────
//
// Non-zero if EITHER failed. Vitest's own status is preserved when it is the
// failing one, so a familiar exit code is not replaced by a synthetic one.
if (vitestStatus !== 0) {
  console.error('[live-ci] FAILED: live tests did not pass.');
  process.exit(vitestStatus);
}
if (checkerStatus !== 0) {
  console.error('[live-ci] FAILED: live coverage verification did not pass.');
  process.exit(checkerStatus);
}

console.log('[live-ci] OK: live suites passed and coverage was verified.');
process.exit(0);
