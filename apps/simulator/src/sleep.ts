/**
 * The interruptible delay both long-running scenarios wait on.
 *
 * ─── WHY THIS TIMER IS NOT UNREF'D ────────────────────────────────────────
 *
 * An earlier version called `timer.unref()` here, reasoning that a pending
 * timer should never keep the process alive after a shutdown signal. The
 * reasoning was right; the mechanism was wrong, and it cost the loop its life.
 *
 * `unref` does not mean "do not linger after abort" - it means "do not count
 * toward keeping Node running AT ALL". The scenario loops hold no other
 * referenced handle while they wait: the HTTP requests have completed and the
 * policy poller is deliberately unref'd because a background poller should not
 * by itself keep the process up. So the FIRST time a loop awaited an unref'd
 * sleep, the event loop found nothing referenced and Node exited 0 - after a
 * single cycle, with no error, looking exactly like a clean finish.
 *
 * That is invisible to the unit tests, which inject an instant `sleep` and a
 * `maxCycles` bound, and it only shows up when the compiled binary is run the
 * way it is actually deployed: unbounded. `demo` and `stream` are supposed to
 * run until stopped.
 *
 * Prompt shutdown does not need `unref` anyway. The abort listener below
 * clears the timer and resolves immediately, so an aborted wait ends at once
 * and the loop falls out on its next condition check.
 *
 * ─── AND WHY THE LISTENER IS REMOVED ──────────────────────────────────────
 *
 * The signal outlives every individual sleep. Adding a listener per cycle and
 * never removing it accumulates one per cycle on a process designed to run for
 * days - a slow leak, and a MaxListenersExceededWarning at eleven.
 */
export function sleep(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    return Promise.resolve();
  }

  return new Promise<void>((resolve) => {
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve();
    };

    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);

    signal.addEventListener('abort', onAbort, { once: true });
  });
}
