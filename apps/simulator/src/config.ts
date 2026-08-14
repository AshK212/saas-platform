/**
 * Reference-client configuration.
 *
 * ─── THE KEY COMES FROM THE ENVIRONMENT ───────────────────────────────────
 *
 * `CONTROL_PLANE_API_KEY`, and there is deliberately NO `--api-key` flag.
 *
 * A flag would put a live workspace credential into shell history, into `ps`
 * output for every user on the machine, and into any CI log that echoes its
 * command line. None of those are recoverable after the fact; an environment
 * variable is at least scoped to the process.
 *
 * There is also NO DEFAULT. A synthetic production-looking fallback would let
 * the client "work" while pointing somewhere unintended, and would be the kind
 * of value that eventually gets committed.
 */

export interface SimulatorConfig {
  readonly baseUrl: string;
  readonly apiKey: string;
  /** Policy poll cadence. ~30s in normal use; lowered for acceptance runs. */
  readonly pollIntervalMs: number;
  /** Activity cadence for the continuous stream. */
  readonly tickIntervalMs: number;
  readonly timeoutMs: number;
  /** Pinned so a test can predict every generated id. */
  readonly runId: string | undefined;
}

export class ConfigError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

/** Locked polling cadence from the policy contract. */
export const DEFAULT_POLL_INTERVAL_MS = 30_000;
const DEFAULT_TICK_INTERVAL_MS = 5_000;
const DEFAULT_TIMEOUT_MS = 10_000;

/** Bounds, so a typo cannot become a denial-of-service against the plane. */
const MIN_INTERVAL_MS = 100;
const MAX_INTERVAL_MS = 600_000;

function readInterval(
  raw: string | undefined,
  fallback: number,
  label: string,
): number {
  if (raw === undefined || raw === '') {
    return fallback;
  }
  if (!/^[0-9]{1,7}$/.test(raw)) {
    throw new ConfigError(`${label} must be a whole number of milliseconds.`);
  }
  const value = Number.parseInt(raw, 10);
  if (value < MIN_INTERVAL_MS || value > MAX_INTERVAL_MS) {
    throw new ConfigError(
      `${label} must be between ${String(MIN_INTERVAL_MS)} and ${String(MAX_INTERVAL_MS)} ms.`,
    );
  }
  return value;
}

export interface RawInput {
  readonly env: Readonly<Partial<Record<string, string>>>;
  /** Parsed `--flag value` pairs. Never carries a credential. */
  readonly flags: Readonly<Record<string, string>>;
}

/**
 * Resolves configuration, failing loudly rather than guessing.
 *
 * The URL may come from a flag - it is not a secret and being able to point a
 * run at staging without editing the environment is genuinely useful. The key
 * may not.
 */
export function resolveConfig(input: RawInput): SimulatorConfig {
  const baseUrl = input.flags['api-url'] ?? input.env['CONTROL_PLANE_URL'] ?? '';
  if (baseUrl === '') {
    throw new ConfigError(
      'Set CONTROL_PLANE_URL (or pass --api-url) to the control-plane base URL.',
    );
  }
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new ConfigError('CONTROL_PLANE_URL must be an absolute http(s) URL.');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new ConfigError('CONTROL_PLANE_URL must be an absolute http(s) URL.');
  }

  const apiKey = input.env['CONTROL_PLANE_API_KEY'] ?? '';
  if (apiKey === '') {
    throw new ConfigError(
      'Set CONTROL_PLANE_API_KEY in the environment. There is no flag for it, ' +
        'so the key never reaches shell history or process listings.',
    );
  }

  return {
    baseUrl,
    apiKey,
    pollIntervalMs: readInterval(
      input.flags['poll-interval'] ?? input.env['SIMULATOR_POLL_INTERVAL_MS'],
      DEFAULT_POLL_INTERVAL_MS,
      'poll interval',
    ),
    tickIntervalMs: readInterval(
      input.flags['tick-interval'] ?? input.env['SIMULATOR_TICK_INTERVAL_MS'],
      DEFAULT_TICK_INTERVAL_MS,
      'tick interval',
    ),
    timeoutMs: readInterval(input.flags['timeout'], DEFAULT_TIMEOUT_MS, 'timeout'),
    runId: input.flags['run-id'],
  };
}

/**
 * Parses `--flag value` and `--flag=value`.
 *
 * Bare `--flag` becomes `"true"`. Anything before the first flag is the
 * scenario name and is returned separately.
 */
export function parseArgs(argv: readonly string[]): {
  readonly command: string | undefined;
  readonly flags: Record<string, string>;
} {
  const flags: Record<string, string> = {};
  let command: string | undefined;
  let index = 0;

  if (argv[0] !== undefined && !argv[0].startsWith('-')) {
    command = argv[0];
    index = 1;
  }

  for (; index < argv.length; index += 1) {
    const token = argv[index] ?? '';
    if (!token.startsWith('--')) {
      continue;
    }
    const body = token.slice(2);
    const equals = body.indexOf('=');
    if (equals >= 0) {
      flags[body.slice(0, equals)] = body.slice(equals + 1);
      continue;
    }
    const next = argv[index + 1];
    if (next !== undefined && !next.startsWith('-')) {
      flags[body] = next;
      index += 1;
    } else {
      flags[body] = 'true';
    }
  }

  return { command, flags };
}
