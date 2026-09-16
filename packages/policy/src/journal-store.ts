/**
 * The ledger as a projection of the Event Journal.
 *
 * The journal is the single source of truth, and everything else is a derived
 * projection that may be discarded and rebuilt. The ledger is therefore a fold
 * over four kinds of immutable fact:
 *
 *   payment.reserved   this much was committed, by this requester, at this time
 *   payment.settled    this much was actually spent
 *   payment.reversed   it provably did not happen
 *   payment.extended   the reservation's deadline was pushed out
 *
 * Three consequences fall out for free:
 *
 * - **A restart resumes.** `open` replays the journal and rebuilds the budget
 *   exactly, because the fold is deterministic.
 * - **Devices share a budget.** Replicated lanes carry the same facts, and
 *   `orderEvents` puts them in HLC order, so two devices spending from one
 *   envelope converge instead of double-counting (merge is a set union).
 * - **Reconciliation is a fold, not a special case.** An open reservation is
 *   simply a `reserved` with no matching `settled` or `reversed`.
 *
 * Amounts are written as decimal strings. `canonicalJson` refuses `bigint`,
 * which is the correct refusal — JSON has no unambiguous encoding for one —
 * and a lossy `Number` in a money ledger is exactly the bug this package
 * exists to avoid.
 */
import type { Journal, JournalEvent, SchemaRef } from "@allowance/journal";
import { orderEvents } from "@allowance/journal";

import type { Amount } from "./model.js";
import type { Requester } from "./model.js";
import type { Decision } from "./evaluate.js";
import type { LedgerEntry } from "./ledger.js";
import type { LedgerStore } from "./store.js";
import { LedgerProjection, LedgerStoreError } from "./store.js";

/**
 * Version 4 adds `expiresAt` to `payment.reserved` and the `payment.extended`
 * event; version 3 added `decision`; version 2 added `intent`.
 *
 * Formats evolve through addition, never mutation. Older events replay with
 * the newer fields absent and read as "unknown" (`intent: ""`,
 * `decision: null`) rather than failing to load. Unknown is always treated as
 * the cautious case: an uncomparable fingerprint falls back to plain duplicate
 * detection, and a missing decision is reported as missing rather than
 * re-derived, because re-evaluating now would answer a different question.
 */
export const LEDGER_SCHEMA: SchemaRef = { id: "allowance.payment.ledger", version: 4 };

export const RESERVED = "payment.reserved";
export const SETTLED = "payment.settled";
export const REVERSED = "payment.reversed";
export const EXTENDED = "payment.extended";

interface ReservedPayload {
  readonly requestId: string;
  readonly account: string;
  readonly asset: string;
  /** Decimal string; `bigint` is not representable in an event. */
  readonly amount: string;
  readonly destination: string;
  readonly requester: Requester;
  readonly at: number;
  /** Absent on v1 events. */
  readonly intent?: string;
  /** Absent before v3. */
  readonly decision?: Decision;
  /** Absent before v4. */
  readonly expiresAt?: number | null;
}

interface ExtendedPayload {
  readonly requestId: string;
  readonly expiresAt: number;
}

interface SettledPayload {
  readonly requestId: string;
  readonly actualAmount: string;
}

interface ReversedPayload {
  readonly requestId: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * Reads a recorded decision, or `null` when there is nothing usable.
 *
 * Only shape is checked, not contents: this is our own event, written by this
 * package, so a deep validator here would be re-verifying our own output. A
 * pre-v3 event, or anything unrecognisable, reads as absent rather than
 * throwing — history that cannot be loaded is worse than history with a gap.
 */
function readDecision(value: unknown): Decision | null {
  if (!isRecord(value)) return null;
  return typeof value["outcome"] === "string" ? (value as unknown as Decision) : null;
}

/** The request a ledger event concerns, or `null` if it is not a ledger event. */
export function requestIdOf(event: JournalEvent): string | null {
  if (event.schema.id !== LEDGER_SCHEMA.id) return null;
  if (!isRecord(event.payload)) return null;
  const id = event.payload["requestId"];
  return typeof id === "string" ? id : null;
}

/**
 * Applies one journal event to the projection.
 *
 * Replicated history is other devices' history, and a lane that has been
 * truncated or partially replicated can legitimately contain a `settled`
 * whose `reserved` has not arrived. That is a gap in replication, not
 * corruption, so an orphan is skipped rather than thrown — refusing to open
 * would make a partially-synced device unusable.
 */
export function applyLedgerEvent(projection: LedgerProjection, event: JournalEvent): boolean {
  if (event.schema.id !== LEDGER_SCHEMA.id) return false;
  if (!isRecord(event.payload)) return false;
  const payload = event.payload;

  switch (event.type) {
    case RESERVED: {
      const p = payload as unknown as ReservedPayload;
      if (projection.find(p.requestId) !== undefined) return false;
      projection.reserve({
        requestId: p.requestId,
        account: p.account,
        asset: p.asset,
        amount: BigInt(p.amount),
        destination: p.destination,
        requester: p.requester,
        at: p.at,
        state: "PENDING",
        // A v1 event has none. Unknown, never guessed at.
        intent: typeof p.intent === "string" ? p.intent : "",
        decision: readDecision(p.decision),
        // Absent before v4, and absent means no deadline -- the behaviour
        // every reservation had before deadlines existed.
        expiresAt: typeof p.expiresAt === "number" ? p.expiresAt : null,
      });
      return true;
    }
    case SETTLED: {
      const p = payload as unknown as SettledPayload;
      if (projection.find(p.requestId) === undefined) return false;
      projection.settle(p.requestId, BigInt(p.actualAmount));
      return true;
    }
    case REVERSED: {
      const p = payload as unknown as ReversedPayload;
      if (projection.find(p.requestId) === undefined) return false;
      projection.reverse(p.requestId);
      return true;
    }
    case EXTENDED: {
      const p = payload as unknown as ExtendedPayload;
      const entry = projection.find(p.requestId);
      // An extension of something already finished is a replicated ordering
      // artefact, not corruption -- skipped rather than thrown, like an orphan.
      if (entry === undefined || entry.state !== "PENDING") return false;
      projection.extend(p.requestId, p.expiresAt);
      return true;
    }
    default:
      return false;
  }
}

export interface JournalLedgerStoreOptions {
  readonly journal: Journal;
}

/**
 * A durable, replayable, multi-device ledger.
 *
 * Reads are served from an in-memory projection so the guard's critical
 * section costs no I/O to decide; writes go to the journal and are durable
 * before they resolve. The projection is only ever advanced by the journal's
 * own listener, so local appends and replicated events take the identical path
 * and cannot diverge.
 */
export class JournalLedgerStore implements LedgerStore {
  readonly #journal: Journal;
  readonly #projection = new LedgerProjection();
  /**
   * The events behind each request, kept so a receipt can carry its own
   * evidence. Holding references costs nothing — the events are immutable and
   * already in memory — and it saves a receipt from rescanning history.
   */
  readonly #facts = new Map<string, JournalEvent[]>();
  #unsubscribe: (() => void) | null = null;

  private constructor(journal: Journal) {
    this.#journal = journal;
  }

  /** Rebuilds the ledger from history, then follows the journal for new facts. */
  static async open(options: JournalLedgerStoreOptions): Promise<JournalLedgerStore> {
    const store = new JournalLedgerStore(options.journal);
    const history = orderEvents(await options.journal.readAll());
    for (const event of history) store.#apply(event);
    store.#unsubscribe = options.journal.subscribe((events) => {
      for (const event of events) store.#apply(event);
    });
    return store;
  }

  #apply(event: JournalEvent): void {
    if (!applyLedgerEvent(this.#projection, event)) return;
    const requestId = requestIdOf(event);
    if (requestId === null) return;
    const existing = this.#facts.get(requestId);
    if (existing) existing.push(event);
    else this.#facts.set(requestId, [event]);
  }

  /**
   * The journal events behind one request, in the order they were applied.
   *
   * This is the evidence a receipt carries: each event still hashes to its own
   * contents, so a reader can check nothing was edited after the fact without
   * needing the rest of the lane.
   */
  factsFor(requestId: string): readonly JournalEvent[] {
    return this.#facts.get(requestId) ?? [];
  }

  /** Stops following the journal. The journal itself is the caller's to close. */
  close(): void {
    this.#unsubscribe?.();
    this.#unsubscribe = null;
  }

  /** Entries currently projected. Diagnostics only. */
  get size(): number {
    return this.#projection.size;
  }

  async entries(account: string): Promise<readonly LedgerEntry[]> {
    return this.#projection.entries(account);
  }

  async find(requestId: string): Promise<LedgerEntry | undefined> {
    return this.#projection.find(requestId);
  }

  async append(entry: LedgerEntry): Promise<void> {
    // Checked before writing, because an append is permanent. A duplicate that
    // reached history could never be taken back.
    if (this.#projection.find(entry.requestId) !== undefined) {
      throw new LedgerStoreError(`duplicate reservation for ${entry.requestId}`);
    }
    const payload: ReservedPayload = {
      requestId: entry.requestId,
      account: entry.account,
      asset: entry.asset,
      amount: entry.amount.toString(10),
      destination: entry.destination,
      requester: entry.requester,
      at: entry.at,
      intent: entry.intent,
      ...(entry.decision === null ? {} : { decision: entry.decision }),
      ...(entry.expiresAt === null ? {} : { expiresAt: entry.expiresAt }),
    };
    await this.#journal.appendOne({ type: RESERVED, schema: LEDGER_SCHEMA, payload });
  }

  async settle(requestId: string, actualAmount: Amount): Promise<void> {
    this.#requireOpen(requestId);
    if (actualAmount < 0n) {
      throw new LedgerStoreError(`settled amount is negative for ${requestId}`);
    }
    const payload: SettledPayload = { requestId, actualAmount: actualAmount.toString(10) };
    await this.#journal.appendOne({ type: SETTLED, schema: LEDGER_SCHEMA, payload });
  }

  async reverse(requestId: string): Promise<void> {
    this.#requireOpen(requestId);
    const payload: ReversedPayload = { requestId };
    await this.#journal.appendOne({ type: REVERSED, schema: LEDGER_SCHEMA, payload });
  }

  async extend(requestId: string, expiresAt: number): Promise<void> {
    this.#requireOpen(requestId);
    const payload: ExtendedPayload = { requestId, expiresAt };
    await this.#journal.appendOne({ type: EXTENDED, schema: LEDGER_SCHEMA, payload });
  }

  async staleReservations(asOf: number, ageMs: number): Promise<readonly LedgerEntry[]> {
    return this.#projection.staleReservations(asOf, ageMs);
  }

  async expired(now: number, graceMs: number): Promise<readonly LedgerEntry[]> {
    return this.#projection.expired(now, graceMs);
  }

  #requireOpen(requestId: string): void {
    const entry = this.#projection.find(requestId);
    if (entry === undefined) throw new LedgerStoreError(`no reservation for ${requestId}`);
    if (entry.state !== "PENDING") {
      // Settling twice would append a second fact contradicting the first.
      // History cannot be corrected, so the write is refused instead.
      throw new LedgerStoreError(`${requestId} is already ${entry.state}`);
    }
  }
}
