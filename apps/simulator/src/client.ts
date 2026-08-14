import {
  AGENT_REGISTER_PATH,
  EVENT_INGEST_PATH,
  POLICY_POLL_PATH,
  POLICY_SINCE_VERSION_PARAM,
  PRECHECK_PATH,
  eventIngestResponseSchema,
  policySnapshotSchema,
  precheckResponseSchema,
  registerAgentResponseSchema,
  type EventIngestResponse,
  type IngestEvent,
  type PolicySnapshot,
  type PrecheckRequest,
  type PrecheckResponse,
  type RegisterAgentResponse,
} from '@hybrid/contracts';

/**
 * The control-plane HTTP boundary.
 *
 * ─── FOUR CALLS, AND NOTHING ELSE ─────────────────────────────────────────
 *
 * A runtime needs exactly four things from the plane: to announce itself, to
 * learn current policy, to ask permission, and to report what happened. This
 * interface is that list, and the narrowness is the point - it is the surface
 * a real runtime (Hermes, OpenClaw, anything) would implement, so keeping it
 * small keeps the integration contract small.
 *
 * There is deliberately NO method for reading the timeline, listing receipts,
 * mutating policy, or resolving a workspace. Those are operator surfaces; a
 * machine credential is refused on them by the server, and offering a method
 * that always 401s would misrepresent the contract.
 *
 * ─── THE WORKSPACE IS NOT A PARAMETER ─────────────────────────────────────
 *
 * No method takes a workspace id, because the client does not know one. The
 * server derives tenancy from the API credential. A client that could name its
 * own workspace would be a client that could be wrong about it.
 *
 * ─── THE KEY LIVES IN EXACTLY ONE PLACE ───────────────────────────────────
 *
 * `authHeader` below. It is never returned, never attached to an error, and
 * never logged. `ControlPlaneError` carries a status and a short reason and
 * deliberately does NOT carry the request init, because a thrown object that
 * holds headers is a credential one `console.error` away from a terminal.
 */

/** A failed call, in a shape that is safe to print. */
export class ControlPlaneError extends Error {
  public constructor(
    public readonly status: number,
    public readonly path: string,
    message: string,
  ) {
    // No headers, no body echo, no request init - see the note above.
    super(`${path} failed with ${String(status)}: ${message}`);
    this.name = 'ControlPlaneError';
  }
}

/** The transport could not complete. Whether the server acted is UNKNOWN. */
export class TransportError extends Error {
  public constructor(
    public readonly path: string,
    reason: string,
  ) {
    super(`${path} did not complete: ${reason}`);
    this.name = 'TransportError';
  }
}

/** A policy poll outcome. `unchanged` is the 304 case, not an error. */
export type PolicyPollResult =
  | { readonly status: 'snapshot'; readonly snapshot: PolicySnapshot }
  | { readonly status: 'unchanged' };

export interface ControlPlaneClient {
  registerAgent(externalId: string, name?: string): Promise<RegisterAgentResponse>;
  /** @param sinceVersion - omit for a full snapshot; supply to get 304 when unchanged. */
  pollPolicy(sinceVersion?: string): Promise<PolicyPollResult>;
  precheck(request: PrecheckRequest): Promise<PrecheckResponse>;
  ingestEvents(events: readonly IngestEvent[]): Promise<EventIngestResponse>;
}

export interface ClientOptions {
  readonly baseUrl: string;
  readonly apiKey: string;
  /** Per-attempt timeout. An unbounded request can hang a CLI forever. */
  readonly timeoutMs?: number;
  /**
   * Extra attempts for a request whose outcome is UNKNOWN.
   *
   * Retries reuse the caller's `action_id` / `event_id` unchanged - the
   * identity is the caller's, and this layer never invents a new one. That is
   * what lets server-side idempotency make a retry safe.
   */
  readonly maxRetries?: number;
  /** Injected so tests do not sleep. */
  readonly sleep?: (ms: number) => Promise<void>;
  /** Injected so tests do not need a socket. */
  readonly fetchImpl?: typeof fetch;
}

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_RETRIES = 2;
const RETRY_BASE_DELAY_MS = 200;

/** 5xx and 429 are worth another attempt; a 4xx is a decision, not a blip. */
function isRetryableStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

export function createControlPlaneClient(options: ClientOptions): ControlPlaneClient {
  const baseUrl = options.baseUrl.replace(/\/+$/, '');
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
  const doFetch = options.fetchImpl ?? fetch;
  const sleep =
    options.sleep ??
    ((ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms)));

  /** THE ONLY PLACE THE API KEY IS READ. */
  const authHeader = (): Record<string, string> => ({
    authorization: `Bearer ${options.apiKey}`,
  });

  /**
   * One request, with a bounded retry for UNCERTAIN outcomes only.
   *
   * The body is built ONCE by the caller and replayed byte-identically, so a
   * retry carries the same `action_id` / `event_id` and the server's
   * idempotency decides the outcome. Rebuilding the body per attempt is how a
   * retry silently becomes a second action.
   */
  async function send(
    path: string,
    init: { method: 'GET' | 'POST'; body?: string },
  ): Promise<Response> {
    let lastError: Error | undefined;

    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      if (attempt > 0) {
        await sleep(RETRY_BASE_DELAY_MS * attempt);
      }

      let response: Response;
      try {
        response = await doFetch(`${baseUrl}${path}`, {
          method: init.method,
          headers: {
            ...authHeader(),
            ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
          },
          ...(init.body === undefined ? {} : { body: init.body }),
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (caught: unknown) {
        // Timeout, DNS, connection reset. The server MAY have acted, so the
        // retry must reuse the same identity - which it does, because `init`
        // is unchanged.
        lastError = new TransportError(
          path,
          caught instanceof Error ? caught.name : 'unknown transport failure',
        );
        continue;
      }

      if (isRetryableStatus(response.status) && attempt < maxRetries) {
        lastError = new ControlPlaneError(response.status, path, 'server unavailable');
        continue;
      }
      return response;
    }

    throw lastError ?? new TransportError(path, 'exhausted retries');
  }

  /** Parses a response against its contract, so drift fails loudly here. */
  async function parse<T>(
    response: Response,
    path: string,
    schema: { safeParse: (value: unknown) => { success: boolean; data?: T } },
  ): Promise<T> {
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new ControlPlaneError(response.status, path, 'response was not JSON');
    }

    const parsed = schema.safeParse(body);
    if (!parsed.success || parsed.data === undefined) {
      // The shared contract is the arbiter. A body that does not match it is a
      // contract violation, not something to guess at.
      throw new ControlPlaneError(response.status, path, 'response did not match the contract');
    }
    return parsed.data;
  }

  /** Maps a non-2xx into a printable error, without echoing the body. */
  function failure(response: Response, path: string): ControlPlaneError {
    switch (response.status) {
      case 401:
        return new ControlPlaneError(401, path, 'the API key was rejected');
      case 403:
        return new ControlPlaneError(403, path, 'forbidden');
      case 404:
        return new ControlPlaneError(404, path, 'not found');
      case 400:
        return new ControlPlaneError(400, path, 'the request was rejected as invalid');
      case 503:
        return new ControlPlaneError(503, path, 'the control plane is unavailable');
      default:
        return new ControlPlaneError(response.status, path, 'unexpected status');
    }
  }

  return {
    async registerAgent(externalId: string, name?: string): Promise<RegisterAgentResponse> {
      const response = await send(AGENT_REGISTER_PATH, {
        method: 'POST',
        // Registration is idempotent on (workspace, external id), so a retry
        // is safe without any extra identity.
        body: JSON.stringify({ agent_id: externalId, ...(name === undefined ? {} : { name }) }),
      });

      if (!response.ok) {
        throw failure(response, AGENT_REGISTER_PATH);
      }
      return parse(response, AGENT_REGISTER_PATH, registerAgentResponseSchema);
    },

    async pollPolicy(sinceVersion?: string): Promise<PolicyPollResult> {
      const query =
        sinceVersion === undefined
          ? ''
          : `?${POLICY_SINCE_VERSION_PARAM}=${encodeURIComponent(sinceVersion)}`;
      const response = await send(`${POLICY_POLL_PATH}${query}`, { method: 'GET' });

      // 304 is the DESIGNED steady state, not a failure: nothing changed since
      // the version this client already holds.
      if (response.status === 304) {
        return { status: 'unchanged' };
      }
      if (!response.ok) {
        throw failure(response, POLICY_POLL_PATH);
      }
      return {
        status: 'snapshot',
        snapshot: await parse(response, POLICY_POLL_PATH, policySnapshotSchema),
      };
    },

    async precheck(request: PrecheckRequest): Promise<PrecheckResponse> {
      // Serialised ONCE. Every retry replays these exact bytes, so the
      // `action_id` is identical and the plane's idempotency applies.
      const body = JSON.stringify(request);
      const response = await send(PRECHECK_PATH, { method: 'POST', body });

      if (!response.ok) {
        throw failure(response, PRECHECK_PATH);
      }
      // A DENIAL IS A 200. The plane answered; the request succeeded. Treating
      // it as an error would invite generic retry logic against a paused agent.
      return parse(response, PRECHECK_PATH, precheckResponseSchema);
    },

    async ingestEvents(events: readonly IngestEvent[]): Promise<EventIngestResponse> {
      const body = JSON.stringify({ events });
      const response = await send(EVENT_INGEST_PATH, { method: 'POST', body });

      if (!response.ok) {
        throw failure(response, EVENT_INGEST_PATH);
      }
      return parse(response, EVENT_INGEST_PATH, eventIngestResponseSchema);
    },
  };
}
