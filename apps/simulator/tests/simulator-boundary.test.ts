import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * ARCHITECTURE GUARDS for the reference client.
 *
 * ─── WHAT THE SIMULATOR IS FOR ────────────────────────────────────────────
 *
 * It exists to prove the PUBLIC API is sufficient to run a governed fleet.
 * That proof is only worth something if the client is genuinely unprivileged:
 * one `@hybrid/db` import and it is reading the ledger directly rather than
 * demonstrating that a real runtime could.
 *
 * Three properties carry the whole argument, and each fails silently:
 *
 *   1. NO DATABASE. HTTP only.
 *   2. NO OPERATOR AUTHORITY. It cannot set a cap, pause an agent, or change
 *      anything the plane governs.
 *   3. NO LOCAL GOVERNANCE. It never computes a verdict itself - a second
 *      engine drifts from the first the moment an operator changes policy.
 *
 * Each is mutation-probed in the Step 20 report.
 */

const SIM_ROOT = path.resolve(import.meta.dirname, '..');
const SRC = path.join(SIM_ROOT, 'src');

interface SourceFile {
  readonly name: string;
  readonly raw: string;
  /** Comments stripped, so prose about a pattern cannot trip its guard. */
  readonly code: string;
}

function sources(dir = SRC): SourceFile[] {
  const found: SourceFile[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      found.push(...sources(full));
      continue;
    }
    if (!entry.name.endsWith('.ts')) continue;
    const raw = readFileSync(full, 'utf8');
    found.push({
      name: path.relative(SRC, full),
      raw,
      code: raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, ''),
    });
  }
  return found;
}

const files = sources();
const allCode = files.map((f) => f.code).join('\n');

/** Every import specifier in the simulator's source. */
function importedModules(): string[] {
  const specifiers: string[] = [];
  for (const file of files) {
    for (const match of file.code.matchAll(/from\s+'([^']+)'/g)) {
      const specifier = match[1];
      if (specifier !== undefined) specifiers.push(specifier);
    }
  }
  return specifiers;
}

describe('THE REFERENCE CLIENT HAS NO DATABASE ACCESS', () => {
  it('imports no database package', () => {
    // PROBE E. The lint rule blocks this too; this asserts the property
    // survives even if someone edits the lint config.
    const modules = importedModules();

    for (const forbidden of ['@hybrid/db', 'drizzle-orm', 'pg', 'postgres']) {
      expect(
        modules.filter((m) => m === forbidden || m.startsWith(`${forbidden}/`)),
        forbidden,
      ).toEqual([]);
    }
  });

  it('names no schema table', () => {
    for (const table of [
      'agentPolicies',
      'ledgerDaily',
      'precheckReceipts',
      'workspacePolicyState',
      'apiCredentials',
      'workspaceMemberships',
    ]) {
      expect(allCode, table).not.toContain(table);
    }
  });

  it('imports no API internals', () => {
    const modules = importedModules();

    // A runtime integrating against this contract will have none of these.
    for (const specifier of modules) {
      expect(specifier).not.toMatch(/apps\/api/);
      expect(specifier).not.toMatch(/\.\.\/\.\.\/api/);
      expect(specifier).not.toContain('@hybrid/config/server');
    }
  });

  it('depends only on contracts and Node built-ins', () => {
    const external = importedModules().filter((m) => !m.startsWith('.'));

    expect(new Set(external)).toEqual(new Set(['@hybrid/contracts', 'node:crypto']));
  });

  it('declares no database dependency in its manifest', () => {
    const manifest = JSON.parse(readFileSync(path.join(SIM_ROOT, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>;
    };

    expect(Object.keys(manifest.dependencies ?? {})).toEqual(['@hybrid/contracts']);
  });
});

describe('THE REFERENCE CLIENT HAS NO OPERATOR AUTHORITY', () => {
  it('calls no policy mutation route', () => {
    // PROBE C. Credit acceptance configures caps and pauses through the
    // authenticated operator UI. A runtime that could set its own cap would
    // make the whole governance model decorative.
    for (const forbidden of ['agentPolicyPath', '/policy/', 'PUT', 'PATCH', 'DELETE']) {
      expect(allCode, forbidden).not.toContain(forbidden);
    }
  });

  it('uses only the four machine routes', () => {
    const paths = [
      'AGENT_REGISTER_PATH',
      'POLICY_POLL_PATH',
      'PRECHECK_PATH',
      'EVENT_INGEST_PATH',
    ];
    for (const name of paths) {
      expect(allCode, name).toContain(name);
    }

    // Operator surfaces are absent entirely - not called and not imported.
    for (const operatorPath of [
      'workspaceReceiptsPath',
      'workspaceBlocksPath',
      'workspaceEventsPath',
      'workspaceApiKeysPath',
      'WORKSPACES_PATH',
      'AUTH_MAGIC_LINK_PATH',
    ]) {
      expect(allCode, operatorPath).not.toContain(operatorPath);
    }
  });

  it('sends no workspace identity and no session cookie', () => {
    for (const forbidden of [
      'workspace_id',
      'workspaceId',
      'X-Workspace',
      'x-workspace',
      'tenant_id',
      'cookie',
      'credentials:',
    ]) {
      expect(allCode, forbidden).not.toContain(forbidden);
    }
  });

  it('only ever issues GET and POST', () => {
    const methods = [...allCode.matchAll(/method:\s*'([A-Z]+)'/g)].map((m) => m[1]);

    expect(methods.length).toBeGreaterThan(0);
    expect(new Set(methods)).toEqual(new Set(['GET', 'POST']));
  });
});

describe('THE REFERENCE CLIENT MAKES NO GOVERNANCE DECISION', () => {
  const decisionFiles = files.filter((f) => /runtime\.ts|scenarios\.ts/.test(f.name));

  it('never compares a cap to a total', () => {
    // A client that computes its own verdict is a SECOND governance engine,
    // and its copy of the cap goes stale the instant an operator changes it.
    for (const file of decisionFiles) {
      expect(file.code, `${file.name} cap comparison`).not.toMatch(
        /(?:cap|limit|remaining|committed|budget)\s*[<>]=?/i,
      );
      expect(file.code, `${file.name} threshold`).not.toMatch(
        /[<>]=?\s*(?:cap|limit|remaining|committed|budget)/i,
      );
    }
  });

  it('never inspects mode to decide', () => {
    for (const file of decisionFiles) {
      for (const mode of ["'paused'", "'budgeted'", "'watch'"]) {
        expect(file.code, `${file.name} ${mode}`).not.toContain(mode);
      }
    }
  });

  it('branches ONLY on the decision the plane returned', () => {
    const runtime = files.find((f) => f.name === 'runtime.ts');
    expect(runtime).toBeDefined();

    // Exactly one thing decides what happens next.
    expect(runtime?.code).toContain("decision.decision === 'deny'");
    // And nothing recomputes it.
    expect(runtime?.code).not.toContain('shouldAllow');
    expect(runtime?.code).not.toContain('isOverCap');
  });

  it('keeps NO authoritative ledger of its own', () => {
    // The server ledger is authority. A client-side total would drift and
    // invite someone to "reconcile" it.
    for (const accumulator of [
      'spendCommitted',
      'publishCount',
      'dailySpend',
      'totalSpent',
      'runningTotal',
    ]) {
      expect(allCode, accumulator).not.toContain(accumulator);
    }

    // No `+=` onto anything money- or usage-shaped. Loop counters (`attempt`,
    // `ordinal`, `cycle`) are fine and are what the scoped pattern permits.
    const offenders = [...allCode.matchAll(/(\w+)\s*\+=/g)]
      .map((m) => m[1] ?? '')
      .filter((name) => /spend|amount|usd|total|count|usage|budget|ledger/i.test(name));
    expect(offenders).toEqual([]);
  });

  it('does no arithmetic on money', () => {
    // Amounts are exact decimal STRINGS end to end.
    for (const float of ['parseFloat', 'Number(', 'toFixed', 'parseInt(amount']) {
      expect(allCode, float).not.toContain(float);
    }
  });
});

describe('A PLANE DENIAL IS NOT A RUNTIME BLOCK', () => {
  it('the denial branch emits no event at all', () => {
    const runtime = files.find((f) => f.name === 'runtime.ts');
    const code = runtime?.code ?? '';

    // Between recognising a denial and returning, nothing is sent. Two records
    // for one refusal would leave an operator unable to tell which system
    // stopped the work.
    for (const match of code.matchAll(/decision\.decision === 'deny'\)\s*\{([\s\S]*?)\n {4}\}/g)) {
      const branch = match[1] ?? '';
      expect(branch).not.toContain('ingestEvents');
      expect(branch).not.toContain('action.blocked');
      expect(branch).toContain('return {');
    }
  });

  it('action.blocked is reachable only from the runtime-block reporter', () => {
    const runtime = files.find((f) => f.name === 'runtime.ts');
    const occurrences = [...(runtime?.code.matchAll(/'action\.blocked'/g) ?? [])];

    // Exactly one construction site, in `reportRuntimeBlock`.
    expect(occurrences).toHaveLength(1);
    expect(runtime?.code).toContain('async function reportRuntimeBlock(');
  });

  it('no scenario calls the runtime-block reporter', () => {
    const scenarios = files.find((f) => f.name === 'scenarios.ts');

    // It exists for a genuinely runtime-side denial, which none of the Credit
    // acceptance flows involve.
    expect(scenarios?.code).not.toContain('reportRuntimeBlock');
  });
});

describe('SECRETS', () => {
  it('embeds no API key anywhere in the source', () => {
    for (const file of files) {
      expect(file.raw, file.name).not.toMatch(/hmp_live_[A-Za-z0-9_-]{8,}/);
    }
  });

  it('offers no --api-key flag', () => {
    // A flag would put a live credential into shell history and `ps` output.
    //
    // Checks that no flag of that name is READ. The usage text mentions
    // `--api-key` precisely to say it does not exist, and that sentence is
    // worth keeping.
    expect(allCode).not.toMatch(/flags\[\s*'api[-_]?key'\s*\]/i);
    expect(allCode).not.toMatch(/flags\.\s*apiKey/);
  });

  it('has no default or fallback credential', () => {
    const config = files.find((f) => f.name === 'config.ts');

    expect(config?.code).toContain("env['CONTROL_PLANE_API_KEY'] ?? ''");
    // The only fallback is the empty string, which then fails loudly.
    expect(config?.code).not.toMatch(/CONTROL_PLANE_API_KEY'\]\s*\?\?\s*'[^']+'/);
  });

  it('writes to the console from ONE module only', () => {
    // PROBE D. Redaction is worthless if another file can print directly.
    const offenders = files
      .filter((f) => f.name !== 'logging.ts' && /console\./.test(f.code))
      .map((f) => f.name);

    expect(offenders).toEqual([]);
  });

  it('the error types carry no request material', () => {
    const client = files.find((f) => f.name === 'client.ts');

    // A thrown object holding headers is a credential one console.error away
    // from a terminal.
    expect(client?.code).toContain('class ControlPlaneError');
    expect(client?.code).not.toMatch(/ControlPlaneError[\s\S]{0,600}?headers/);
    expect(client?.code).not.toContain('init,');
  });

  it('reads the key in exactly one place', () => {
    const occurrences = [...allCode.matchAll(/options\.apiKey/g)];

    expect(occurrences).toHaveLength(1);
  });
});

describe('OPERATIONAL SAFETY', () => {
  it('every request has a timeout', () => {
    const client = files.find((f) => f.name === 'client.ts');

    // An unbounded request hangs a CLI forever.
    expect(client?.code).toContain('AbortSignal.timeout(timeoutMs)');
  });

  it('retries are bounded', () => {
    const client = files.find((f) => f.name === 'client.ts');

    expect(client?.code).toContain('attempt <= maxRetries');
    expect(client?.code).not.toContain('while (true)');
  });

  it('a retry never rebuilds the request body', () => {
    // PROBE B. Rebuilding would generate a fresh identity and turn one
    // uncertain action into two real ones.
    const client = files.find((f) => f.name === 'client.ts');
    const code = client?.code ?? '';
    const start = code.indexOf('async function send(');
    // `parse` is generic (`parse<T>`), so match on the declaration prefix
    // rather than assuming a bare `(` follows the name.
    const end = code.indexOf('async function parse');

    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const send = code.slice(start, end);

    // The body arrives already serialised and is replayed unchanged. A
    // `JSON.stringify` in here would mean the request is rebuilt per attempt.
    expect(send).not.toContain('JSON.stringify');
    expect(send).not.toContain('actionId');
    expect(send).not.toContain('eventId');
  });

  it('handles termination signals and unrefs its timers', () => {
    const index = files.find((f) => f.name === 'index.ts');

    expect(index?.code).toContain("process.once('SIGINT'");
    expect(index?.code).toContain("process.once('SIGTERM'");
    // A referenced timer keeps the process alive after the work is done.
    expect(index?.code).toContain('unref?.()');
  });

  it('returns a meaningful exit code', () => {
    const index = files.find((f) => f.name === 'index.ts');

    expect(index?.code).toContain('EXIT_OK');
    expect(index?.code).toContain('EXIT_FAILED');
    expect(index?.code).toContain('EXIT_USAGE');
  });
});

describe('CONTRACT REUSE', () => {
  it('takes paths and schemas from the shared package, not literals', () => {
    // Duplicating a wire schema here is how a client drifts from its server.
    expect(allCode).toContain("from '@hybrid/contracts'");
    // No hand-written route strings.
    expect(allCode).not.toContain("'/v1/events'");
    expect(allCode).not.toContain("'/v1/actions/precheck'");
    expect(allCode).not.toContain("'/v1/agents/register'");
    expect(allCode).not.toContain("'/v1/policy'");
  });

  it('validates every response against its contract', () => {
    const client = files.find((f) => f.name === 'client.ts');

    for (const schema of [
      'registerAgentResponseSchema',
      'policySnapshotSchema',
      'precheckResponseSchema',
      'eventIngestResponseSchema',
    ]) {
      expect(client?.code, schema).toContain(schema);
    }
  });
});
