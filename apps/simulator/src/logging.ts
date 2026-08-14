/**
 * CLI output for the reference client.
 *
 * ─── WHAT MAY NEVER BE PRINTED ────────────────────────────────────────────
 *
 * The simulator holds exactly one secret: the workspace API key. It is passed
 * to `fetch` as an `Authorization` header and must never appear anywhere else
 * - not in a request summary, not in an error, not in a debug dump.
 *
 * That is easy to get right by accident and easy to break by accident: one
 * `console.log(options)` or a thrown error carrying the request init would put
 * a live credential into a terminal, a CI log, or a support ticket.
 *
 * So this module is the ONLY writer to stdout, and `redact` is applied to
 * every line. A guard test asserts no other file in `src/` calls `console`
 * directly, and another feeds a real key through every log function and
 * asserts it never appears in the output.
 *
 * Redaction is a SECOND line of defence, not the first. The first is that the
 * key is never passed to a log function at all.
 */

/** Values that must never reach a terminal, matched defensively. */
const SECRET_PATTERNS: readonly RegExp[] = [
  // Workspace API keys: the `hmp_live_` prefix plus its secret tail.
  /hmp_live_[A-Za-z0-9_-]+/g,
  // An Authorization header in any casing, however it was stringified.
  /(authorization"?\s*[:=]\s*"?)([^",}\s]+)/gi,
  /(bearer\s+)(\S+)/gi,
  // Connection strings, in case a misconfigured URL is echoed back.
  /postgres(?:ql)?:\/\/\S+/gi,
  // Session cookies, which the simulator never holds but must never print.
  /(hybrid_session=)([^;\s]+)/gi,
];

/**
 * Removes anything secret-shaped from a line.
 *
 * Deliberately pattern-based rather than "remove the configured key": a key
 * that arrived from somewhere unexpected must be caught too.
 */
export function redact(line: string): string {
  let safe = line;
  for (const pattern of SECRET_PATTERNS) {
    safe = safe.replace(pattern, (_match: string, prefix?: string) =>
      typeof prefix === 'string' ? `${prefix}[redacted]` : '[redacted]',
    );
  }
  return safe;
}

/** Where output goes. Swapped in tests so logging itself is assertable. */
export interface Sink {
  (line: string): void;
}

/* eslint-disable no-console -- this module IS the CLI's stdout boundary. */
const defaultOut: Sink = (line) => {
  console.log(line);
};
const defaultErr: Sink = (line) => {
  console.error(line);
};
/* eslint-enable no-console */

export interface Logger {
  info(message: string): void;
  step(message: string): void;
  ok(message: string): void;
  deny(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

export function createLogger(out: Sink = defaultOut, err: Sink = defaultErr): Logger {
  const write = (sink: Sink, prefix: string, message: string): void => {
    sink(redact(`${prefix} ${message}`));
  };

  return {
    info: (message) => {
      write(out, '  ', message);
    },
    step: (message) => {
      write(out, '▶ ', message);
    },
    ok: (message) => {
      write(out, '✓ ', message);
    },
    // A plane denial is a CORRECT outcome, not a failure. Marked distinctly so
    // a reader does not mistake governance working for the client breaking.
    deny: (message) => {
      write(out, '⊘ ', message);
    },
    warn: (message) => {
      write(err, '! ', message);
    },
    error: (message) => {
      write(err, '✗ ', message);
    },
  };
}
