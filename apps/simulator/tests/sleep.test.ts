import { afterEach, describe, expect, it, vi } from 'vitest';

import { sleep } from '../src/sleep';

/**
 * Regression cover for a defect the scenario tests could not see.
 *
 * Both long-running scenarios inject an instant `sleep` and a `maxCycles`
 * bound, so they never exercise the real timer. The real timer was `unref`'d,
 * and because nothing else referenced the event loop while a scenario waited,
 * the compiled binary exited 0 after ONE cycle - silently, and looking exactly
 * like a clean finish. It was only visible by running the built artifact
 * unbounded, the way it is deployed.
 *
 * These tests pin the two properties that matter: the wait holds the process
 * up, and it still ends the instant the signal aborts.
 */

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('the scenario wait', () => {
  it('DOES NOT UNREF ITS TIMER', async () => {
    // The regression, asserted directly. An unref'd timer does not keep Node
    // running, so a loop awaiting one exits after its first cycle.
    const unref = vi.fn();
    const real = globalThis.setTimeout;
    const spy = vi
      .spyOn(globalThis, 'setTimeout')
      .mockImplementation(((handler: () => void, ms?: number) => {
        const handle = real(handler, ms);
        return Object.assign(handle as unknown as object, { unref }) as never;
      }) as never);

    await sleep(1, new AbortController().signal);

    expect(spy).toHaveBeenCalledTimes(1);
    expect(unref).not.toHaveBeenCalled();
  });

  it('waits the requested time', async () => {
    vi.useFakeTimers();
    let done = false;
    const pending = sleep(120_000, new AbortController().signal).then(() => {
      done = true;
    });

    await vi.advanceTimersByTimeAsync(119_999);
    expect(done).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    await pending;
    expect(done).toBe(true);
  });

  it('ends immediately when the signal aborts, without waiting out the delay', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    let done = false;
    const pending = sleep(120_000, controller.signal).then(() => {
      done = true;
    });

    controller.abort();
    await pending;

    expect(done).toBe(true);
    // Nothing left behind to fire later.
    expect(vi.getTimerCount()).toBe(0);
  });

  it('returns at once if the signal is already aborted', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    controller.abort();

    await sleep(120_000, controller.signal);

    expect(vi.getTimerCount()).toBe(0);
  });

  it('LEAVES NO LISTENER BEHIND: the signal outlives every individual wait', async () => {
    // One listener per cycle on a process meant to run for days is a leak, and
    // Node warns at eleven.
    const controller = new AbortController();
    const added = vi.spyOn(controller.signal, 'addEventListener');
    const removed = vi.spyOn(controller.signal, 'removeEventListener');

    for (let i = 0; i < 20; i += 1) {
      await sleep(0, controller.signal);
    }

    expect(added).toHaveBeenCalledTimes(20);
    expect(removed).toHaveBeenCalledTimes(20);
  });
});
