import { z } from 'zod';

import { actionCategorySchema, eventTypeSchema } from './events.js';

/**
 * Step 11 timeline and event-detail contracts (AC-05, AC-06).
 *
 * OPERATOR SURFACE, camelCase
 * ---------------------------
 * These are read by our own browser app, so they follow the operator
 * convention already used by the workspace, API-key and agent contracts. The
 * snake_case machine surface in `events.ts` is a separate audience: an external
 * contract we do not control.
 *
 * The one deliberate exception is QUERY STRING parameters (`agent_id`, `limit`,
 * `cursor`), which stay snake_case because they are URL syntax rather than a
 * response body, and because `agent_id` is the same identifier agents send on
 * ingest. Using two spellings of that value across the product would be worse
 * than one seam here.
 *
 * READ-ONLY
 * ---------
 * Nothing in this file describes a write. There is no update, no delete and no
 * "dismiss" shape, because the event stream is an append-only audit record.
 */

/** `/v1/workspaces/:workspaceId/events` */
export function workspaceEventsPath(workspaceId: string): string {
  return `/v1/workspaces/${encodeURIComponent(workspaceId)}/events`;
}

/** `/v1/workspaces/:workspaceId/events/:eventId` - `eventId` is the internal UUID. */
export function workspaceEventPath(workspaceId: string, eventId: string): string {
  return `${workspaceEventsPath(workspaceId)}/${encodeURIComponent(eventId)}`;
}

/** Query parameter names, shared so the client cannot misspell one. */
export const TIMELINE_AGENT_PARAM = 'agent_id' as const;
export const TIMELINE_LIMIT_PARAM = 'limit' as const;
export const TIMELINE_CURSOR_PARAM = 'cursor' as const;

/**
 * Page sizing.
 *
 * The default is generous enough that the common case is one request, and the
 * maximum is low enough that a single call cannot be turned into a bulk export.
 * AC-16 (CSV export) is deferred, and raising this would quietly implement it.
 */
export const TIMELINE_DEFAULT_LIMIT = 50;
export const TIMELINE_MAX_LIMIT = 100;

/** Bounds the opaque cursor before it is even decoded. */
export const MAX_CURSOR_LENGTH = 512;

/**
 * Timeline query parameters.
 *
 * `limit` arrives as a string from the URL, so it is coerced explicitly rather
 * than with `z.coerce.number()`, which accepts `""` as 0 and `"1e3"` as 1000.
 * A caller that sends something unparseable gets a 400, never a silent default:
 * silently substituting 50 for `limit=abc` would hide a client bug.
 */
export const timelineQuerySchema = z.strictObject({
  [TIMELINE_AGENT_PARAM]: z.string().trim().min(1).max(120).optional(),
  [TIMELINE_LIMIT_PARAM]: z
    .string()
    .regex(/^[0-9]{1,4}$/, 'Limit must be a whole number.')
    .transform((raw) => Number.parseInt(raw, 10))
    .refine(
      (value) => value >= 1 && value <= TIMELINE_MAX_LIMIT,
      `Limit must be between 1 and ${String(TIMELINE_MAX_LIMIT)}.`,
    )
    .optional(),
  [TIMELINE_CURSOR_PARAM]: z
    .string()
    .min(1)
    .max(MAX_CURSOR_LENGTH)
    // base64url alphabet only. Anything else cannot be a cursor we issued, and
    // rejecting it here keeps malformed input away from the decoder.
    .regex(/^[A-Za-z0-9_-]+$/, 'Malformed cursor.')
    .optional(),
});

export type TimelineQuery = z.infer<typeof timelineQuerySchema>;

/**
 * The agent an event came from, denormalised for display.
 *
 * Enough to render a row without a second request, and nothing more: no
 * last-seen, no policy, no mode. A timeline row is not an agent detail view.
 */
export const eventAgentRefSchema = z.object({
  /** Internal UUID. */
  id: z.uuid(),
  /** The stable client-supplied identifier (`agents.external_id`). */
  agentId: z.string(),
  name: z.string().nullable(),
});

export type EventAgentRef = z.infer<typeof eventAgentRefSchema>;

/**
 * Safe block linkage.
 *
 * `externalBlockId` is the identity a runtime recognises; the internal `id` is
 * ours. Both are exposed because AC-08/AC-11 will need to navigate from an
 * event to its denial, and designing that linkage out now would be expensive to
 * add back. Deliberately NOT included: rule, reason, amount and cap - block
 * detail is a later step, and half-rendering a denial is worse than not
 * rendering one.
 */
export const eventBlockRefSchema = z.object({
  id: z.uuid(),
  /** Null for plane-owned blocks, which carry no external id. */
  externalBlockId: z.string().nullable(),
  source: z.enum(['plane', 'runtime']),
});

export type EventBlockRef = z.infer<typeof eventBlockRefSchema>;

/**
 * One timeline row.
 *
 * NO RAW PAYLOAD. A payload can be large and a page holds up to 100 rows, so
 * including them would make the response size a function of untrusted client
 * data. The raw object belongs to the detail endpoint - which is the main
 * reason list and detail are separate.
 */
export const eventSummarySchema = z.object({
  /** Internal UUID - the id the detail endpoint takes. */
  id: z.uuid(),
  /** Client-supplied idempotency key. Unique per workspace, not globally. */
  eventId: z.string(),
  agent: eventAgentRefSchema,
  type: eventTypeSchema,
  category: actionCategorySchema.nullable(),
  /** Client-reported and UNTRUSTED. Null when the client sent none. */
  occurredAt: z.string().nullable(),
  /** SERVER time. The authoritative ordering axis. */
  receivedAt: z.string(),
  /** Internal receipt UUID, or null. */
  precheckId: z.uuid().nullable(),
  block: eventBlockRefSchema.nullable(),
});

export type EventSummary = z.infer<typeof eventSummarySchema>;

/**
 * A page of the timeline.
 *
 * `nextCursor` is null on the last page. It is opaque: clients must pass it back
 * unmodified and must not parse it - its contents are an implementation detail
 * and carry no authority.
 */
export const timelineResponseSchema = z.object({
  events: z.array(eventSummarySchema),
  nextCursor: z.string().nullable(),
});

export type TimelineResponse = z.infer<typeof timelineResponseSchema>;

/**
 * Event detail, including the raw event (AC-06).
 *
 * `raw` IS THE VALIDATED EVENT OBJECT, NOT RAW HTTP REQUEST DATA.
 *
 * It is exactly what the Step 9 contract accepted and Step 10 stored in
 * `events.payload` - post-validation, post-parse. It is NOT request bytes, not
 * headers, and not the HTTP envelope. That distinction is the reason no
 * credential material can appear here: the `Authorization` header never reached
 * the validated object in the first place.
 */
export const eventDetailSchema = eventSummarySchema.extend({
  raw: z.unknown(),
});

export type EventDetail = z.infer<typeof eventDetailSchema>;

export const eventDetailResponseSchema = z.object({
  event: eventDetailSchema,
});

export type EventDetailResponse = z.infer<typeof eventDetailResponseSchema>;
