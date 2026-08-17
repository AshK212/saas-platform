import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

import { describe, expect, it } from 'vitest';

/**
 * AC-21 — THE CI PIPELINE AS AN ARCHITECTURE ARTIFACT.
 *
 * The workflow is not documentation. It is the gate that decides whether a
 * change reaches main, and every property that makes it trustworthy is one
 * line away from being deleted by someone trying to get a red build green.
 *
 * So the properties are asserted here, in the same suite as everything else.
 * Weakening the pipeline now breaks the build it was weakened to fix.
 *
 * What is pinned:
 *
 *   - main is tested on push AND on pull request
 *   - the runtime and package manager are pinned, never floating
 *   - installs are --frozen-lockfile
 *   - the static gate runs, and the schema drift gate runs
 *   - a real PostgreSQL service exists and the live suites run against it
 *   - the live suites CANNOT silently skip in CI
 *   - DATABASE_URL never reaches the live test step
 *   - permissions are read-only
 *   - no deployment, no secrets, no pull_request_target
 *   - no failure is swallowed
 *
 * ─── WHY THERE IS NO YAML PARSER ──────────────────────────────────────────
 *
 * The project has no YAML dependency, and adding one to assert on a file we
 * author ourselves would buy a supply-chain edge for very little. Instead the
 * helpers below read the file by indentation, which is enough to isolate a
 * named block and assert on its contents specifically - materially stronger
 * than searching the whole document for a substring, because it can tell
 * "TEST_DATABASE_URL appears in this step's env" from "it appears somewhere in
 * the file".
 */

const WORKFLOW_PATH = path.join('.github', 'workflows', 'ci.yml');
const workflow = readFileSync(WORKFLOW_PATH, 'utf8');
const lines = workflow.split(/\r?\n/);

/** Strips a trailing comment, preserving `#` inside quotes. */
function code(line: string): string {
  let quote: string | null = null;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (quote !== null) {
      if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === '#') {
      return line.slice(0, i);
    }
  }
  return line;
}

const indentOf = (line: string): number => line.length - line.trimStart().length;

/**
 * Every line belonging to the first block whose key line matches `matcher`,
 * i.e. the following lines indented more deeply than the key itself.
 */
function block(matcher: RegExp, from = 0): string[] {
  const start = lines.findIndex((line, i) => i >= from && matcher.test(code(line)));
  if (start === -1) {
    return [];
  }
  const depth = indentOf(lines[start] ?? '');
  const out: string[] = [];
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i] ?? '';
    if (code(line).trim() === '') continue;
    if (indentOf(line) <= depth) break;
    out.push(code(line));
  }
  return out;
}

/** The lines of the named job. */
const job = (name: string): string[] => block(new RegExp(`^\\s{2}${name}:\\s*$`));

/**
 * The lines of a single `- name: …` step, including its `run:` and `env:`.
 * This is what makes step-scoped environment assertions possible.
 */
function step(namePattern: RegExp): string[] {
  const start = lines.findIndex(
    (line) => /^\s*- name:/.test(code(line)) && namePattern.test(code(line)),
  );
  if (start === -1) {
    return [];
  }
  const depth = indentOf(lines[start] ?? '');
  const out = [code(lines[start] ?? '')];
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i] ?? '';
    if (code(line).trim() === '') continue;
    // A sibling `- name:` at the same indent ends this step.
    if (indentOf(line) <= depth) break;
    out.push(code(line));
  }
  return out;
}

const text = (block: string[]): string => block.join('\n');

/**
 * The workflow with every comment removed.
 *
 * Forbidden-token assertions must read the YAML, not the prose around it. The
 * workflow's own comments explain WHY there is no deployment step and why the
 * migration runner needs `DATABASE_URL` — and a naive search of the raw
 * document flags those explanations as violations, which pushes the next author
 * to delete the reasoning rather than keep it. (That is not hypothetical: the
 * first version of this suite failed on its own explanatory comment.)
 *
 * Stripping comments makes the guard sharper as well as quieter: it asserts
 * about what GitHub will actually execute.
 */
const executable = lines.map(code).join('\n');

// ───────────────────────────────────────────────────────────────────────────

describe('AC-21: the workflow exists and is structurally sound', () => {
  it('lives where GitHub looks for it', () => {
    expect(workflow.length).toBeGreaterThan(0);
    expect(code(lines[0] ?? '')).toContain('name:');
  });

  it('declares exactly the four top-level sections it needs', () => {
    const topLevel = lines
      .filter((line) => /^[a-z_]+:/.test(code(line)))
      .map((line) => code(line).split(':')[0]);

    expect(topLevel).toContain('on');
    expect(topLevel).toContain('permissions');
    expect(topLevel).toContain('jobs');
    expect(topLevel).toContain('concurrency');
  });

  it('uses no tab characters', () => {
    // YAML forbids tabs for indentation; a stray one is a parse error that
    // would only surface once GitHub tried to read the file.
    expect(workflow).not.toContain('\t');
  });

  it('indents in multiples of two, so the extractors above are meaningful', () => {
    const odd = lines.filter((line) => {
      const stripped = code(line);
      return stripped.trim() !== '' && indentOf(stripped) % 2 !== 0;
    });

    expect(odd).toEqual([]);
  });
});

describe('AC-21: main is genuinely gated', () => {
  const triggers = block(/^on:\s*$/);

  it('runs on push to main', () => {
    const push = block(/^\s{2}push:\s*$/);

    expect(text(triggers)).toContain('push:');
    expect(text(push)).toMatch(/branches:\s*\[main\]/);
  });

  it('runs on pull requests targeting main', () => {
    const pr = block(/^\s{2}pull_request:\s*$/);

    expect(text(triggers)).toContain('pull_request:');
    expect(text(pr)).toMatch(/branches:\s*\[main\]/);
  });

  it('offers manual dispatch for operator verification', () => {
    expect(text(triggers)).toContain('workflow_dispatch');
  });

  it('NEVER cancels a run on main', () => {
    // main's green run IS the AC-21 evidence. A cancelled run is not a pass,
    // so blanket cancel-in-progress would quietly destroy the artifact.
    const concurrency = block(/^concurrency:\s*$/);

    expect(text(concurrency)).toContain('cancel-in-progress');
    expect(text(concurrency)).toMatch(/github\.ref\s*!=\s*'refs\/heads\/main'/);
  });
});

describe('AC-21: the toolchain is pinned, not floating', () => {
  it('takes Node from .nvmrc rather than a channel', () => {
    expect(workflow).toContain('node-version-file: .nvmrc');
    expect(workflow).not.toMatch(/node-version:\s*(latest|lts\/\*|\*)/);
  });

  it('.nvmrc pins an exact Node 20 patch release', () => {
    const nvmrc = readFileSync('.nvmrc', 'utf8').trim();

    expect(nvmrc).toMatch(/^20\.\d+\.\d+$/);
  });

  it('takes pnpm from packageManager rather than a version literal', () => {
    const manifest = JSON.parse(readFileSync('package.json', 'utf8')) as {
      packageManager?: string;
    };

    expect(manifest.packageManager).toMatch(/^pnpm@\d+\.\d+\.\d+$/);
    // action-setup with no `version:` reads packageManager, so the workflow and
    // the repository can never disagree about which pnpm to use.
    expect(workflow).toContain('pnpm/action-setup@v4');
  });

  it('pins the PostgreSQL major', () => {
    expect(workflow).toMatch(/image:\s*postgres:\d+/);
    expect(workflow).not.toMatch(/image:\s*postgres:latest/);
    expect(workflow).not.toMatch(/image:\s*postgres\s*$/m);
  });

  it('uses only official first-party actions', () => {
    const used = [...workflow.matchAll(/uses:\s*([^\s]+)/g)].map((m) => m[1] ?? '');
    const allowed = [
      /^actions\/checkout@v\d+$/,
      /^actions\/setup-node@v\d+$/,
      // Diagnostic artifact upload only. First-party, and it runs no code of
      // ours - see the artifact assertions below.
      /^actions\/upload-artifact@v\d+$/,
      /^pnpm\/action-setup@v\d+$/,
    ];

    for (const action of used) {
      expect(
        allowed.some((pattern) => pattern.test(action)),
        `unexpected third-party action: ${action}`,
      ).toBe(true);
    }
  });
});

describe('AC-21: installs are reproducible', () => {
  it('every install is --frozen-lockfile', () => {
    const installs = [...workflow.matchAll(/run:\s*pnpm install[^\n]*/g)].map((m) => m[0]);

    expect(installs.length).toBeGreaterThanOrEqual(2);
    for (const install of installs) {
      expect(install).toContain('--frozen-lockfile');
    }
  });

  it('caches through setup-node rather than caching node_modules', () => {
    // A blindly restored node_modules can survive a lockfile change and make a
    // broken dependency graph look fine.
    expect(workflow).toContain('cache: pnpm');
    expect(workflow).not.toMatch(/path:\s*node_modules/);
  });
});

describe('AC-21: the static gate proves what it claims', () => {
  const verify = job('verify');

  it('runs the repository canonical verify command', () => {
    // Not a re-listing of lint/typecheck/test/build: using the same script a
    // developer runs means CI cannot drift from local expectations.
    expect(text(verify)).toContain('pnpm run verify');
  });

  it('runs the schema DRIFT gate, not only the journal check', () => {
    // db:check validates the journal's internal consistency and cannot see a
    // schema edit whose migration was never generated.
    expect(text(verify)).toContain('pnpm run db:drift');
    expect(text(verify)).toContain('pnpm run db:check');
  });

  it('does not commit generated migrations', () => {
    expect(workflow).not.toMatch(/git\s+(commit|push)/);
    expect(workflow).not.toContain('git add');
  });

  it('needs no database and no secret', () => {
    expect(text(verify)).not.toContain('DATABASE_URL');
    expect(text(verify)).not.toContain('secrets.');
  });
});

describe('AC-21: the live database gate is real', () => {
  const integration = job('integration');

  it('the integration job exists', () => {
    expect(integration.length).toBeGreaterThan(0);
  });

  it('provides a PostgreSQL service', () => {
    expect(text(integration)).toContain('services:');
    expect(text(integration)).toContain('postgres:');
  });

  it('waits on a deterministic health check instead of sleeping', () => {
    expect(text(integration)).toContain('--health-cmd');
    expect(text(integration)).toContain('pg_isready');
    expect(text(integration)).not.toMatch(/run:\s*sleep/);
  });

  it('applies migrations before testing', () => {
    expect(text(integration)).toContain('pnpm run db:migrate');
  });

  it('RUNS the live suites', () => {
    expect(text(integration)).toContain('pnpm run test:db:ci');
  });

  it('bounds its runtime so a deadlock fails rather than hangs', () => {
    const timeout = /timeout-minutes:\s*(\d+)/g;
    const values = [...text(integration).matchAll(timeout)].map((m) => Number(m[1]));

    expect(values.length).toBeGreaterThan(0);
    for (const value of values) {
      expect(value).toBeGreaterThan(0);
      // Generous enough for lock-serialization tests, tight enough that a hung
      // runner is visible rather than absorbed.
      expect(value).toBeLessThanOrEqual(30);
    }
  });
});

describe('AC-21: the live tests cannot silently skip in CI', () => {
  it('the job invokes the enforcing variant, not the plain one', () => {
    const liveStep = step(/Live PostgreSQL tests/);

    expect(liveStep.length).toBeGreaterThan(0);
    expect(text(liveStep)).toContain('pnpm run test:db:ci');
    // `pnpm test:db` alone exits 0 on "236 skipped".
    expect(text(liveStep)).not.toMatch(/run:\s*pnpm run test:db\s*$/);
  });

  it('test:db:ci delegates to the orchestrator, not to a shell chain', () => {
    const scripts = (
      JSON.parse(readFileSync('package.json', 'utf8')) as { scripts: Record<string, string> }
    ).scripts;

    expect(scripts['test:db:ci']).toBe('node scripts/run-live-ci.mjs');
    // THE ORIGINAL DEFECT. `vitest ... && checker` stopped the checker running
    // whenever vitest failed, so a run that both failed and skipped reported
    // neither. Restoring any form of it must break this.
    expect(scripts['test:db:ci']).not.toContain('&&');
  });

  it('the orchestrator runs BOTH reporters', () => {
    const runner = readFileSync(path.join('scripts', 'run-live-ci.mjs'), 'utf8');

    // Losing either one re-creates half the defect: no default reporter means
    // no readable failures, no json reporter means no coverage evidence.
    expect(runner).toContain("'--reporter=default'");
    expect(runner).toContain("'--reporter=json'");
    expect(runner).toContain('--outputFile=');
    expect(runner).toContain('vitest.live.ci.config.ts');
  });

  it('the orchestrator runs the coverage checker UNCONDITIONALLY', () => {
    const runner = readFileSync(path.join('scripts', 'run-live-ci.mjs'), 'utf8');

    // The checker invocation must not be nested inside a success branch.
    const checkerAt = runner.indexOf('CHECKER');
    expect(checkerAt).toBeGreaterThan(-1);
    expect(runner).not.toMatch(/if (vitestStatus === 0)[sS]*?CHECKER/);
    expect(runner).toContain('check-live-coverage.mjs');
  });

  it('the orchestrator fails if EITHER vitest or the checker failed', () => {
    const runner = readFileSync(path.join('scripts', 'run-live-ci.mjs'), 'utf8');

    expect(runner).toContain('if (vitestStatus !== 0)');
    expect(runner).toContain('if (checkerStatus !== 0)');
    // Vitest's own status is preserved rather than replaced by a synthetic one.
    expect(runner).toContain('process.exit(vitestStatus)');
    expect(runner).toContain('process.exit(checkerStatus)');
  });

  it('the orchestrator treats a missing report as a failure', () => {
    const runner = readFileSync(path.join('scripts', 'run-live-ci.mjs'), 'utf8');

    // An unanswerable coverage question is a failure, not a pass.
    expect(runner).toContain('coverage cannot be verified');
  });

  it('the vitest override cannot be used under CI', () => {
    const runner = readFileSync(path.join('scripts', 'run-live-ci.mjs'), 'utf8');

    // The one test seam, and the guard that stops it laundering a real run.
    expect(runner).toContain('LIVE_CI_VITEST_BIN');
    expect(runner).toContain('LIVE_CI_VITEST_BIN is set, but so is CI');
  });

  it('the coverage checker fails on skips when a database is configured', () => {
    const checker = readFileSync(path.join('scripts', 'check-live-coverage.mjs'), 'utf8');

    expect(checker).toContain("env['TEST_DATABASE_URL']");
    expect(checker).toContain('numPendingTests');
    // The three ways a job could be falsely green.
    expect(checker).toContain('skipped despite TEST_DATABASE_URL');
    expect(checker).toContain('no live tests were collected at all');
    expect(checker).toContain('no live test passed');
    expect(checker).toContain('exit(1)');
  });

  it('plain test:db still skips safely for a developer with no database', () => {
    const scripts = (
      JSON.parse(readFileSync('package.json', 'utf8')) as { scripts: Record<string, string> }
    ).scripts;

    // Local workflow must NOT require PostgreSQL.
    expect(scripts['test:db']).toBe('vitest run --config vitest.live.config.ts');
    expect(scripts['verify']).not.toContain('test:db');
  });
});

describe('AC-21: TEST_DATABASE_URL safety', () => {
  it('the live test step sees TEST_DATABASE_URL and NOT DATABASE_URL', () => {
    // The invariant every live suite depends on, asserted structurally: the
    // test step's own env block, not merely the file as a whole.
    const liveStep = step(/Live PostgreSQL tests/);
    const body = text(liveStep);

    expect(body).toContain('TEST_DATABASE_URL:');
    expect(body.replace(/TEST_DATABASE_URL/g, '')).not.toContain('DATABASE_URL');
  });

  it('DATABASE_URL is scoped to the migration step alone', () => {
    // The migration runner reads DATABASE_URL by contract. Scoping it to that
    // one step keeps it out of the test step's environment entirely, so the
    // live suites cannot reach it even by accident.
    const migrateStep = step(/Apply migrations/);

    expect(text(migrateStep)).toContain('DATABASE_URL:');
    // And it must be the disposable container, never a client value.
    expect(text(migrateStep)).toContain('localhost:5432');
    expect(text(migrateStep)).not.toContain('secrets.');
    expect(text(migrateStep)).not.toContain('neon.tech');
  });

  it('no job-level or workflow-level DATABASE_URL exists', () => {
    // A job-level definition would leak into the test step.
    const jobLevel = lines.filter((line) => /^\s{4}DATABASE_URL:/.test(code(line)));
    const workflowLevel = lines.filter((line) => /^\s{2}DATABASE_URL:/.test(code(line)));

    expect(jobLevel).toEqual([]);
    expect(workflowLevel).toEqual([]);
  });

  it('every database URL in the workflow is a disposable localhost one', () => {
    const urls = [...workflow.matchAll(/postgres(?:ql)?:\/\/[^\s'"]+/g)].map((m) => m[0]);

    expect(urls.length).toBeGreaterThan(0);
    for (const url of urls) {
      expect(url).toContain('localhost:5432');
      expect(url).toContain('hybrid_ci');
    }
  });
});

describe('AC-21: least privilege and PR safety', () => {
  it('grants contents: read and nothing else', () => {
    const permissions = block(/^permissions:\s*$/);

    expect(permissions.map((line) => line.trim())).toEqual(['contents: read']);
  });

  it('grants no write scope anywhere', () => {
    expect(workflow).not.toMatch(/contents:\s*write/);
    expect(workflow).not.toMatch(/packages:\s*write/);
    expect(workflow).not.toMatch(/id-token:\s*write/);
    expect(workflow).not.toMatch(/pull-requests:\s*write/);
    expect(workflow).not.toMatch(/issues:\s*write/);
  });

  it('NEVER uses pull_request_target', () => {
    // pull_request_target runs untrusted PR code with the base repository's
    // secrets and a writable token. It is the single most exploited GitHub
    // Actions misconfiguration, and this pipeline has no need for it.
    expect(executable).not.toContain('pull_request_target');
  });

  it('references no secret at all', () => {
    expect(executable).not.toContain('secrets.');
    expect(executable).not.toContain('${{ secrets');
  });

  it('names no client or production credential', () => {
    for (const forbidden of [
      'NEON',
      'RENDER',
      'RESEND',
      'DEPLOY_KEY',
      'DEPLOY_HOOK',
      'neon.tech',
      'onrender.com',
      'sslmode=require',
    ]) {
      expect(executable, `workflow must not name ${forbidden}`).not.toContain(forbidden);
    }
  });

  it('performs no deployment', () => {
    // AC-21 is verification. Deployment is the next phase.
    //
    // `actions/upload-artifact` used to be on this list, when the workflow
    // published nothing at all. It now uploads one diagnostic file, which is
    // not a deployment — nothing is released, tagged, pushed to a registry or
    // sent to a running environment. It is constrained instead by the
    // artifact assertions above: exactly one such step, uploading exactly the
    // report, carrying no credential.
    for (const forbidden of ['deploy', 'render.com', 'environment:', 'docker/build-push']) {
      expect(
        executable.toLowerCase(),
        `workflow must not contain ${forbidden}`,
      ).not.toContain(forbidden.toLowerCase());
    }
  });

  it('publishes nothing beyond the single diagnostic artifact', () => {
    const uploads = [...executable.matchAll(/uses:\s*actions\/upload-artifact/g)];

    expect(uploads).toHaveLength(1);
    // And no registry or release action of any kind.
    expect(executable).not.toMatch(/actions\/(create-release|upload-release-asset)/);
    expect(executable).not.toContain('npm publish');
    expect(executable).not.toContain('pnpm publish');
  });
});

describe('AC-21: no failure can be swallowed', () => {
  it('uses no continue-on-error', () => {
    expect(workflow).not.toContain('continue-on-error');
  });

  it('appends no || true and no exit-code laundering', () => {
    expect(workflow).not.toContain('|| true');
    expect(workflow).not.toContain('|| exit 0');
    expect(workflow).not.toMatch(/set\s+\+e/);
  });

  it('uses if: always() ONLY on the diagnostic artifact upload', () => {
    // This rule was a blanket ban, and it was right to be: `if: always()` on a
    // validation step turns a red result advisory. It is NARROWED rather than
    // dropped, because exactly one legitimate use exists — uploading the
    // failure report is wanted precisely WHEN the tests failed, and a file
    // upload cannot influence any test's status.
    const occurrences = [...executable.matchAll(/if:\s*always\(\)/g)];
    expect(occurrences).toHaveLength(1);

    const uploadStep = text(step(/Upload live-test report/));
    expect(uploadStep).toMatch(/if:\s*always\(\)/);
    expect(uploadStep).toContain('actions/upload-artifact');
  });

  it('NO VALIDATION STEP is advisory', () => {
    // The property the blanket ban existed to protect, now asserted directly:
    // every step that runs a command must be able to fail the job.
    const validationSteps = [
      /Verify \(lint/,
      /Schema drift/,
      /Migration journal/,
      /Apply migrations/,
      /Live PostgreSQL tests/,
    ];

    for (const name of validationSteps) {
      const body = text(step(name));

      expect(body.length, `step ${String(name)} not found`).toBeGreaterThan(0);
      expect(body).not.toContain('continue-on-error');
      expect(body).not.toMatch(/if:\s*always\(\)/);
      expect(body).not.toMatch(/if:\s*success\(\)/);
    }
  });

  it('the artifact step uploads ONLY the report, and no credential', () => {
    const uploadStep = text(step(/Upload live-test report/));

    expect(uploadStep).toContain('.vitest-live-report.json');
    expect(uploadStep).not.toContain('DATABASE_URL');
    expect(uploadStep).not.toContain('secrets.');
    // No directory sweep that could hoover up an env dump or a log file.
    expect(uploadStep).not.toMatch(/path:\s*\.\s*$/m);
    expect(uploadStep).not.toMatch(/path:\s*\*\*/);
  });

  it('does not pass --passWithNoTests to the enforcing live command', () => {
    const scripts = (
      JSON.parse(readFileSync('package.json', 'utf8')) as { scripts: Record<string, string> }
    ).scripts;

    // The live config sets passWithNoTests so an unconfigured LOCAL run is not
    // a failure. The CI path must not additionally mask an empty run - that is
    // precisely what check-live-coverage.mjs is there to catch, and the
    // orchestrator is what guarantees it runs.
    expect(scripts['test:db:ci']).toBe('node scripts/run-live-ci.mjs');
    expect(readFileSync(path.join('scripts', 'run-live-ci.mjs'), 'utf8')).toContain(
      'check-live-coverage.mjs',
    );
  });
});

describe('AC-21: the pipeline covers the security suites it must', () => {
  it('the static gate transitively runs the whole in-process suite', () => {
    const scripts = (
      JSON.parse(readFileSync('package.json', 'utf8')) as { scripts: Record<string, string> }
    ).scripts;

    // `verify` -> `test` -> `vitest run` with no path filter, so the AC-18,
    // AC-19 and AC-20 suites and every architecture guard are included by
    // construction. A filter here would be how they got quietly dropped.
    expect(scripts['verify']).toContain('run test');
    expect(scripts['test']).toContain('vitest run');
    expect(scripts['test']).not.toMatch(/vitest run\s+\S/);
  });

  it('the live config collects the AC-20 live suite', () => {
    const config = readFileSync('vitest.live.config.ts', 'utf8');

    // The include glob must cover packages/db/tests/*.live.test.ts, which is
    // where the AC-20 cross-tenant acceptance lives.
    expect(config).toContain('packages/*/tests/**/*.live.test.ts');
  });
});

// ───────────────────────────────────────────────────────────────────────────
// The skip-detector is itself a CI gate, so it gets executable coverage rather
// than only a source-text assertion. Each case runs the real script against a
// synthetic vitest report.
// ───────────────────────────────────────────────────────────────────────────

describe('AC-21: the live-coverage checker behaves correctly', () => {
  const CHECKER = path.join('scripts', 'check-live-coverage.mjs');

  /** Runs the checker against a synthetic report and returns its exit code. */
  function run(
    report: Record<string, number>,
    env: Record<string, string | undefined>,
  ): { code: number; output: string } {
    const file = path.join(os.tmpdir(), `ac21-report-${randomUUID()}.json`);
    writeFileSync(file, JSON.stringify(report));
    try {
      const result = spawnSync(process.execPath, [CHECKER, file], {
        encoding: 'utf8',
        // A clean environment, so the developer's own shell cannot decide the
        // outcome of a test about environment handling.
        env: { PATH: process.env['PATH'] ?? '', ...env },
      });
      return {
        code: result.status ?? -1,
        output: `${result.stdout ?? ''}${result.stderr ?? ''}`,
      };
    } finally {
      rmSync(file, { force: true });
    }
  }

  const HEALTHY = { numTotalTests: 236, numPassedTests: 236, numFailedTests: 0, numPendingTests: 0 };
  const ALL_SKIPPED = {
    numTotalTests: 236,
    numPassedTests: 0,
    numFailedTests: 0,
    numPendingTests: 236,
  };
  const DB = { TEST_DATABASE_URL: 'postgresql://u:p@localhost:5432/db' };

  it('accepts a fully executed run when a database is configured', () => {
    const { code, output } = run(HEALTHY, { ...DB, CI: 'true' });

    expect(code).toBe(0);
    expect(output).toContain('all 236 live tests executed');
  });

  it('REJECTS an all-skipped run when a database IS configured', () => {
    // The headline case: a green "236 skipped" job.
    const { code, output } = run(ALL_SKIPPED, { ...DB, CI: 'true' });

    expect(code).toBe(1);
    expect(output).toContain('skipped despite TEST_DATABASE_URL');
  });

  it('rejects a partially skipped run', () => {
    // One suite whose gate is wrong is still a hole.
    const { code } = run(
      { numTotalTests: 236, numPassedTests: 235, numFailedTests: 0, numPendingTests: 1 },
      { ...DB, CI: 'true' },
    );

    expect(code).toBe(1);
  });

  it('rejects a run that collected nothing', () => {
    const { code, output } = run(
      { numTotalTests: 0, numPassedTests: 0, numFailedTests: 0, numPendingTests: 0 },
      { ...DB, CI: 'true' },
    );

    expect(code).toBe(1);
    expect(output).toContain('no live tests were collected');
  });

  it('rejects a run with failures', () => {
    const { code } = run(
      { numTotalTests: 236, numPassedTests: 230, numFailedTests: 6, numPendingTests: 0 },
      { ...DB, CI: 'true' },
    );

    expect(code).toBe(1);
  });

  it('REJECTS a CI run with no database at all', () => {
    // A renamed variable or a service that failed to start must break the job,
    // not fall through to the local "skipping is fine" branch.
    const { code, output } = run(ALL_SKIPPED, { CI: 'true' });

    expect(code).toBe(1);
    expect(output).toContain('TEST_DATABASE_URL is not set, but CI is');
  });

  it('lets a LOCAL run skip without failing, and says so plainly', () => {
    // Local developer experience must not regress: no PostgreSQL required.
    const { code, output } = run(ALL_SKIPPED, {});

    expect(code).toBe(0);
    expect(output).toContain('SKIPPED IS NOT PASSED');
  });

  it('rejects a local run in which tests somehow executed without a database', () => {
    // Would mean a live suite lost its gate.
    const { code } = run(HEALTHY, {});

    expect(code).toBe(1);
  });
});

describe('AC-21: the CI live config cannot drift from the local one', () => {
  /** The `include` array as written in a vitest config file. */
  function includeGlobs(file: string): string[] {
    const source = readFileSync(file, 'utf8');
    const start = source.indexOf('include: [');
    expect(start, `${file} declares no include`).toBeGreaterThan(-1);
    const end = source.indexOf(']', start);
    return source
      .slice(start + 'include: ['.length, end)
      .split(',')
      .map((entry) => entry.trim().replace(/^['"]|['"]$/g, ''))
      .filter((entry) => entry !== '');
  }

  it('collects exactly the same suites as vitest.live.config.ts', () => {
    // The CI config is a standalone copy plus one exclusion, because it cannot
    // import the other one (Vite wants a .ts extension, tsc forbids it). This
    // turns the resulting drift hazard into a test failure: if the local config
    // starts collecting a new directory and this one does not, CI would quietly
    // stop running a whole suite.
    expect(includeGlobs('vitest.live.ci.config.ts')).toEqual(
      includeGlobs('vitest.live.config.ts'),
    );
  });

  it('differs from the local config ONLY by the Neon-connectivity exclusion', () => {
    const ci = readFileSync('vitest.live.ci.config.ts', 'utf8');

    // Excluded because CI has a disposable Postgres container, not Neon, and
    // that suite gates on DATABASE_URL which is deliberately out of scope in
    // the test step.
    expect(ci).toContain('neon-connectivity.live.test.ts');
    // And nothing else is excluded, so no behavioural suite can be dropped
    // under cover of this mechanism.
    const excluded = ci
      .slice(ci.indexOf('exclude: ['), ci.indexOf(']', ci.indexOf('exclude: [')))
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.startsWith("'") || line.startsWith('"'));
    expect(excluded).toHaveLength(3);
  });

  it('refuses an empty collection, unlike the local config', () => {
    const ci = readFileSync('vitest.live.ci.config.ts', 'utf8');
    const local = readFileSync('vitest.live.config.ts', 'utf8');

    expect(ci).toContain('passWithNoTests: false');
    // The local config deliberately allows it: an unconfigured developer run
    // with nothing to execute is a valid outcome, not a failure.
    expect(local).toContain('passWithNoTests: true');
  });

  it('is the config the CI script actually uses', () => {
    const scripts = (
      JSON.parse(readFileSync('package.json', 'utf8')) as { scripts: Record<string, string> }
    ).scripts;

    expect(readFileSync(path.join('scripts', 'run-live-ci.mjs'), 'utf8')).toContain(
      'vitest.live.ci.config.ts',
    );
    // ...and the plain local command still uses the permissive one.
    expect(scripts['test:db']).toContain('vitest.live.config.ts');
    expect(scripts['test:db']).not.toContain('vitest.live.ci.config.ts');
  });
});

// ───────────────────────────────────────────────────────────────────────────
// The orchestrator's exit semantics, proven by running it for real.
//
// No PostgreSQL is involved and none is needed: what is under test is how two
// exit statuses combine, which is exactly the logic the original `&&` got
// wrong. Vitest is replaced by a stub (via the CI-refused seam) and the
// coverage checker by a stub planted in a temporary working directory, so the
// real script executes its real branches.
// ───────────────────────────────────────────────────────────────────────────

describe('AC-21: the live-CI orchestrator combines statuses correctly', () => {
  const RUNNER = path.resolve('scripts', 'run-live-ci.mjs');

  interface Scenario {
    /** Exit status the stubbed vitest returns. */
    vitest: number;
    /** Exit status the stubbed coverage checker returns. */
    checker: number;
    /** Whether the stubbed vitest writes a report. */
    report?: 'valid' | 'corrupt' | 'missing';
  }

  function runOrchestrator({ vitest, checker, report = 'valid' }: Scenario): {
    code: number;
    output: string;
  } {
    const dir = path.join(os.tmpdir(), `ac21-orch-${randomUUID()}`);
    mkdirSync(path.join(dir, 'scripts'), { recursive: true });

    // A stub vitest: writes the report (or does not) and exits as directed.
    const reportBody =
      report === 'corrupt'
        ? 'not json at all'
        : JSON.stringify({
            numTotalTests: 230,
            numPassedTests: vitest === 0 ? 230 : 0,
            numFailedTests: vitest === 0 ? 0 : 230,
            numPendingTests: 0,
            testResults: [
              {
                assertionResults: [
                  {
                    fullName: 'stub suite > a stubbed failing test',
                    status: vitest === 0 ? 'passed' : 'failed',
                    failureMessages: vitest === 0 ? [] : ['Error: stubbed failure\n  at nowhere'],
                  },
                ],
              },
            ],
          });

    writeFileSync(
      path.join(dir, 'stub-vitest.mjs'),
      report === 'missing'
        ? `process.exit(${String(vitest)});\n`
        : `import { writeFileSync } from 'node:fs';\n` +
            `writeFileSync('.vitest-live-report.json', ${JSON.stringify(reportBody)});\n` +
            `process.exit(${String(vitest)});\n`,
    );

    // A stub checker, at the path the orchestrator resolves from the cwd.
    writeFileSync(
      path.join(dir, 'scripts', 'check-live-coverage.mjs'),
      `console.log('[stub-checker] ran');\nprocess.exit(${String(checker)});\n`,
    );

    try {
      const result = spawnSync(process.execPath, [RUNNER], {
        cwd: dir,
        encoding: 'utf8',
        env: {
          PATH: process.env['PATH'] ?? '',
          LIVE_CI_VITEST_BIN: path.join(dir, 'stub-vitest.mjs'),
        },
      });
      return {
        code: result.status ?? -1,
        output: `${result.stdout ?? ''}${result.stderr ?? ''}`,
      };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it('A. tests pass and coverage passes -> exits 0', () => {
    const { code, output } = runOrchestrator({ vitest: 0, checker: 0 });

    expect(code).toBe(0);
    expect(output).toContain('[stub-checker] ran');
    expect(output).toContain('live suites passed and coverage was verified');
  });

  it('B. TESTS FAIL, coverage passes -> exits non-zero AND still runs the checker', () => {
    // The original defect: `&&` skipped the checker entirely here.
    const { code, output } = runOrchestrator({ vitest: 1, checker: 0 });

    expect(code).toBe(1);
    expect(output).toContain('[stub-checker] ran');
    expect(output).toContain('live tests did not pass');
  });

  it('C. tests pass, COVERAGE FAILS -> exits non-zero', () => {
    // The all-skipped case. A green suite must not carry a hollow run through.
    const { code, output } = runOrchestrator({ vitest: 0, checker: 1 });

    expect(code).toBe(1);
    expect(output).toContain('live coverage verification did not pass');
  });

  it('D. both fail -> exits non-zero, preserving vitest status', () => {
    const { code, output } = runOrchestrator({ vitest: 2, checker: 1 });

    expect(code).toBe(2);
    expect(output).toContain('[stub-checker] ran');
  });

  it('E. no report written -> fails safely with a useful message', () => {
    const { code, output } = runOrchestrator({ vitest: 0, checker: 0, report: 'missing' });

    expect(code).toBe(1);
    expect(output).toContain('coverage cannot be verified');
    // The checker cannot answer without a report, so it is not pretended to.
    expect(output).not.toContain('[stub-checker] ran');
  });

  it('E2. corrupt report -> the checker still runs and decides', () => {
    // A malformed report is the checker's problem to report, not a crash in
    // the orchestrator: the summary is skipped and the checker exits 2.
    const { code, output } = runOrchestrator({ vitest: 0, checker: 2, report: 'corrupt' });

    expect(code).toBe(2);
    expect(output).toContain('[stub-checker] ran');
  });

  it('prints a compact failure summary derived from the report', () => {
    const { output } = runOrchestrator({ vitest: 1, checker: 0 });

    expect(output).toContain('[live-tests] FAILED: 1 test(s)');
    expect(output).toContain('stub suite > a stubbed failing test');
    expect(output).toContain('Error: stubbed failure');
    // First line only - the default reporter already printed the stack.
    expect(output).not.toContain('at nowhere');
  });

  it('REFUSES the vitest override when CI is set', () => {
    const dir = path.join(os.tmpdir(), `ac21-orch-${randomUUID()}`);
    mkdirSync(path.join(dir, 'scripts'), { recursive: true });
    writeFileSync(path.join(dir, 'stub-vitest.mjs'), 'process.exit(0);\n');

    try {
      const result = spawnSync(process.execPath, [RUNNER], {
        cwd: dir,
        encoding: 'utf8',
        env: {
          PATH: process.env['PATH'] ?? '',
          CI: 'true',
          LIVE_CI_VITEST_BIN: path.join(dir, 'stub-vitest.mjs'),
        },
      });

      // Without this guard the seam would be the one way to make a failing
      // integration job green.
      expect(result.status).toBe(1);
      expect(`${result.stdout ?? ''}${result.stderr ?? ''}`).toContain(
        'LIVE_CI_VITEST_BIN is set, but so is CI',
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
