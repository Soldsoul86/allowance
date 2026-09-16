/**
 * What has already been spent.
 *
 * The ledger is the input that makes a windowed limit meaningful, and it holds
 * the single most important correctness property in this package:
 *
 * > **Money committed but not yet settled still consumes its budget.**
 *
 * If only settled spend counted, ten requests fired in the same millisecond
 * would each observe an empty budget and each be allowed, and a daily cap of
 * $100 would release $1,000. That is the payments equivalent of a double
 * spend, and it is the same hazard the executor's `claimExit` exists to
 * prevent: a decision made against state that another in-flight decision has
 * already changed.
 *
 * So a `PENDING` entry counts exactly as much as a `SETTLED` one. Only a
 * `REVERSED` entry — a payment that provably did not happen — gives its
 * budget back.
 */
import type { Amount, AssetId, Requester } from "./model.js";
import { requesterKey } from "./model.js";
// Type-only, so it erases entirely under `verbatimModuleSyntax` and the
// apparent cycle with `evaluate.ts` never exists at runtime.
import type { Decision } from "./evaluate.js";

/**
 * Where a spend stands.
 *
 * `PENDING` covers everything between authorization and confirmation: signed,
 * broadcast, in a mempool, awaiting confirmations. Constitution Art. XI §42 —
 * an issued action never updates reality until a sensor confirms it — is why
 * this state exists at all rather than jumping straight to settled.
 */
export type LedgerState = "PENDING" | "SETTLED" | "REVERSED";

export interface LedgerEntry {
  readonly requestId: string;
  readonly account: string;
  readonly asset: AssetId;
  readonly amount: Amount;
  readonly destination: string;
  readonly requester: Requester;
  /** When the spend was authorized, not when it settled. Windows are measured from intent. */
  readonly at: number;
  readonly state: LedgerState;
  /**
   * Fingerprint of the request that opened this reservation, from
   * {@link requestIntent}.
   *
   * Set once at reservation and never touched by settlement — `amount` becomes
   * what was actually spent, so it cannot serve as the record of what was
   * *asked for*.
   *
   * `""` means unknown: an entry replayed from history written before
   * fingerprints existed. A retry against one of those cannot be checked for
   * mismatch, so it is treated as an ordinary duplicate — no worse than the
   * behaviour it replaces, and it never silently passes a changed request as a
   * matching one.
   */
  readonly intent: string;
  /**
   * The decision that authorised this reservation.
   *
   * Kept because a retry deserves the answer it was given the first time, not
   * a fresh evaluation against a ledger that has moved on. Storing it here
   * rather than in a second event is deliberate: a reservation exists
   * *because* a decision allowed it, and two events that can never appear
   * separately are one event pretending to be two.
   *
   * `null` means unknown — an entry replayed from history written before
   * decisions were recorded.
   */
  readonly decision: Decision | null;
  /**
   * When this reservation stops being expected to complete. `null` never.
   *
   * A deadline, not a settlement. See {@link isExpired}.
   */
  readonly expiresAt: number | null;
}

/**
 * Is this reservation past its deadline?
 *
 * **Expiry is derived, never recorded.** Nothing happens when a deadline
 * passes — a settlement simply fails to arrive — so there is no fact to
 * append. Writing a `payment.expired` event would be journalling the passage
 * of time, which history already knows.
 *
 * More importantly, expiry does **not** release the budget. Art. XI §42 does
 * not stop applying because a timer fired: a reservation that outlived its TTL
 * is the indeterminate case, not the didn't-happen case. If the provider
 * charged before the client died, releasing here hands back budget for money
 * that was spent — which is why {@link consumesBudget} ignores deadlines
 * entirely.
 *
 * What expiry does is direct attention. It says "nobody is coming back for
 * this, go and find out", and finding out is the reconciler's job.
 *
 * `graceMs` covers the race where a legitimate settlement is already in flight
 * as the deadline passes.
 */
export function isExpired(entry: LedgerEntry, now: number, graceMs = 0): boolean {
  if (entry.state !== "PENDING") return false;
  if (entry.expiresAt === null) return false;
  return now > entry.expiresAt + graceMs;
}

/**
 * Does this entry still hold budget?
 *
 * Deliberately blind to deadlines. An expired reservation holds its budget
 * exactly as a live one does, because a passed deadline is not evidence that
 * nothing was spent. Only `REVERSED` — a spend *proven* not to have happened —
 * gives budget back.
 */
export function consumesBudget(entry: LedgerEntry): boolean {
  return entry.state !== "REVERSED";
}

export interface WindowQuery {
  /** Inclusive lower bound. */
  readonly from: number;
  /** Inclusive upper bound — the instant being evaluated. */
  readonly to: number;
  /** Requester keys to count. `null` counts every requester. */
  readonly requesters: readonly string[] | null;
  /** Exclude this request, so re-evaluating an in-flight request is idempotent. */
  readonly excludeRequestId: string;
}

function inWindow(entry: LedgerEntry, query: WindowQuery): boolean {
  if (!consumesBudget(entry)) return false;
  if (entry.requestId === query.excludeRequestId) return false;
  if (entry.at < query.from || entry.at > query.to) return false;
  if (query.requesters !== null && !query.requesters.includes(requesterKey(entry.requester))) {
    return false;
  }
  return true;
}

/** Total of one asset spent in a window. */
export function spentWithin(
  entries: readonly LedgerEntry[],
  asset: AssetId,
  query: WindowQuery,
): Amount {
  let total = 0n;
  for (const entry of entries) {
    if (entry.asset === asset && inWindow(entry, query)) total += entry.amount;
  }
  return total;
}

/** Number of spends in a window, across all assets. */
export function countWithin(entries: readonly LedgerEntry[], query: WindowQuery): number {
  let count = 0;
  for (const entry of entries) {
    if (inWindow(entry, query)) count += 1;
  }
  return count;
}
