/**
 * Injectable clock.
 *
 * Deliberately two lines rather than a time framework. It exists so expiry
 * tests can advance time instead of sleeping, which keeps the suite fast and
 * deterministic.
 *
 * The clock is the auth service's single time authority: the same instant is
 * used to compute an expiry and, later, to evaluate it inside SQL. Client
 * clocks are never consulted.
 */
export interface Clock {
  now(): Date;
}

export const systemClock: Clock = {
  now: () => new Date(),
};

/** Test clock whose time only moves when a test moves it. */
export function createFixedClock(start: Date): Clock & { advance(ms: number): void } {
  let current = start.getTime();
  return {
    now: () => new Date(current),
    advance: (ms: number) => {
      current += ms;
    },
  };
}
