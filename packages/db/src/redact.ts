/**
 * Credential redaction helpers.
 *
 * Every diagnostic string that could plausibly have touched a connection string
 * passes through here before it is logged. Nothing in this module ever returns
 * a username or password.
 */

/** Matches the userinfo section of a Postgres URL, e.g. `postgresql://user:pw@`. */
const CREDENTIALED_POSTGRES_URL = /\b(postgres(?:ql)?:\/\/)[^\s@/]*@/gi;

/**
 * Replaces credentials in any Postgres URL found inside arbitrary text.
 *
 * Driver errors, stack traces and third-party messages can embed a connection
 * string. This scrubs them before they reach a log sink.
 */
export function redactConnectionStrings(text: string): string {
  return text.replace(CREDENTIALED_POSTGRES_URL, '$1***:***@');
}

/**
 * Describes *where* a connection points, with no credentials, for operator
 * diagnostics: `host:port/database`.
 *
 * Returns a fixed placeholder rather than throwing, and never echoes the input,
 * so a malformed value can never leak through an error path.
 */
export function describeConnectionTarget(connectionString: string): string {
  let url: URL;
  try {
    url = new URL(connectionString);
  } catch {
    return '(unparseable connection string)';
  }

  const host = url.hostname === '' ? '(no host)' : url.hostname;
  const port = url.port === '' ? '5432' : url.port;
  const database = url.pathname.replace(/^\//, '');

  return `${host}:${port}/${database === '' ? '(no database)' : database}`;
}
