import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import {
  AGENT_REGISTER_PATH,
  EVENT_INGEST_PATH,
  POLICY_POLL_PATH,
  PRECHECK_PATH,
  eventIngestRequestSchema,
  precheckRequestSchema,
  registerAgentRequestSchema,
  type PolicySnapshot,
  type PrecheckDecision,
  type PrecheckDenyReason,
} from '@hybrid/contracts';

/**
 * A REAL HTTP server standing in for the control plane.
 *
 * ─── WHY A SOCKET AND NOT A MOCKED `fetch` ────────────────────────────────
 *
 * The reference client's job is to prove the PUBLIC API is sufficient, so its
 * tests have to exercise it as an HTTP client. A stubbed `fetch` would let a
 * client that sends malformed JSON, forgets a header, or mishandles a 304 pass
 * every test - which is precisely the class of defect this app exists to catch
 * before a real runtime hits it.
 *
 * So this listens on a real port, parses real bodies with the SHARED
 * CONTRACTS, and returns real status codes.
 *
 * ─── IT IS NOT A SECOND CONTROL PLANE ─────────────────────────────────────
 *
 * It records what it received and returns what the test told it to return. It
 * enforces no policy, keeps no ledger, and makes no decision of its own - a
 * fake that decided things would drift from the real plane and start proving
 * its own behaviour instead of the client's.
 *
 * The one exception is EVENT IDEMPOTENCY, which it reproduces faithfully
 * (dedupe on `event_id`) because AC-13 is about the client resending identical
 * ids, and a fake that accepted everything could not show the difference.
 */

export interface RecordedRequest {
  readonly method: string;
  readonly path: string;
  readonly authorization: string | undefined;
  readonly body: unknown;
}

/** What the fake should answer for the next precheck. */
export interface PrecheckScript {
  readonly decision: PrecheckDecision;
  readonly reason?: PrecheckDenyReason;
}

export interface FakeControlPlane {
  readonly url: string;
  /** Every request received, in order, including replays. */
  readonly requests: RecordedRequest[];
  /** Distinct `event_id`s the fake has stored. */
  readonly storedEventIds: Set<string>;
  /** Registered external agent ids, deduplicated as the real plane does. */
  readonly registeredAgents: Set<string>;
  /** Queue of precheck answers; the last one repeats once exhausted. */
  scriptPrecheck(...script: PrecheckScript[]): void;
  /** Snapshot returned by `GET /v1/policy`. */
  setPolicy(snapshot: PolicySnapshot): void;
  /** Answer 304 for polls carrying this version. */
  setUnchangedFor(version: string): void;
  /** Force the next N responses to a status, to exercise retry. */
  failNext(count: number, status: number): void;
  /** Requests to a given path, for assertions. */
  requestsTo(path: string): RecordedRequest[];
  close(): Promise<void>;
}

const UUID_NAMESPACE = '00000000-0000-4000-8000-';

/** Deterministic uuids, so assertions can name them. */
function fakeUuid(index: number): string {
  return `${UUID_NAMESPACE}${String(index).padStart(12, '0')}`;
}

export async function startFakeControlPlane(): Promise<FakeControlPlane> {
  const requests: RecordedRequest[] = [];
  const storedEventIds = new Set<string>();
  const registeredAgents = new Set<string>();
  const precheckScript: PrecheckScript[] = [];
  let policy: PolicySnapshot = { version: '1', agents: [] };
  let unchangedFor: string | undefined;
  let failures = 0;
  let failureStatus = 503;
  let precheckCounter = 0;

  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      let body: unknown;
      try {
        body = raw === '' ? undefined : JSON.parse(raw);
      } catch {
        body = raw;
      }

      const url = new URL(req.url ?? '/', 'http://localhost');
      requests.push({
        method: req.method ?? 'GET',
        path: url.pathname,
        authorization: req.headers.authorization,
        body,
      });

      const json = (status: number, payload: unknown): void => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(payload));
      };

      // Forced failure, for retry tests. Consumed one response at a time.
      if (failures > 0) {
        failures -= 1;
        json(failureStatus, { error: 'unavailable' });
        return;
      }

      // Machine routes require a bearer credential, as the real plane does.
      if (req.headers.authorization === undefined) {
        json(401, { error: 'unauthorized' });
        return;
      }

      if (url.pathname === AGENT_REGISTER_PATH && req.method === 'POST') {
        const parsed = registerAgentRequestSchema.safeParse(body);
        if (!parsed.success) {
          json(400, { error: 'invalid_request' });
          return;
        }
        registeredAgents.add(parsed.data.agent_id);
        json(200, {
          agent: {
            agent_id: parsed.data.agent_id,
            name: parsed.data.name ?? null,
            last_seen_at: '2026-08-14T10:00:00.000Z',
          },
        });
        return;
      }

      if (url.pathname === POLICY_POLL_PATH && req.method === 'GET') {
        const since = url.searchParams.get('since_version');
        if (since !== null && since === unchangedFor) {
          res.writeHead(304);
          res.end();
          return;
        }
        json(200, policy);
        return;
      }

      if (url.pathname === PRECHECK_PATH && req.method === 'POST') {
        const parsed = precheckRequestSchema.safeParse(body);
        if (!parsed.success) {
          json(400, { error: 'invalid_request' });
          return;
        }
        precheckCounter += 1;
        const next =
          precheckScript.length === 0
            ? { decision: 'allow' as const }
            : (precheckScript.shift() ??
              precheckScript[precheckScript.length - 1] ?? { decision: 'allow' as const });
        // Once the script runs out the last answer repeats, so a burst test
        // does not have to enumerate every attempt.
        if (precheckScript.length === 0) {
          precheckScript.push(next);
        }

        json(200, {
          precheck_id: fakeUuid(precheckCounter),
          decision: next.decision,
          remaining: null,
          ...(next.decision === 'deny'
            ? { reason: next.reason ?? 'daily_spend_cap_exceeded' }
            : {}),
        });
        return;
      }

      if (url.pathname === EVENT_INGEST_PATH && req.method === 'POST') {
        const parsed = eventIngestRequestSchema.safeParse(body);
        if (!parsed.success) {
          json(400, { error: 'invalid_batch', issues: [] });
          return;
        }
        // Real idempotency: dedupe on event_id, as AC-13 requires.
        let accepted = 0;
        let duplicates = 0;
        for (const event of parsed.data.events) {
          if (storedEventIds.has(event.event_id)) {
            duplicates += 1;
            continue;
          }
          storedEventIds.add(event.event_id);
          accepted += 1;
        }
        json(200, { accepted, duplicates });
        return;
      }

      json(404, { error: 'not_found' });
    });
  });

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${String(address.port)}`,
    requests,
    storedEventIds,
    registeredAgents,
    scriptPrecheck: (...script) => {
      precheckScript.length = 0;
      precheckScript.push(...script);
    },
    setPolicy: (snapshot) => {
      policy = snapshot;
    },
    setUnchangedFor: (version) => {
      unchangedFor = version;
    },
    failNext: (count, status) => {
      failures = count;
      failureStatus = status;
    },
    requestsTo: (path) => requests.filter((r) => r.path === path),
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      }),
  };
}
