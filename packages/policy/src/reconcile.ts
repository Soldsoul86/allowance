/**
 * Closing the loop.
 *
 * The guard deliberately refuses to guess whether a failed operation spent
 * money: from inside a `catch`, a connection reset before dispatch and a lost
 * response after the vendor charged look identical. That refusal is correct,
 * and on its own it is not enough — a system that only accumulates
 * unresolvable reservations is honestly stuck rather than safe.
 *
 * Constitution Art. XI §42 says how it ends: *the runtime loop closes only
 * when a Sensor confirms that reality occurred as expected.* {@link
 * SpendObserver} is that sensor. It is the one component here that looks at
 * the outside world — a vendor's usage API, a billing export, a chain, a
 * human reading a statement — and reports what it found.
 *
 * The rule that makes this trustworthy is what happens on `UNKNOWN`: nothing.
 * The reservation stays open, keeps consuming budget, and is offered again
 * next sweep. A reconciler that resolved uncertainty by assumption would be
 * worse than no reconciler, because it would look authoritative while being
 * a guess.
 */
import type { Amount } from "./model.js";
import type { LedgerEntry } from "./ledger.js";
import type { LedgerStore } from "./store.js";

/** What a sensor found when it looked. */
export type SpendObservation =
  /** It happened, and this is what it really cost. */
  | { readonly state: "SETTLED"; readonly actualAmount: Amount }
  /** It provably did not happen. The budget goes back. */
  | { readonly state: "NOT_SPENT" }
  /** Still cannot tell. Say so; do not resolve it. */
  | { readonly state: "UNKNOWN" };

/**
 * The window onto reality for one reservation.
 *
 * Implementations are adapters: a vendor usage endpoint, a chain lookup, a
 * settlement file. An observer that cannot tell must return `UNKNOWN` rather
 * than a plausible number — a wrong confident answer is written into an
 * immutable ledger and cannot be taken back.
 */
export interface SpendObserver {
  observe(entry: LedgerEntry): Promise<SpendObservation>;
}

export interface ReconciliationReport {
  readonly examined: number;
  readonly settled: readonly { readonly requestId: string; readonly amount: Amount }[];
  readonly reversed: readonly string[];
  /** Still open, on purpose. */
  readonly unresolved: readonly LedgerEntry[];
  /** The observer itself failed. Also still open. */
  readonly failed: readonly { readonly requestId: string; readonly error: unknown }[];
}

export interface ReconcileOptions {
  readonly store: LedgerStore;
  readonly observer: SpendObserver;
  readonly asOf: number;
  /** Only reservations older than this are examined. */
  readonly ageMs: number;
  /**
   * Runs a ledger write under the guard's lock, so reconciliation cannot land
   * between another caller's read and its reservation.
   */
  readonly serialize?: <T>(work: () => Promise<T>) => Promise<T>;
}

/**
 * Examines every stale reservation and resolves the ones reality can answer.
 *
 * Observation happens outside the lock — a vendor call is slow and must not
 * block every decision in the process — and only the resulting write is
 * serialised.
 */
export async function reconcile(options: ReconcileOptions): Promise<ReconciliationReport> {
  const { store, observer, asOf, ageMs } = options;
  const run = options.serialize ?? (<T>(work: () => Promise<T>) => work());

  const open = await store.staleReservations(asOf, ageMs);

  const settled: { requestId: string; amount: Amount }[] = [];
  const reversed: string[] = [];
  const unresolved: LedgerEntry[] = [];
  const failed: { requestId: string; error: unknown }[] = [];

  for (const entry of open) {
    let observation: SpendObservation;
    try {
      observation = await observer.observe(entry);
    } catch (error) {
      // One unreachable vendor must not abandon the rest of the sweep.
      failed.push({ requestId: entry.requestId, error });
      continue;
    }

    try {
      switch (observation.state) {
        case "SETTLED":
          await run(() => store.settle(entry.requestId, observation.actualAmount));
          settled.push({ requestId: entry.requestId, amount: observation.actualAmount });
          break;
        case "NOT_SPENT":
          await run(() => store.reverse(entry.requestId));
          reversed.push(entry.requestId);
          break;
        case "UNKNOWN":
          unresolved.push(entry);
          break;
      }
    } catch (error) {
      // A write can still lose a race — the operation may have completed
      // between the sweep's read and this write. The reservation is no longer
      // ours to resolve, and the loser reports rather than overwrites.
      failed.push({ requestId: entry.requestId, error });
    }
  }

  return { examined: open.length, settled, reversed, unresolved, failed };
}
