import { createControlPlaneClient, ControlPlaneError, TransportError } from './client.js';
import { ConfigError, parseArgs, resolveConfig, type SimulatorConfig } from './config.js';
import {
  DEFAULT_ACTIVITY_INTERVAL_MS,
  DEFAULT_BLOCK_INTERVAL_MS,
  MIN_ACTIVITY_INTERVAL_MS,
  MIN_BLOCK_INTERVAL_MS,
  readIntervalMs,
  runDemoGenerator,
} from './demo-generator.js';
import { createIdFactory } from './ids.js';
import { createLogger, type Logger } from './logging.js';
import { createRuntime } from './runtime.js';
import { sleep } from './sleep.js';
import {
  registerFleet,
  runBaseline,
  runCapRaiseRetry,
  runOverCap,
  runPauseProbe,
  runPublishBurst,
  runReplay,
  runUnprecheckedSpend,
  type ScenarioDeps,
} from './scenarios.js';

/**
 * The Credit reference client (AC-03).
 *
 * ─── WHAT THIS PROVES ─────────────────────────────────────────────────────
 *
 * That the PUBLIC API is sufficient to run a governed fleet. It holds one
 * workspace API key and speaks only the four machine routes. It imports no
 * database package, knows no workspace id, and has no operator authority - a
 * guard test asserts each.
 *
 * If a Credit flow cannot be driven from here, the API is incomplete. That is
 * the point of shipping a reference client rather than a test harness with
 * privileged access.
 *
 *   run:   CONTROL_PLANE_URL=... CONTROL_PLANE_API_KEY=... pnpm simulator <scenario>
 *
 * See docs/simulator.md for the full Credit walkthrough.
 */

const SCENARIOS = [
  'stream',
  'baseline',
  'over-cap',
  'cap-raise-retry',
  'publish-burst',
  'pause-probe',
  'replay',
  'unprechecked-spend',
  'demo',
] as const;

type Scenario = (typeof SCENARIOS)[number];

function isScenario(value: string): value is Scenario {
  return (SCENARIOS as readonly string[]).includes(value);
}

const USAGE = `
Hybrid control plane - reference client

  CONTROL_PLANE_URL=https://api.example.test \\
  CONTROL_PLANE_API_KEY=hmp_live_... \\
  pnpm simulator <scenario> [flags]

Scenarios
  stream               continuous three-agent activity with policy polling
  baseline             one pass of three-agent activity          (AC-04/05/06)
  over-cap             agent-a attempts $41 against its cap      (AC-08)
  cap-raise-retry      retry under a NEW action id after a raise (AC-10)
  publish-burst        six publish attempts by agent-b           (AC-11)
  pause-probe          agent-a acts while paused                 (AC-12)
  replay               submit one batch twice, byte-identical    (AC-13)
  unprechecked-spend   report spend with no precheck             (Step 19)
  demo                 recurring public-demo activity + blocks   (AC-19)

Flags
  --api-url <url>        overrides CONTROL_PLANE_URL
  --poll-interval <ms>   policy poll cadence (default 30000)
  --tick-interval <ms>   stream activity cadence (default 5000)
  --timeout <ms>         per-request timeout (default 10000)
  --run-id <id>          pin the id namespace, for reproducible runs
  --cycles <n>           stream/demo only: stop after N cycles
  --block-interval <ms>  demo only: over-cap attempt cadence (default 180000)

Demo generator environment
  DEMO_GENERATOR_INTERVAL_MS   activity cadence (default 20000)
  DEMO_BLOCK_INTERVAL_MS       over-cap cadence (default 180000)

Recurring blocks require an operator to have set agent-a to budgeted with a
daily spend cap below $41, through the normal policy UI. The generator holds
machine authority only and cannot configure that itself.

The API key is read from the environment ONLY. There is no --api-key flag, so
it never reaches shell history or a process listing.

Policy is configured by an OPERATOR in the web app. This client polls policy,
asks precheck and reports events; it cannot set a cap, pause an agent, or
change anything the plane governs.
`.trimStart();

/** Exit codes, so a CI step can branch on the outcome. */
const EXIT_OK = 0;
const EXIT_USAGE = 2;
const EXIT_FAILED = 1;

/**
 * Polls policy on a cadence, tolerating the failures a long run will meet.
 *
 * A 304 is the steady state, not an error. A transient 503 or a dropped
 * connection is survivable: the client keeps its last known snapshot and tries
 * again. A 401 is NOT survivable - the credential is wrong or revoked, and
 * continuing would be a retry loop against a plane that will never answer.
 */
function startPolicyPolling(
  client: ReturnType<typeof createControlPlaneClient>,
  log: Logger,
  intervalMs: number,
  onFatal: (error: Error) => void,
): { stop: () => void } {
  let version: string | undefined;
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;

  const tick = async (): Promise<void> => {
    try {
      const result = await client.pollPolicy(version);
      if (result.status === 'unchanged') {
        log.info(`policy unchanged (version ${version ?? 'none'})`);
        return;
      }
      const previous = version;
      version = result.snapshot.version;
      if (previous === undefined) {
        log.ok(
          `policy v${version} for ${String(result.snapshot.agents.length)} agent(s)`,
        );
      } else if (previous !== version) {
        // An operator changed something. The client does not interpret what -
        // it simply carries the new version into the next poll.
        log.ok(`policy CHANGED: v${previous} -> v${version}`);
      }
    } catch (caught: unknown) {
      if (caught instanceof ControlPlaneError && caught.status === 401) {
        onFatal(caught);
        return;
      }
      // Survivable: keep the last known version and try again next tick.
      log.warn(
        caught instanceof Error ? caught.message : 'policy poll failed for an unknown reason',
      );
    }
  };

  const schedule = (): void => {
    if (stopped) {
      return;
    }
    timer = setTimeout(() => {
      void tick().finally(schedule);
    }, intervalMs);
    // Do not hold the event loop open on this timer alone.
    timer.unref?.();
  };

  void tick().finally(schedule);

  return {
    stop: () => {
      stopped = true;
      if (timer !== undefined) {
        clearTimeout(timer);
      }
    },
  };
}

/** Continuous activity until stopped, or until `--cycles` is reached. */
async function runStream(
  deps: ScenarioDeps,
  config: SimulatorConfig,
  maxCycles: number | undefined,
  signal: AbortSignal,
): Promise<void> {
  const { log } = deps;
  let cycle = 0;

  while (!signal.aborted && (maxCycles === undefined || cycle < maxCycles)) {
    await runBaseline(deps, cycle);
    cycle += 1;

    if (signal.aborted || (maxCycles !== undefined && cycle >= maxCycles)) {
      break;
    }
    // Shared with the demo generator. NOT unref'd - see sleep.ts.
    await sleep(config.tickIntervalMs, signal);
  }

  log.info(`Stream finished after ${String(cycle)} cycle(s).`);
}

export async function main(argv: readonly string[], env: NodeJS.ProcessEnv): Promise<number> {
  const log = createLogger();
  const { command, flags } = parseArgs(argv);

  if (flags['help'] !== undefined || command === 'help') {
    log.info(USAGE);
    return EXIT_OK;
  }

  const scenario = command ?? 'baseline';
  if (!isScenario(scenario)) {
    log.error(`Unknown scenario "${scenario}".`);
    log.info(USAGE);
    return EXIT_USAGE;
  }

  let config: SimulatorConfig;
  try {
    config = resolveConfig({ env, flags });
  } catch (caught: unknown) {
    if (caught instanceof ConfigError) {
      log.error(caught.message);
      return EXIT_USAGE;
    }
    throw caught;
  }

  const client = createControlPlaneClient({
    baseUrl: config.baseUrl,
    apiKey: config.apiKey,
    timeoutMs: config.timeoutMs,
  });
  const ids = createIdFactory(config.runId);
  const runtime = createRuntime({ client, ids, log });
  const deps: ScenarioDeps = { client, runtime, ids, log };

  // The URL is safe to print; the key never is.
  log.info(`control plane: ${config.baseUrl}`);
  log.info(`run id: ${ids.runId}`);

  const controller = new AbortController();
  const onSignal = (): void => {
    log.info('Shutting down.');
    controller.abort();
  };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);

  let polling: { stop: () => void } | undefined;

  try {
    await registerFleet(deps);

    if (scenario === 'demo') {
      let fatal: Error | undefined;
      polling = startPolicyPolling(client, log, config.pollIntervalMs, (error) => {
        fatal = error;
        controller.abort();
      });

      const rawCycles = flags['cycles'];
      const maxCycles =
        rawCycles === undefined || !/^[0-9]{1,6}$/.test(rawCycles)
          ? undefined
          : Number.parseInt(rawCycles, 10);

      await runDemoGenerator({
        deps,
        activityIntervalMs: readIntervalMs(
          flags['tick-interval'] ?? env['DEMO_GENERATOR_INTERVAL_MS'],
          DEFAULT_ACTIVITY_INTERVAL_MS,
          MIN_ACTIVITY_INTERVAL_MS,
        ),
        blockIntervalMs: readIntervalMs(
          flags['block-interval'] ?? env['DEMO_BLOCK_INTERVAL_MS'],
          DEFAULT_BLOCK_INTERVAL_MS,
          MIN_BLOCK_INTERVAL_MS,
        ),
        signal: controller.signal,
        maxCycles,
      });

      // A rejected credential is fatal: retrying forever against a key the
      // plane will never accept is noise, not resilience.
      if (fatal !== undefined) {
        throw fatal;
      }
      return EXIT_OK;
    }

    if (scenario === 'stream') {
      let fatal: Error | undefined;
      polling = startPolicyPolling(client, log, config.pollIntervalMs, (error) => {
        fatal = error;
        controller.abort();
      });

      const rawCycles = flags['cycles'];
      const maxCycles =
        rawCycles === undefined || !/^[0-9]{1,6}$/.test(rawCycles)
          ? undefined
          : Number.parseInt(rawCycles, 10);

      await runStream(deps, config, maxCycles, controller.signal);
      if (fatal !== undefined) {
        throw fatal;
      }
      return EXIT_OK;
    }

    // One-shot scenarios: a single policy read, so the run logs the version it
    // observed. It does not act on it - the plane decides at precheck time.
    const snapshot = await client.pollPolicy();
    if (snapshot.status === 'snapshot') {
      log.info(`policy v${snapshot.snapshot.version} observed`);
    }

    switch (scenario) {
      case 'baseline':
        await runBaseline(deps);
        break;
      case 'over-cap':
        await runOverCap(deps);
        break;
      case 'cap-raise-retry':
        await runCapRaiseRetry(deps);
        break;
      case 'publish-burst':
        await runPublishBurst(deps);
        break;
      case 'pause-probe':
        await runPauseProbe(deps);
        break;
      case 'replay':
        await runReplay(deps);
        break;
      case 'unprechecked-spend':
        await runUnprecheckedSpend(deps);
        break;
    }

    return EXIT_OK;
  } catch (caught: unknown) {
    if (caught instanceof ControlPlaneError || caught instanceof TransportError) {
      log.error(caught.message);
      return EXIT_FAILED;
    }
    log.error(caught instanceof Error ? caught.message : 'the run failed for an unknown reason');
    return EXIT_FAILED;
  } finally {
    polling?.stop();
    process.removeListener('SIGINT', onSignal);
    process.removeListener('SIGTERM', onSignal);
  }
}

/** Entry point. Skipped when the module is imported by a test. */
if (process.argv[1] !== undefined && process.argv[1].includes('simulator')) {
  void main(process.argv.slice(2), process.env).then((code) => {
    process.exitCode = code;
  });
}
