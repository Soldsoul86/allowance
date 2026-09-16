/**
 * The Event Journal — Orb's single source of truth.
 *
 * Constitution Art. I: appends only, never mutates, hash-chains for
 * tamper-evidence. Art. IV §15: a device writes only its own lane and merely
 * replicates foreign lanes. Everything else in Orb is a projection of this.
 */
import { HybridLogicalClock, type Hlc, type PhysicalClock } from "./hlc.js";
import { hashEvent, verifyLane } from "./integrity.js";
import { newEventId } from "./ids.js";
import type { JournalStore } from "./store.js";
import { MemoryJournalStore } from "./store.js";
import type { EventDraft, LaneId, OrbEvent } from "./types.js";
import { JournalIntegrityError } from "./types.js";

export interface JournalOptions {
  /** This device's lane. The journal appends here and nowhere else. */
  readonly lane: LaneId;
  /** Stable device identity recorded on every event. */
  readonly device: string;
  readonly store?: JournalStore;
  readonly now?: PhysicalClock;
}

/** Notified after events become durable. Listeners must not throw. */
export type JournalListener = (events: readonly OrbEvent[]) => void;

export class Journal {
  readonly lane: LaneId;
  readonly device: string;

  readonly #store: JournalStore;
  readonly #clock: HybridLogicalClock;
  readonly #now: PhysicalClock;
  readonly #listeners = new Set<JournalListener>();

  /** Hash of the last event appended to the local lane; `null` until first append. */
  #head: string | null = null;
  /** Serialises appends so identity, HLC and hash chain advance atomically. */
  #tail: Promise<unknown> = Promise.resolve();
  #opened = false;

  private constructor(options: JournalOptions, store: JournalStore) {
    this.lane = options.lane;
    this.device = options.device;
    this.#store = store;
    this.#now = options.now ?? (() => Date.now());
    this.#clock = new HybridLogicalClock(this.#now);
  }

  /**
   * Opens a journal over `store`, restoring the local lane's head and clock so
   * a restarted process continues the same chain rather than forking it.
   */
  static async open(options: JournalOptions): Promise<Journal> {
    const store = options.store ?? new MemoryJournalStore();
    const journal = new Journal(options, store);
    await journal.#restore();
    return journal;
  }

  async #restore(): Promise<void> {
    const existing = await this.#store.read(this.lane);
    verifyLane(existing);

    const last = existing.at(-1);
    if (last) {
      this.#head = last.integrity.hash;
      this.#clock.merge(last.hlc);
    }

    // Carry every replicated lane's causal knowledge into the local clock, so a
    // local append never appears to precede something it already knows about.
    for (const lane of await this.#store.lanes()) {
      if (lane === this.lane) continue;
      const foreign = await this.#store.read(lane);
      const foreignLast = foreign.at(-1);
      if (foreignLast) this.#clock.merge(foreignLast.hlc);
    }

    this.#opened = true;
  }

  /** The HLC this journal would extend. Exposed for diagnostics and tests. */
  get clock(): Hlc {
    return this.#clock.last;
  }

  /**
   * Appends drafts to the local lane as one atomic, durable batch.
   *
   * Appends are serialised: concurrent callers are ordered by arrival, and each
   * batch's ids, HLCs and hashes are assigned without interleaving.
   */
  async append(drafts: readonly EventDraft[]): Promise<readonly OrbEvent[]> {
    if (!this.#opened) throw new Error("journal is not open");
    if (drafts.length === 0) return [];

    const result = this.#tail.then(() => this.#appendNow(drafts));
    this.#tail = result.catch(() => undefined);
    return result;
  }

  /** Convenience for the common single-event case. */
  async appendOne<P>(draft: EventDraft<P>): Promise<OrbEvent<P>> {
    const [event] = await this.append([draft]);
    if (!event) throw new Error("append produced no event");
    return event as OrbEvent<P>;
  }

  async #appendNow(drafts: readonly EventDraft[]): Promise<readonly OrbEvent[]> {
    const events: OrbEvent[] = [];
    let previous = this.#head;

    for (const draft of drafts) {
      const hlc = this.#clock.tick();
      const wallClock = this.#now();
      const skeleton = {
        id: newEventId(wallClock),
        lane: this.lane,
        device: this.device,
        hlc,
        wallClock,
        type: draft.type,
        causes: draft.causes ?? [],
        schema: draft.schema,
        payload: draft.payload,
      };
      const hash = hashEvent({ ...skeleton, previous });
      events.push({ ...skeleton, integrity: { previous, hash } });
      previous = hash;
    }

    await this.#store.append(this.lane, events);
    this.#head = previous;

    for (const listener of this.#listeners) listener(events);
    return events;
  }

  /**
   * Adopts events from a foreign lane (Art. IV §18: merge is set union of
   * immutable lanes). Rejects anything claiming to be this device's lane.
   */
  async replicate(lane: LaneId, events: readonly OrbEvent[]): Promise<void> {
    if (lane === this.lane) {
      throw new JournalIntegrityError("a device never accepts writes to its own lane", { lane });
    }
    if (events.some((event) => event.lane !== lane)) {
      throw new JournalIntegrityError("replicated event does not belong to the named lane", { lane });
    }

    const existing = await this.#store.read(lane);
    const known = new Set(existing.map((event) => event.id));
    const fresh = events.filter((event) => !known.has(event.id));
    if (fresh.length === 0) return;

    verifyLane([...existing, ...fresh]);
    await this.#store.append(lane, fresh);

    const last = fresh.at(-1);
    if (last) this.#clock.merge(last.hlc);
    for (const listener of this.#listeners) listener(fresh);
  }

  /** Every event in every lane, unordered. Use `replay` for ordered folding. */
  async readAll(): Promise<readonly OrbEvent[]> {
    const out: OrbEvent[] = [];
    for (const lane of await this.#store.lanes()) out.push(...(await this.#store.read(lane)));
    return out;
  }

  async readLane(lane: LaneId): Promise<readonly OrbEvent[]> {
    return this.#store.read(lane);
  }

  async lanes(): Promise<readonly LaneId[]> {
    return this.#store.lanes();
  }

  /** Verifies every lane's hash chain. Throws on the first corruption found. */
  async verify(): Promise<void> {
    for (const lane of await this.#store.lanes()) verifyLane(await this.#store.read(lane));
  }

  /** Subscribes to durable appends. Returns an unsubscribe function. */
  subscribe(listener: JournalListener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  async close(): Promise<void> {
    await this.#tail;
    this.#opened = false;
    this.#listeners.clear();
    await this.#store.close();
  }
}
