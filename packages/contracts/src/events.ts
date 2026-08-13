import { z } from 'zod';

/**
 * Step 9 event ingest contracts for `POST /v1/events`.
 *
 * CONTRACT DEFINED IN STEP 9. PERSISTENCE / INGEST IMPLEMENTED IN STEP 10.
 * Nothing here reads or writes a database, and no route is mounted.
 *
 * ─── THE THREE THINGS THIS FILE REFUSES TO EXPRESS ────────────────────────
 *
 * 1. TENANT AUTHORITY. There is no `workspace_id`, `tenant_id` or any variant,
 *    anywhere. The workspace comes from the API credential
 *    (`Authorization: Bearer` -> credential row -> `workspace_id`). Every
 *    object below is a STRICT object, so sending one is a hard validation
 *    error rather than a silently-stripped field.
 *
 * 2. POLICY. No mode, cap, pause, or policy-version field. Events describe what
 *    happened; they never change what is permitted.
 *
 * 3. CREDENTIALS. No API key, token or authorization value. Authentication
 *    lives in HTTP headers, outside the body.
 *
 * ─── WHY STRICT OBJECTS ───────────────────────────────────────────────────
 *
 * The default Zod behaviour strips unknown keys. For a governance event stream
 * that is dangerous: `{"amout_usd": "41.00"}` would silently become a spend
 * event with no amount, and the ledger would under-count. Rejecting unknown
 * top-level keys turns a typo into a loud 400. Runtime-specific extensibility
 * has a dedicated home - the `payload` field.
 */

export const EVENT_INGEST_PATH = '/v1/events' as const;

// ─── Vocabularies ───────────────────────────────────────────────────────────

/**
 * Baseline event types.
 *
 * Identical to the PostgreSQL `event_type` enum created in Step 3
 * (`agent.action`, `spend.recorded`, `action.blocked`, `heartbeat`). Verified
 * against the migrated SQL - the two must never diverge.
 */
export const eventTypeSchema = z.enum([
  'agent.action',
  'spend.recorded',
  'action.blocked',
  'heartbeat',
]);
export type EventType = z.infer<typeof eventTypeSchema>;

/**
 * Governed action categories.
 *
 * Identical to the PostgreSQL `action_category` enum. Note this is a CATEGORY
 * of governed action, not a provider - see `provider` below. Conflating the two
 * would let a vendor name influence governance routing.
 */
export const actionCategorySchema = z.enum([
  'llm_call',
  'tool_call',
  'spend',
  'publish',
  'other',
]);
export type ActionCategory = z.infer<typeof actionCategorySchema>;

// ─── Bounds ─────────────────────────────────────────────────────────────────

/**
 * Maximum events per request.
 *
 * 100 keeps a single request's validation and (later) transaction bounded,
 * while being generous for a batching agent. An unbounded array would let one
 * request pin a worker and hold a transaction open indefinitely.
 *
 * NOTE: this bounds the array LENGTH only. Total body size cannot be enforced
 * by Zod and must be limited at the HTTP layer in Step 10.
 */
export const MAX_EVENTS_PER_BATCH = 100;

const MAX_EVENT_ID_LENGTH = 200;
const MAX_AGENT_ID_LENGTH = 120;
const MAX_PROVIDER_LENGTH = 120;
const MAX_RULE_LENGTH = 120;
const MAX_REASON_LENGTH = 500;
const MAX_BLOCK_ID_LENGTH = 200;
/** Well inside PostgreSQL `integer`, which `blocks.count` uses. */
const MAX_COUNT = 1_000_000;

// ─── Money ──────────────────────────────────────────────────────────────────

/**
 * Exact decimal USD, as a STRING.
 *
 * WHY A STRING AND NOT A JSON NUMBER
 * ----------------------------------
 * JSON numbers are IEEE-754 doubles in every mainstream parser. `0.1 + 0.2`
 * famously is not `0.3`, and a value like `41.00` can arrive as `41.000000001`.
 * For a spend ledger that decides whether a $25 cap is exceeded, that is not
 * acceptable at any level of unlikeliness. A string crosses the wire exactly as
 * written and converts to PostgreSQL `numeric(14,6)` losslessly.
 *
 * SHAPE - matched to `numeric(14, 6)`
 * -----------------------------------
 *   - up to 8 integer digits (14 precision - 6 scale), max 99999999.999999
 *   - up to 6 fractional digits
 *   - no sign: spend is non-negative. `-5` is rejected, not absolute-valued.
 *   - no exponent: `4.1e1` is rejected rather than silently meaning 41
 *   - no leading zeros (`01.5`), no bare `.5`, no trailing `1.`
 *
 * A seventh decimal such as `0.0000009` is REJECTED, not rounded. Rounding an
 * authoritative amount without telling anyone is exactly the class of silent
 * loss this contract exists to prevent.
 */
const DECIMAL_USD_PATTERN = /^(?:0|[1-9]\d{0,7})(?:\.\d{1,6})?$/;

export const decimalUsdSchema = z
  .string()
  .min(1)
  .max(16)
  .regex(
    DECIMAL_USD_PATTERN,
    'Must be a non-negative decimal string with at most 8 integer and 6 fractional digits (e.g. "1.250000").',
  );

export type DecimalUsd = z.infer<typeof decimalUsdSchema>;

// ─── Shared envelope ────────────────────────────────────────────────────────

/**
 * Client-supplied event identifier.
 *
 * Deliberately an opaque bounded string, NOT a UUID: agent and plugin
 * ecosystems generate perfectly good identifiers in other formats (ULID,
 * KSUID, `evt_` prefixed), and forcing UUID would reject them for no safety
 * gain. Uniqueness is enforced per workspace by the database, not by format.
 */
const eventIdSchema = z.string().trim().min(1).max(MAX_EVENT_ID_LENGTH);

/**
 * Stable external agent identifier - the same value Step 8 registration uses.
 *
 * This is `agents.external_id`, NOT the internal UUID. Internal ids are never
 * part of the machine-facing contract; they would leak database identity and
 * force agents to perform a lookup they should not need.
 */
const agentIdSchema = z.string().trim().min(1).max(MAX_AGENT_ID_LENGTH);

/**
 * Client-reported time of the event. OPTIONAL and UNTRUSTED.
 *
 *   occurred_at = client metadata
 *   received_at = server authority
 *
 * A client clock may be wrong or dishonest, so this never determines ingest
 * ordering. Step 10 stamps `received_at` server-side as the authoritative axis.
 */
const occurredAtSchema = z.iso.datetime({ offset: true });

/**
 * Reference to a precheck receipt this event follows up on.
 *
 * UUID because `precheck_receipts.id` is a uuid generated by the plane - unlike
 * `event_id` and `block_id`, this value originated server-side, so requiring
 * the exact format is reasonable.
 *
 * Structural validation only. No lookup happens in Step 9, and Step 18 owns the
 * no-double-debit linkage.
 */
const precheckIdSchema = z.uuid();

/**
 * Runtime-specific metadata.
 *
 * The extensibility escape hatch that lets `strict` be safe elsewhere: anything
 * a runtime wants to record that is not a governed field goes here.
 *
 * INERT BY CONSTRUCTION. Step 10 stores this verbatim in `events.payload` and
 * never reads it for authority. Governance-critical values such as `amount_usd`
 * are typed envelope fields precisely so they can never hide in here where
 * nothing validates them.
 *
 * The two rejected keys below are a deliberate tripwire: a client putting a
 * workspace id in the payload has misunderstood the tenancy model, and failing
 * loudly beats storing an inert field a future reader might mistake for
 * authoritative.
 */
const payloadSchema = z
  .record(z.string(), z.unknown())
  .refine(
    (value) =>
      !('workspace_id' in value) &&
      !('workspaceId' in value) &&
      !('tenant_id' in value) &&
      !('tenantId' in value),
    { message: 'payload must not carry workspace or tenant identity; it comes from the API key.' },
  );

/** Fields common to every event variant. */
const commonEventFields = {
  event_id: eventIdSchema,
  agent_id: agentIdSchema,
  occurred_at: occurredAtSchema.optional(),
  precheck_id: precheckIdSchema.optional(),
  payload: payloadSchema.optional(),
} as const;

// ─── Event variants ─────────────────────────────────────────────────────────

/**
 * `agent.action` - the agent did something governed.
 *
 * `category` is required: an action the plane cannot categorise cannot be
 * governed, and `other` exists for genuinely uncategorised work.
 */
export const agentActionEventSchema = z.strictObject({
  type: z.literal('agent.action'),
  ...commonEventFields,
  category: actionCategorySchema,
});
export type AgentActionEvent = z.infer<typeof agentActionEventSchema>;

/**
 * `spend.recorded` - money was spent.
 *
 * Both `amount_usd` and `provider` are required. An unattributed or
 * unquantified spend cannot be reconciled against a cap, so accepting one would
 * produce a ledger that silently under-counts.
 */
export const spendRecordedEventSchema = z.strictObject({
  type: z.literal('spend.recorded'),
  ...commonEventFields,
  amount_usd: decimalUsdSchema,
  /**
   * Free-form vendor label, e.g. `openai`, `anthropic`, `internal`.
   *
   * Deliberately NOT an enum. Pinning the vocabulary to today's vendors would
   * make adding one a contract change, and would quietly couple governance to a
   * vendor list - the opposite of the replaceable-runtime architecture.
   * Provider is metadata; it carries no authority.
   */
  provider: z.string().trim().min(1).max(MAX_PROVIDER_LENGTH),
});
export type SpendRecordedEvent = z.infer<typeof spendRecordedEventSchema>;

/**
 * `action.blocked` - something was denied.
 *
 * Covers runtime/client-side denials. Plane-owned denials are recorded by the
 * plane itself in the same transaction as the receipt; this variant exists so a
 * runtime can report its own.
 *
 * CATEGORY-AWARE VALIDATION (see the refinement below): a spend denial must
 * carry `amount_usd`, a publish denial must carry `count`, and neither may
 * carry the other's field. Those are the numbers that later explain AC-08
 * ($41 over-cap denial) and AC-11 (6th publish denied); a denial missing them
 * is unexplainable, and one carrying both is ambiguous.
 */
const actionBlockedBaseSchema = z.strictObject({
  type: z.literal('action.blocked'),
  ...commonEventFields,
  category: actionCategorySchema,
  /** Machine-readable rule identifier, e.g. `daily_spend_cap`. */
  rule: z.string().trim().min(1).max(MAX_RULE_LENGTH),
  /** Human-readable explanation. */
  reason: z.string().trim().min(1).max(MAX_REASON_LENGTH),
  /**
   * Client/runtime-supplied block identifier, for later deduplication.
   *
   * A bounded opaque STRING, not a UUID, and distinct from both `event_id` and
   * `precheck_id`. It maps to `blocks.external_block_id`; the internal
   * `blocks.id` uuid is never client-supplied.
   *
   * Optional because a runtime may report a denial it did not assign an id to.
   */
  block_id: z.string().trim().min(1).max(MAX_BLOCK_ID_LENGTH).optional(),
  /** Required for a spend denial, forbidden otherwise. */
  amount_usd: decimalUsdSchema.optional(),
  /** Required for a publish denial, forbidden otherwise. */
  count: z.number().int().min(0).max(MAX_COUNT).optional(),
});

export const actionBlockedEventSchema = actionBlockedBaseSchema
  .refine((event) => event.category !== 'spend' || event.amount_usd !== undefined, {
    message: 'A blocked spend must carry amount_usd.',
    path: ['amount_usd'],
  })
  .refine((event) => event.category !== 'publish' || event.count !== undefined, {
    message: 'A blocked publish must carry count.',
    path: ['count'],
  })
  .refine((event) => event.category === 'spend' || event.amount_usd === undefined, {
    message: 'amount_usd is only meaningful for a blocked spend.',
    path: ['amount_usd'],
  })
  .refine((event) => event.category === 'publish' || event.count === undefined, {
    message: 'count is only meaningful for a blocked publish.',
    path: ['count'],
  });
export type ActionBlockedEvent = z.infer<typeof actionBlockedEventSchema>;

/**
 * `heartbeat` - the agent is alive.
 *
 * Deliberately minimal. Because the object is strict, a heartbeat carrying
 * `amount_usd` or `category` is rejected rather than quietly accepted with the
 * field dropped - a heartbeat that looked like it recorded spend would be a
 * silent accounting hole.
 *
 * Step 10 will let a heartbeat advance `last_seen_at`. No such effect exists
 * yet.
 */
export const heartbeatEventSchema = z.strictObject({
  type: z.literal('heartbeat'),
  ...commonEventFields,
});
export type HeartbeatEvent = z.infer<typeof heartbeatEventSchema>;

/**
 * Any single event.
 *
 * A discriminated union on `type`, so a malformed event reports the problem
 * with ITS variant rather than a confusing "no union member matched".
 */
export const eventSchema = z.discriminatedUnion('type', [
  agentActionEventSchema,
  spendRecordedEventSchema,
  actionBlockedEventSchema,
  heartbeatEventSchema,
]);
export type IngestEvent = z.infer<typeof eventSchema>;

// ─── Batch request ──────────────────────────────────────────────────────────

/**
 * `POST /v1/events` request body.
 *
 * DUPLICATE `event_id` WITHIN ONE BATCH IS REJECTED.
 *
 * The alternative - silently de-duplicating inside the request - makes the
 * `accepted` / `duplicates` counts ambiguous (is the second occurrence a
 * duplicate of a stored event, or of its own sibling?) and hides what is almost
 * certainly a client bug. Cross-REQUEST replay is different and fully
 * supported: that is the AC-13 idempotency path and returns 200.
 */
export const eventIngestRequestSchema = z
  .strictObject({
    events: z.array(eventSchema).min(1).max(MAX_EVENTS_PER_BATCH),
  })
  .refine(
    (body) => new Set(body.events.map((event) => event.event_id)).size === body.events.length,
    {
      message: 'Duplicate event_id within a single batch. Each event_id must appear at most once.',
      path: ['events'],
    },
  );

export type EventIngestRequest = z.infer<typeof eventIngestRequestSchema>;

// ─── Response ───────────────────────────────────────────────────────────────

/**
 * Successful ingest response.
 *
 * An aggregate rather than per-event outcomes, because the aggregate is exactly
 * what AC-13 needs to prove: replay the same batch, receive HTTP 200 with
 * `accepted: 0, duplicates: N`, and observe the stored count unchanged. Adding
 * per-event status would grow the contract without making that demonstration
 * any stronger, and would invite callers to depend on ordering.
 *
 * `accepted + duplicates` always equals the number of events submitted -
 * nothing is silently dropped.
 */
export const eventIngestResponseSchema = z.strictObject({
  /** Newly stored events. */
  accepted: z.number().int().min(0),
  /** Events already present for this workspace, ignored idempotently. */
  duplicates: z.number().int().min(0),
});

export type EventIngestResponse = z.infer<typeof eventIngestResponseSchema>;

// ─── Validation errors ──────────────────────────────────────────────────────

/**
 * One validation problem, in a client-safe shape.
 *
 * Deliberately just a path and a message. Returning a raw Zod error tree would
 * expose schema internals, issue codes and union-resolution detail - useful to
 * someone probing the contract, and noise to a legitimate client.
 */
export const validationIssueSchema = z.strictObject({
  path: z.string(),
  message: z.string(),
});
export type ValidationIssue = z.infer<typeof validationIssueSchema>;

/** Maximum issues reported, so one bad batch cannot return a huge error body. */
export const MAX_REPORTED_ISSUES = 20;

/**
 * Error response for a rejected batch.
 *
 * THE WHOLE BATCH IS REJECTED IF ANY EVENT IS INVALID. Partially accepting a
 * malformed batch would leave the caller unsure which events landed, and "no
 * silent drops" is a locked requirement. One 400, with the reasons.
 */
export const eventIngestErrorSchema = z.strictObject({
  error: z.literal('invalid_batch'),
  issues: z.array(validationIssueSchema).max(MAX_REPORTED_ISSUES),
});

export type EventIngestError = z.infer<typeof eventIngestErrorSchema>;

/**
 * Converts a Zod error into the client-safe issue list.
 *
 * Lives in the contracts package so the API and the simulator agree on how a
 * rejection reads, and so Step 10 has no excuse to serialise a raw Zod error.
 */
export function toValidationIssues(error: z.ZodError): ValidationIssue[] {
  return error.issues.slice(0, MAX_REPORTED_ISSUES).map((issue) => ({
    path: issue.path.map((segment) => String(segment)).join('.'),
    message: issue.message,
  }));
}
