import {
  eventIngestRequestSchema,
  type EventIngestRequest,
  type EventIngestResponse,
  type IngestEvent,
} from '@hybrid/contracts';

/**
 * Compile-time proof that the simulator can consume the Step 9 event contracts.
 *
 * The simulator is the reference client that will later drive the Credit
 * acceptance scenarios. This file exists so a contract change that breaks that
 * consumer fails the build now rather than in the simulator step.
 *
 * IT GENERATES NOTHING AND SENDS NOTHING. Building an example batch is a type
 * exercise, not event generation - no network call, no scheduling, no scenario.
 * That belongs to the dedicated simulator step.
 */

/** Shapes one example of each event type, purely to exercise the types. */
export function describeSupportedEvents(agentId: string): IngestEvent[] {
  return [
    { type: 'heartbeat', event_id: 'hb-1', agent_id: agentId },
    { type: 'agent.action', event_id: 'act-1', agent_id: agentId, category: 'llm_call' },
    {
      type: 'spend.recorded',
      event_id: 'spend-1',
      agent_id: agentId,
      amount_usd: '0.010000',
      provider: 'openai',
    },
    {
      type: 'action.blocked',
      event_id: 'blk-1',
      agent_id: agentId,
      category: 'publish',
      rule: 'daily_publish_cap',
      reason: 'Daily publish cap reached',
      count: 6,
    },
  ];
}

/** Validates a batch locally, the way the simulator will before sending. */
export function buildExampleBatch(agentId: string): EventIngestRequest {
  return eventIngestRequestSchema.parse({ events: describeSupportedEvents(agentId) });
}

/** Named so the response type is referenced and therefore checked. */
export type SimulatorIngestResult = EventIngestResponse;
