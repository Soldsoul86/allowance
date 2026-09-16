/**
 * Journal storage ports.
 *
 * The journal service owns the invariants; a store owns only durability. Keeping
 * them apart lets the same journal run over memory (tests), a file (the device
 * runtime), or any future encrypted store without changing its semantics.
 */
import type { LaneId, OrbEvent } from "./types.js";

/** Durable, append-only storage for one device's journal. */
export interface JournalStore {
  /**
   * Appends events to `lane` in the given order. Must be atomic per call and
   * durable before resolving: the journal treats a resolved append as history.
   */
  append(lane: LaneId, events: readonly OrbEvent[]): Promise<void>;
  /** Every event in `lane`, in append order. */
  read(lane: LaneId): Promise<readonly OrbEvent[]>;
  /** Every lane this store holds, local and replicated. */
  lanes(): Promise<readonly LaneId[]>;
  /** Releases any held resources. Appends after `close` are errors. */
  close(): Promise<void>;
}

/** In-memory store. Loses history on exit — for tests and ephemeral runtimes. */
export class MemoryJournalStore implements JournalStore {
  readonly #lanes = new Map<LaneId, OrbEvent[]>();
  #closed = false;

  async append(lane: LaneId, events: readonly OrbEvent[]): Promise<void> {
    if (this.#closed) throw new Error("journal store is closed");
    const existing = this.#lanes.get(lane);
    if (existing) existing.push(...events);
    else this.#lanes.set(lane, [...events]);
  }

  async read(lane: LaneId): Promise<readonly OrbEvent[]> {
    return [...(this.#lanes.get(lane) ?? [])];
  }

  async lanes(): Promise<readonly LaneId[]> {
    return [...this.#lanes.keys()].sort();
  }

  async close(): Promise<void> {
    this.#closed = true;
  }

  /** Test helper: total events held across all lanes. */
  get size(): number {
    let total = 0;
    for (const events of this.#lanes.values()) total += events.length;
    return total;
  }
}
