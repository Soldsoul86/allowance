/**
 * Where reservations live.
 *
 * ## A correction, stated plainly
 *
 * The first version of this file made every method synchronous and argued that
 * synchrony was what made the guard's critical section safe. That was half
 * right. Synchrony is *sufficient* for atomicity on a single-threaded runtime
 * — but it is not *necessary*, and it buys atomicity at the price of
 * durability, because a durable append cannot be synchronous.
 *
 * The invariant was never "the critical section is synchronous". It is:
 *
 * > **Read, decide and reserve must not interleave with another caller doing
 * > the same, and the reservation must be durable before the operation runs.**
 *
 * A lock delivers both; synchrony delivers only the first. So the store is
 * asynchronous and {@link SpendGuard} serialises through a promise chain —
 * the same mechanism the Journal itself uses to keep its hash chain intact.
 *
 * Losing a reservation is not like losing an audit line. The executor's audit
 * sink deliberately does not await the journal, because a dropped record is
 * recovered by reconciling against the exchange. A dropped *reservation* is
 * different: it silently returns budget that may already have been spent, and
 * nothing outside the ledger knows it existed.
 */
import type { Amount } from "./model.js";
import type { LedgerEntry } from "./ledger.js";
import { isExpired } from "./ledger.js";

export interface LedgerStore {
  /** Every entry for an account, in any order. */
  entries(account: string): Promise<readonly LedgerEntry[]>;
  find(requestId: string): Promise<LedgerEntry | undefined>;
  /** Records a new reservation, durably. Throws if the request id is already known. */
  append(entry: LedgerEntry): Promise<void>;
  /** Records what was actually spent. */
  settle(requestId: string, actualAmount: Amount): Promise<void>;
  /** Records that the spend provably did not happen. */
  reverse(requestId: string): Promise<void>;
  /** Pushes a reservation's deadline out. Only meaningful while PENDING. */
  extend(requestId: string, expiresAt: number): Promise<void>;
  /** Reservations past their own deadline, allowing for a grace period. */
  expired(now: number, graceMs: number): Promise<readonly LedgerEntry[]>;
  /** Reservations still open at `asOf` that were made more than `ageMs` ago. */
  staleReservations(asOf: number, ageMs: number): Promise<readonly LedgerEntry[]>;
}

export class LedgerStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LedgerStoreError";
  }
}

/**
 * The projection every store maintains.
 *
 * Kept separate from storage so the journal-backed store and the in-memory one
 * agree on what a sequence of ledger facts means — one definition of the fold,
 * not two that can drift.
 */
export class LedgerProjection {
  readonly #byId = new Map<string, LedgerEntry>();

  entries(account: string): readonly LedgerEntry[] {
    const out: LedgerEntry[] = [];
    for (const entry of this.#byId.values()) {
      if (entry.account === account) out.push(entry);
    }
    return out;
  }

  find(requestId: string): LedgerEntry | undefined {
    return this.#byId.get(requestId);
  }

  get size(): number {
    return this.#byId.size;
  }

  reserve(entry: LedgerEntry): void {
    if (this.#byId.has(entry.requestId)) {
      throw new LedgerStoreError(`duplicate reservation for ${entry.requestId}`);
    }
    this.#byId.set(entry.requestId, entry);
  }

  settle(requestId: string, actualAmount: Amount): void {
    const entry = this.#require(requestId);
    if (actualAmount < 0n) {
      throw new LedgerStoreError(`settled amount is negative for ${requestId}`);
    }
    // The recorded amount becomes what actually happened, not what was
    // authorized. A ledger that keeps the estimate drifts from reality, and
    // every later budget decision inherits the drift.
    this.#byId.set(requestId, { ...entry, amount: actualAmount, state: "SETTLED" });
  }

  reverse(requestId: string): void {
    const entry = this.#require(requestId);
    this.#byId.set(requestId, { ...entry, state: "REVERSED" });
  }

  extend(requestId: string, expiresAt: number): void {
    const entry = this.#require(requestId);
    if (entry.state !== "PENDING") {
      throw new LedgerStoreError(`${requestId} is already ${entry.state}`);
    }
    this.#byId.set(requestId, { ...entry, expiresAt });
  }

  expired(now: number, graceMs: number): readonly LedgerEntry[] {
    const out: LedgerEntry[] = [];
    for (const entry of this.#byId.values()) {
      if (isExpired(entry, now, graceMs)) out.push(entry);
    }
    return out;
  }

  staleReservations(asOf: number, ageMs: number): readonly LedgerEntry[] {
    const out: LedgerEntry[] = [];
    for (const entry of this.#byId.values()) {
      if (entry.state === "PENDING" && asOf - entry.at > ageMs) out.push(entry);
    }
    return out;
  }

  #require(requestId: string): LedgerEntry {
    const entry = this.#byId.get(requestId);
    if (entry === undefined) throw new LedgerStoreError(`no reservation for ${requestId}`);
    return entry;
  }
}

/**
 * An in-process store.
 *
 * History dies with the process, so a reservation does not survive a restart
 * and two processes do not share a budget. Fine for a test or a single
 * short-lived run; use {@link JournalLedgerStore} for anything that must
 * remember.
 */
export class MemoryLedgerStore implements LedgerStore {
  readonly #projection = new LedgerProjection();

  async entries(account: string): Promise<readonly LedgerEntry[]> {
    return this.#projection.entries(account);
  }
  async find(requestId: string): Promise<LedgerEntry | undefined> {
    return this.#projection.find(requestId);
  }
  async append(entry: LedgerEntry): Promise<void> {
    this.#projection.reserve(entry);
  }
  async settle(requestId: string, actualAmount: Amount): Promise<void> {
    this.#projection.settle(requestId, actualAmount);
  }
  async reverse(requestId: string): Promise<void> {
    this.#projection.reverse(requestId);
  }
  async extend(requestId: string, expiresAt: number): Promise<void> {
    this.#projection.extend(requestId, expiresAt);
  }
  async expired(now: number, graceMs: number): Promise<readonly LedgerEntry[]> {
    return this.#projection.expired(now, graceMs);
  }
  async staleReservations(asOf: number, ageMs: number): Promise<readonly LedgerEntry[]> {
    return this.#projection.staleReservations(asOf, ageMs);
  }
}
