import { OVER_CAP_AMOUNT } from './fleet.js';
import type { Logger } from './logging.js';
import { runBaseline, type ScenarioDeps } from './scenarios.js';
import { sleep as defaultSleep } from './sleep.js';

/**
 * The AC-19 public demo generator.
 *
 * ─── WHY THIS LIVES IN THE REFERENCE CLIENT ───────────────────────────────
 *
 * AC-19 requires recurring synthetic activity produced through the REAL
 * control-plane path - not rows inserted into PostgreSQL. The reference client
 * already is that path: one workspace API key, four machine routes, no
 * database import, enforced by lint and by architecture guards.
 *
 * Writing a second HTTP client for the demo would duplicate the retry and
 * identity semantics that took a whole step to get right, and the copy would
 * drift. So the generator is a MODE of the reference client, reusing
 * `ControlPlaneClient` and the runtime verbs unchanged.
 *
 * The dependency runs one way: the control plane does not know the generator
 * exists, and governance is not coupled to the simulator.
 *
 * ─── HOW A REAL BLOCK IS PRODUCED ─────────────────────────────────────────
 *
 * A plane-owned block cannot be fabricated. It exists only as the product of:
 *
 *   precheck -> server evaluates policy -> DENY -> receipt + block, atomically
 *
 * So the generator periodically attempts a spend it expects to be refused
 * under the configured demo policy, and lets the server decide. What arrives
 * on the public page is a real denial with a real receipt.
 *
 * ─── EVERY CYCLE NEEDS A NEW ACTION ID ────────────────────────────────────
 *
 * THE SUBTLE FAILURE THIS FILE EXISTS TO AVOID.
 *
 * `action_id` is the precheck idempotency key. Reusing one across cycles would
 * replay the FIRST decision forever: the plane would return the original
 * receipt and write NO NEW BLOCK. The public page would show one block from
 * an hour ago and never another, and everything would look like it was
 * working.
 *
 * Each block attempt therefore carries a fresh ordinal, so every cycle is a
 * genuinely new action. A retry of an UNCERTAIN attempt is the opposite case
 * and reuses its id - that distinction lives in `client.ts` and `ids.ts`.
 *
 * ─── THE GENERATOR NEVER OVERRIDES THE OPERATOR ───────────────────────────
 *
 * It holds machine authority only: register, poll, precheck, report. It cannot
 * set a cap, pause an agent, or change anything the plane governs, and a guard
 * test asserts the simulator constructs no operator route at all.
 *
 * So if an operator raises the demo cap and the over-cap attempt starts being
 * ALLOWED, the generator obeys - it reports the spend like any runtime would
 * and does not quietly lower the cap to keep producing blocks. Recurring
 * blocks depend on an appropriate demo policy being configured through the
 * normal operator UI; that is a precondition, documented in docs/demo.md, not
 * something a runtime may arrange for itself.
 */

/** How often the whole fleet does ordinary work. */
export const DEFAULT_ACTIVITY_INTERVAL_MS = 20_000;

/**
 * How often an over-cap attempt is made.
 *
 * Three minutes satisfies "every few minutes" while keeping the public page
 * interesting for someone watching it, and keeps write volume modest.
 */
export const DEFAULT_BLOCK_INTERVAL_MS = 3 * 60_000;

export interface DemoGeneratorOptions {
  readonly deps: ScenarioDeps;
  readonly activityIntervalMs: number;
  readonly blockIntervalMs: number;
  /** Stops the loop. Also what a SIGINT/SIGTERM handler triggers. */
  readonly signal: AbortSignal;
  /** Injected so tests do not wait minutes. */
  readonly sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  /** Bounds a test run. Undefined means "until stopped". */
  readonly maxCycles?: number | undefined;
}

export interface DemoGeneratorResult {
  readonly cycles: number;
  readonly blockAttempts: number;
  /** Attempts the plane refused. The public page shows one block for each. */
  readonly denials: number;
}

/**
 * Runs recurring synthetic activity until stopped.
 *
 * A transient failure is survivable: the cycle is logged and the loop
 * continues, because a demo that stops forever after one 503 is worse than one
 * that misses a cycle. A 401 is different and is left to the caller - see
 * `index.ts`, which treats a rejected credential as fatal rather than
 * hammering the plane with a key that will never work.
 */
export async function runDemoGenerator(
  options: DemoGeneratorOptions,
): Promise<DemoGeneratorResult> {
  const { deps, activityIntervalMs, blockIntervalMs, signal, maxCycles } = options;
  const { runtime, log } = deps;
  const sleep = options.sleep ?? defaultSleep;

  log.step('Demo generator running');
  log.info(
    `activity every ${String(Math.round(activityIntervalMs / 1000))}s · ` +
      `over-cap attempt every ${String(Math.round(blockIntervalMs / 1000))}s`,
  );
  log.info('Recurring blocks require agent-a to be budgeted with a cap below $41.');

  let cycles = 0;
  let blockAttempts = 0;
  let denials = 0;
  let sinceLastBlock = 0;

  while (!signal.aborted && (maxCycles === undefined || cycles < maxCycles)) {
    try {
      // Ordinary fleet activity: three agents heartbeat and do their work
      // through the real API, so `last_seen_at` moves for real.
      await runBaseline(deps, cycles);
      sinceLastBlock += activityIntervalMs;

      if (sinceLastBlock >= blockIntervalMs) {
        sinceLastBlock = 0;
        blockAttempts += 1;

        // A NEW ordinal, and therefore a NEW action id. This is the line the
        // whole recurring-block requirement rests on.
        const outcome = await runtime.spend(
          'agent-a',
          OVER_CAP_AMOUNT,
          'demo-over-cap',
          blockAttempts,
        );

        if (outcome.status === 'denied') {
          denials += 1;
          // The plane wrote the receipt and the block. Nothing to add: a
          // runtime `action.blocked` here would put two records in the audit
          // for one refusal.
          log.info(
            `Block ${String(denials)} recorded by the control plane · receipt ${outcome.precheckId}`,
          );
        } else {
          // Allowed. The generator obeys the plane rather than manufacturing
          // a denial to satisfy a demo.
          log.info(
            'The over-cap attempt was ALLOWED under current policy, so no block was created.',
          );
        }
      }
    } catch (caught: unknown) {
      // Survivable. The next cycle tries again.
      log.warn(caught instanceof Error ? caught.message : 'a demo cycle failed');
    }

    cycles += 1;
    if (signal.aborted || (maxCycles !== undefined && cycles >= maxCycles)) {
      break;
    }
    await sleep(activityIntervalMs, signal);
  }

  log.info(
    `Demo generator stopped after ${String(cycles)} cycle(s), ` +
      `${String(blockAttempts)} over-cap attempt(s), ${String(denials)} block(s).`,
  );
  return { cycles, blockAttempts, denials };
}

/** Reads a bounded interval from configuration. */
export function readIntervalMs(
  raw: string | undefined,
  fallback: number,
  minimum: number,
): number {
  if (raw === undefined || raw === '' || !/^[0-9]{1,8}$/.test(raw)) {
    return fallback;
  }
  const value = Number.parseInt(raw, 10);
  // A floor, so a typo cannot turn the generator into a load test against the
  // control plane.
  return value < minimum ? minimum : value;
}

/** Floors, applied to configuration. Tests inject their own timings instead. */
export const MIN_ACTIVITY_INTERVAL_MS = 1_000;
export const MIN_BLOCK_INTERVAL_MS = 5_000;

export type { Logger };
