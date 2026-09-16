/**
 * The one place a clock is allowed to exist.
 *
 * The engine is pure and takes its instant from the request. The shell has to
 * get that instant from somewhere, and "somewhere" is injected rather than
 * imported so a test can drive time instead of waiting for it (Art. IX §35:
 * every module independently testable).
 */
export interface Clock {
  now(): number;
}

export const systemClock: Clock = { now: () => Date.now() };

/** A clock a test owns. Time moves only when something moves it. */
export class ManualClock implements Clock {
  #at: number;
  constructor(startAt: number) {
    this.#at = startAt;
  }
  now(): number {
    return this.#at;
  }
  advance(ms: number): void {
    this.#at += ms;
  }
  set(at: number): void {
    this.#at = at;
  }
}
