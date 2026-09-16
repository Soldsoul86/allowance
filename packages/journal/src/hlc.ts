/**
 * Hybrid Logical Clocks.
 *
 * EVENT_MODEL.md §5 and Constitution Art. IV §17: public ordering is `(hlc, lane)`,
 * derived on read, never stored. An HLC keeps a monotonic logical counter bounded
 * close to physical time, so causal order survives unsynchronised device clocks.
 */

/** A Hybrid Logical Clock timestamp. */
export interface Hlc {
  /** Physical component, milliseconds since the Unix epoch. */
  readonly physical: number;
  /** Logical component, breaking ties within the same physical millisecond. */
  readonly counter: number;
}

/** Monotonic source of physical time, injected so the clock stays testable. */
export type PhysicalClock = () => number;

export const HLC_ZERO: Hlc = Object.freeze({ physical: 0, counter: 0 });

/**
 * Total order on HLC timestamps. Negative when `a` precedes `b`.
 *
 * Note this orders HLCs only; the public ordering of *events* additionally
 * breaks ties by lane (see {@link compareEventOrder} in `replay.ts`).
 */
export function compareHlc(a: Hlc, b: Hlc): number {
  if (a.physical !== b.physical) return a.physical < b.physical ? -1 : 1;
  if (a.counter !== b.counter) return a.counter < b.counter ? -1 : 1;
  return 0;
}

/**
 * Lexicographically sortable encoding, used as a storage key and for debugging.
 * Fixed width so string order matches {@link compareHlc}.
 */
export function encodeHlc(hlc: Hlc): string {
  return `${hlc.physical.toString(10).padStart(15, "0")}.${hlc.counter.toString(10).padStart(6, "0")}`;
}

export function decodeHlc(encoded: string): Hlc {
  const [physical, counter] = encoded.split(".");
  if (physical === undefined || counter === undefined) {
    throw new TypeError(`malformed HLC: ${encoded}`);
  }
  return { physical: Number.parseInt(physical, 10), counter: Number.parseInt(counter, 10) };
}

/**
 * A device's Hybrid Logical Clock.
 *
 * `tick` is called on every local append; `merge` is called for every event
 * received from a foreign lane, carrying that peer's causal knowledge forward.
 */
export class HybridLogicalClock {
  #last: Hlc;
  readonly #now: PhysicalClock;

  constructor(now: PhysicalClock, initial: Hlc = HLC_ZERO) {
    this.#now = now;
    this.#last = initial;
  }

  /** The most recent timestamp this clock issued or observed. */
  get last(): Hlc {
    return this.#last;
  }

  /** Advance for a local append: `max(physical, last) (+ counter on ties)`. */
  tick(): Hlc {
    const physical = this.#now();
    this.#last =
      physical > this.#last.physical
        ? { physical, counter: 0 }
        : { physical: this.#last.physical, counter: this.#last.counter + 1 };
    return this.#last;
  }

  /** Merge a remote timestamp: `max(physical, last, incoming) (+ counter)`. */
  merge(incoming: Hlc): Hlc {
    const physical = this.#now();
    const maxPhysical = Math.max(physical, this.#last.physical, incoming.physical);

    let counter: number;
    if (maxPhysical === this.#last.physical && maxPhysical === incoming.physical) {
      counter = Math.max(this.#last.counter, incoming.counter) + 1;
    } else if (maxPhysical === this.#last.physical) {
      counter = this.#last.counter + 1;
    } else if (maxPhysical === incoming.physical) {
      counter = incoming.counter + 1;
    } else {
      counter = 0;
    }

    this.#last = { physical: maxPhysical, counter };
    return this.#last;
  }
}
