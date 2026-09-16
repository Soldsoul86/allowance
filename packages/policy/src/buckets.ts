/**
 * Committing to totals instead of to entries.
 *
 * A Merkle tree over individual ledger entries proves membership and nothing
 * else. A prover who leaves one out produces a smaller sum, and every
 * inclusion proof still checks — the gap `circuit.ts` used to report as an
 * assumption.
 *
 * The fix is not more cryptography. It is taking away the prover's choice of
 * what to supply.
 *
 * ## One leaf per position, positions fixed by the window
 *
 * Time is cut into fixed buckets. The commitment is a **dense array** — one
 * leaf per bucket index, zero-filled where nothing was spent — so position `p`
 * in the tree *is* bucket `baseIndex + p`. Nothing else can sit there.
 *
 * A verifier then computes, from the public statement alone, exactly which
 * bucket indices a window covers. The prover must supply precisely those
 * leaves, at precisely those positions, each with an inclusion proof. Omitting
 * one leaves a hole the verifier is already looking at. Inventing one lands at
 * the wrong position. The prover no longer decides what counts.
 *
 * ## The edges are deliberately over-counted
 *
 * A rolling window rarely lands on a bucket boundary, so the first and last
 * buckets include a little time outside it. That makes the proven statement
 * *stronger* than the policy asks for: at most `windowMs + bucketMs` of spend
 * is bounded, rather than exactly `windowMs`.
 *
 * Over-counting can only refuse a payment that should have been allowed. It
 * can never allow one that should have been refused, which is the only
 * direction a budget may be wrong in. The cost is liveness, not safety, and it
 * shrinks as buckets do.
 *
 * ## Bucket size is the engineering dial
 *
 * Leaves per proof is `ceil(windowMs / bucketMs) + 1`. A 24-hour window at
 * hourly buckets is 25 leaves and over-counts by up to an hour; at one-minute
 * buckets it is 1,441 leaves, which no circuit wants. Smaller buckets buy a
 * tighter bound and cost proof size, and that trade is the caller's to make.
 */
import type { Amount, AssetId } from "./model.js";
import type { LedgerEntry } from "./ledger.js";
import { consumesBudget } from "./ledger.js";
import { LedgerCommitment, type InclusionProof } from "./commitment.js";

/** A circuit is fixed-size, and this bounds it. 512 forces a sane bucket. */
export const MAX_BUCKETS = 512;

/** Which bucket an instant falls in. */
export function bucketIndex(at: number, bucketMs: number): number {
  return Math.floor(at / bucketMs);
}

export interface BucketRange {
  readonly from: number;
  readonly to: number;
}

/**
 * The bucket indices a rolling window touches, inclusive at both ends.
 *
 * Derived from public values only — that is what makes it a constraint the
 * verifier imposes rather than a claim the prover makes.
 */
export function coveringBuckets(
  requestedAt: number,
  windowMs: number,
  bucketMs: number,
): BucketRange {
  return {
    from: bucketIndex(requestedAt - windowMs, bucketMs),
    to: bucketIndex(requestedAt, bucketMs),
  };
}

/**
 * One committed total.
 *
 * Carries its own key as well as its total, so a leaf lifted from one
 * commitment cannot be replayed into another with different parameters.
 */
export interface BucketLeaf {
  readonly account: string;
  readonly asset: AssetId;
  readonly bucketMs: number;
  readonly index: number;
  readonly total: Amount;
}

export interface BucketCommitmentParams {
  readonly account: string;
  readonly asset: AssetId;
  readonly bucketMs: number;
  readonly from: number;
  readonly to: number;
}

export class BucketCommitmentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BucketCommitmentError";
  }
}

/**
 * A dense, zero-filled commitment to per-bucket totals.
 *
 * Dense is the whole point: a sparse structure would let the committer decide
 * which buckets exist, and the prover's choice is exactly what this removes.
 */
export class BucketCommitment {
  readonly account: string;
  readonly asset: AssetId;
  readonly bucketMs: number;
  readonly from: number;
  readonly to: number;

  readonly #tree: LedgerCommitment<BucketLeaf>;

  private constructor(params: BucketCommitmentParams, leaves: readonly BucketLeaf[]) {
    this.account = params.account;
    this.asset = params.asset;
    this.bucketMs = params.bucketMs;
    this.from = params.from;
    this.to = params.to;
    this.#tree = new LedgerCommitment(leaves);
  }

  /**
   * Totals every consuming entry into its bucket.
   *
   * Deterministic, and a pure function of the entries — so anyone holding the
   * ledger can rebuild this commitment and compare roots. That is what turns
   * "trust the committer" into "check the committer", for anyone entitled to
   * see the ledger at all.
   *
   * Entries outside `[from, to]`, in another asset, for another account, or
   * already reversed are excluded — the same three exclusions `evaluate`
   * applies, kept in one place so the two cannot drift.
   */
  static build(
    entries: readonly LedgerEntry[],
    params: BucketCommitmentParams,
  ): BucketCommitment {
    if (!Number.isFinite(params.bucketMs) || params.bucketMs <= 0) {
      throw new BucketCommitmentError("bucketMs must be positive");
    }
    if (!Number.isInteger(params.from) || !Number.isInteger(params.to) || params.to < params.from) {
      throw new BucketCommitmentError("bucket range is empty or not integral");
    }
    const size = params.to - params.from + 1;
    if (size > MAX_BUCKETS) {
      throw new BucketCommitmentError(`range spans ${size} buckets, limit is ${MAX_BUCKETS}`);
    }

    const totals = new Array<Amount>(size).fill(0n);
    for (const entry of entries) {
      if (entry.account !== params.account) continue;
      if (entry.asset !== params.asset) continue;
      if (!consumesBudget(entry)) continue;
      const index = bucketIndex(entry.at, params.bucketMs);
      if (index < params.from || index > params.to) continue;
      totals[index - params.from] = totals[index - params.from]! + entry.amount;
    }

    const leaves = totals.map((total, position) => ({
      account: params.account,
      asset: params.asset,
      bucketMs: params.bucketMs,
      index: params.from + position,
      total,
    }));

    return new BucketCommitment(params, leaves);
  }

  get root(): string {
    return this.#tree.root;
  }

  get size(): number {
    return this.to - this.from + 1;
  }

  /** The leaf and its proof for one bucket index, or `null` if out of range. */
  open(index: number): { readonly leaf: BucketLeaf; readonly inclusion: InclusionProof } | null {
    if (index < this.from || index > this.to) return null;
    const position = index - this.from;
    const leaf = this.#tree.values()[position];
    const inclusion = this.#tree.prove(position);
    if (leaf === undefined || inclusion === null) return null;
    return { leaf, inclusion };
  }

  /** Every leaf covering a range, in order, or `null` if the range is not covered. */
  openRange(range: BucketRange): readonly { leaf: BucketLeaf; inclusion: InclusionProof }[] | null {
    if (range.from < this.from || range.to > this.to) return null;
    const out: { leaf: BucketLeaf; inclusion: InclusionProof }[] = [];
    for (let i = range.from; i <= range.to; i++) {
      const opened = this.open(i);
      if (opened === null) return null;
      out.push(opened);
    }
    return out;
  }
}

/**
 * Rebuilds a commitment from a ledger and checks the root matches.
 *
 * The residual trust after bucketing is that the committer totalled honestly.
 * This discharges it for anyone holding the ledger — which is a real check
 * rather than a promise, and is why the remaining assumption is much smaller
 * than the one it replaced.
 */
export function commitmentMatchesLedger(
  commitment: BucketCommitment,
  entries: readonly LedgerEntry[],
): boolean {
  const rebuilt = BucketCommitment.build(entries, {
    account: commitment.account,
    asset: commitment.asset,
    bucketMs: commitment.bucketMs,
    from: commitment.from,
    to: commitment.to,
  });
  return rebuilt.root === commitment.root;
}
