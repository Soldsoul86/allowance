/**
 * The relation a zero-knowledge circuit would enforce — written in plain code.
 *
 * ## THIS IS STILL NOT ZERO-KNOWLEDGE
 *
 * `IS_ZERO_KNOWLEDGE` is exported as `false` and a test asserts it. A
 * {@link BudgetProofBundle} **contains its witness in the clear.** It is the
 * statement and the test oracle a real circuit needs, not the proof.
 *
 * What changed is soundness, not privacy: the completeness gap this file used
 * to report as an unchecked assumption is now constraint **C6**.
 *
 * ## How the gap closed
 *
 * The old witness was a set of ledger entries, and the prover chose which to
 * supply. A Merkle tree proves membership, so omitting an in-window entry
 * produced a smaller sum with every proof still checking.
 *
 * The fix was not more cryptography. It was taking the choice away.
 * `BucketCommitment` is a dense array of per-bucket totals, so position `p` in
 * the tree *is* bucket `baseIndex + p` and nothing else can sit there. The
 * verifier computes the covered bucket range **from the public statement
 * alone** and demands exactly those leaves at exactly those positions. A
 * missing bucket is a hole the verifier was already looking at; an invented
 * one lands at the wrong position.
 *
 * ## The statement
 *
 * Public:
 *   policyDigest     which rules were in force (not what they say)
 *   commitment       root, account, asset, bucket size and range
 *   requestDigest    which payment
 *   requestedAt      when
 *   claimedOutcome   ALLOW
 *
 * Private:
 *   policy           including the limits, which stay secret
 *   request          the amount and destination
 *   buckets          per-bucket totals — never the individual payments
 *
 * The limit stays private, and so does every individual transaction. What
 * leaks is coarser than before: bucket totals rather than entries, and only
 * for the window in question.
 *
 * ## The constraints
 *
 * C1  hash(policy) == policyDigest                  binds the rules
 * C2  hash(request) == requestDigest                binds the payment
 * C3  request.requestedAt == statement.requestedAt  binds the time
 * C4  each leaf is included under the root          Merkle path check
 * C5  each leaf's key matches its position          binds leaf to bucket
 * C6  the leaves are exactly the covered range      **completeness**
 * C7  sum + amount <= maxTotal                      addition, one comparison
 *
 * C4 still dominates. A SHA-256 path is tens of thousands of constraints per
 * step, so a real circuit swaps in a field-native hash (Poseidon, Rescue) and
 * the tree is rebuilt with it. C5, C6 and C7 are integer comparisons and
 * nearly free.
 *
 * ## What remains assumed, and why it is a much smaller thing
 *
 * The committer must have totalled honestly. That is *not* the old gap: it is
 * a deterministic function of the ledger, so anyone holding the ledger can
 * rebuild the commitment and compare roots — `commitmentMatchesLedger` does
 * exactly that. A counterparty who cannot see the ledger discharges it the
 * ordinary way instead: the root is signed, published, or anchored before the
 * fact, so it cannot be rewritten afterwards.
 *
 * The difference matters. The old assumption could be broken silently by
 * anyone, with no artefact left behind. This one requires publishing a false
 * root and then being unable to produce a ledger that matches it.
 */
import type { SpendRequest } from "./model.js";
import type { SpendPolicy } from "./policy.js";
import { policyDigest } from "./policy.js";
import { digestOf } from "./wire.js";
import type { InclusionProof } from "./commitment.js";
import { verifyInclusion } from "./commitment.js";
import type { BucketCommitment, BucketLeaf } from "./buckets.js";
import { MAX_BUCKETS, coveringBuckets } from "./buckets.js";

/** Exported so the claim sits somewhere type-checked, not only in prose. */
export const IS_ZERO_KNOWLEDGE = false;

/** The commitment parameters, as the public half sees them. */
export interface CommitmentStatement {
  readonly root: string;
  readonly account: string;
  readonly asset: string;
  readonly bucketMs: number;
  readonly from: number;
  readonly to: number;
}

export interface BudgetStatement {
  readonly policyDigest: string;
  readonly commitment: CommitmentStatement;
  readonly requestDigest: string;
  readonly requestedAt: number;
  readonly claimedOutcome: "ALLOW";
}

export interface WitnessBucket {
  readonly leaf: BucketLeaf;
  readonly inclusion: InclusionProof;
}

/** Everything a real circuit would hide. Present here, in the clear. */
export interface BudgetWitness {
  readonly policy: SpendPolicy;
  readonly request: SpendRequest;
  /** The rule being proven against; must be a `WINDOW_BUDGET` in `policy`. */
  readonly ruleId: string;
  /** Exactly the buckets covering the window, in order. */
  readonly buckets: readonly WitnessBucket[];
}

/**
 * A statement and the witness for it.
 *
 * A bundle, not a proof: a proof is the thing you hand over *instead of* the
 * witness, and this is not that.
 */
export interface BudgetProofBundle {
  readonly statement: BudgetStatement;
  readonly witness: BudgetWitness;
}

export type ConstraintId = "C1" | "C2" | "C3" | "C4" | "C5" | "C6" | "C7";

export interface ConstraintResult {
  readonly id: ConstraintId;
  readonly name: string;
  readonly satisfied: boolean;
  readonly detail: string;
}

export interface RelationResult {
  readonly satisfied: boolean;
  readonly constraints: readonly ConstraintResult[];
  /** What the relation still takes on trust. Reported apart from constraints. */
  readonly assumptions: readonly string[];
  /** Always false here. See the file header. */
  readonly zeroKnowledge: boolean;
}

const ok = (id: ConstraintId, name: string, detail: string): ConstraintResult => ({
  id, name, satisfied: true, detail,
});
const bad = (id: ConstraintId, name: string, detail: string): ConstraintResult => ({
  id, name, satisfied: false, detail,
});

const REMAINING_ASSUMPTION =
  "FAITHFUL TOTALLING: the committer is assumed to have summed the ledger " +
  "correctly into buckets. Unlike the completeness gap this replaced, it is a " +
  "deterministic function of the ledger — anyone holding it can rebuild the " +
  "commitment and compare roots (commitmentMatchesLedger), and a counterparty " +
  "who cannot see it relies on the root being signed or published beforehand.";

/**
 * Evaluates the relation exactly as a circuit would, over revealed values.
 *
 * Total: every failure is an unsatisfied constraint, never an exception. A
 * constraint system cannot throw, so neither may its reference implementation
 * — otherwise the two disagree on malformed input, which is precisely where a
 * circuit gets attacked.
 */
export function checkBudgetRelation(bundle: BudgetProofBundle): RelationResult {
  const { statement, witness } = bundle;
  const constraints: ConstraintResult[] = [];

  /* C1 — the rules in force are the ones named, without revealing them. */
  const computedPolicy = policyDigest(witness.policy);
  constraints.push(
    computedPolicy === statement.policyDigest
      ? ok("C1", "policy binding", `policy hashes to ${computedPolicy.slice(0, 12)}`)
      : bad("C1", "policy binding", "witness policy does not hash to the stated digest"),
  );

  /* C2 — the payment is the one named. */
  const computedRequest = digestOf(witness.request);
  constraints.push(
    computedRequest === statement.requestDigest
      ? ok("C2", "request binding", `request hashes to ${computedRequest.slice(0, 12)}`)
      : bad("C2", "request binding", "witness request does not hash to the stated digest"),
  );

  /* C3 — the instant is the one named. Windows are measured from it. */
  constraints.push(
    witness.request.requestedAt === statement.requestedAt
      ? ok("C3", "time binding", `evaluated at ${statement.requestedAt}`)
      : bad("C3", "time binding", "request time disagrees with the statement"),
  );

  const rule = witness.policy.rules.find(
    (r) => r.id === witness.ruleId && r.kind === "WINDOW_BUDGET",
  );
  if (rule === undefined || rule.kind !== "WINDOW_BUDGET") {
    for (const id of ["C4", "C5", "C6", "C7"] as const) {
      constraints.push(bad(id, "rule", `no WINDOW_BUDGET rule named ${witness.ruleId}`));
    }
    return finish(constraints);
  }
  if (rule.asset !== statement.commitment.asset) {
    for (const id of ["C4", "C5", "C6", "C7"] as const) {
      constraints.push(
        bad(id, "rule", `rule budgets ${rule.asset}, commitment covers ${statement.commitment.asset}`),
      );
    }
    return finish(constraints);
  }

  /* The covered range is computed from public values only. That is what makes
     completeness something the verifier imposes, not something the prover
     asserts. */
  const required = coveringBuckets(
    statement.requestedAt,
    rule.windowMs,
    statement.commitment.bucketMs,
  );
  const requiredCount = required.to - required.from + 1;

  if (requiredCount > MAX_BUCKETS) {
    for (const id of ["C4", "C5", "C6", "C7"] as const) {
      constraints.push(bad(id, "size", `window needs ${requiredCount} buckets, circuit fits ${MAX_BUCKETS}`));
    }
    return finish(constraints);
  }

  /* C4 — every supplied leaf really is under the stated root. */
  const notIncluded = witness.buckets.filter(
    (b) => !verifyInclusion(b.leaf, b.inclusion, statement.commitment.root),
  );
  constraints.push(
    notIncluded.length === 0
      ? ok("C4", "inclusion", `${witness.buckets.length} leaf/leaves proven under the root`)
      : bad("C4", "inclusion", `${notIncluded.length} leaf/leaves are not under the stated root`),
  );

  /* C5 — each leaf is the bucket its position says it is, from this very
     commitment. Without this a leaf could be lifted from another tree with
     different parameters and still prove inclusion in its own. */
  const misKeyed = witness.buckets.filter(
    (b) =>
      b.leaf.account !== statement.commitment.account ||
      b.leaf.asset !== statement.commitment.asset ||
      b.leaf.bucketMs !== statement.commitment.bucketMs ||
      b.leaf.index !== statement.commitment.from + b.inclusion.index,
  );
  constraints.push(
    misKeyed.length === 0
      ? ok("C5", "leaf keying", "every leaf matches its position and the commitment")
      : bad("C5", "leaf keying", `${misKeyed.length} leaf/leaves do not match their position`),
  );

  /* C6 — completeness. The leaves are exactly the covered range, in order,
     no gaps and no repeats. This is the constraint that used to be a hope. */
  constraints.push(coverageCheck(witness.buckets, required, statement));

  /* C7 — the sum, plus this payment, is inside the private limit. */
  let spent = 0n;
  for (const b of witness.buckets) spent += b.leaf.total;
  const projected = spent + witness.request.amount;
  constraints.push(
    projected <= rule.maxTotal
      ? ok("C7", "budget", `${projected} within the limit`)
      : bad("C7", "budget", `${projected} exceeds the limit`),
  );

  return finish(constraints);
}

function coverageCheck(
  buckets: readonly WitnessBucket[],
  required: { from: number; to: number },
  statement: BudgetStatement,
): ConstraintResult {
  const requiredCount = required.to - required.from + 1;

  if (statement.commitment.from > required.from || statement.commitment.to < required.to) {
    return bad(
      "C6",
      "completeness",
      `commitment covers [${statement.commitment.from}, ${statement.commitment.to}], ` +
        `window needs [${required.from}, ${required.to}]`,
    );
  }
  if (buckets.length !== requiredCount) {
    return bad(
      "C6",
      "completeness",
      `window covers ${requiredCount} bucket(s), witness supplies ${buckets.length}`,
    );
  }

  // Exactly one leaf per required index, no gaps and no repeats.
  const seen = new Set<number>();
  for (const b of buckets) {
    if (b.leaf.index < required.from || b.leaf.index > required.to) {
      return bad("C6", "completeness", `bucket ${b.leaf.index} is outside the covered window`);
    }
    if (seen.has(b.leaf.index)) {
      return bad("C6", "completeness", `bucket ${b.leaf.index} supplied more than once`);
    }
    seen.add(b.leaf.index);
  }
  if (seen.size !== requiredCount) {
    return bad("C6", "completeness", `missing ${requiredCount - seen.size} bucket(s)`);
  }

  return ok(
    "C6",
    "completeness",
    `buckets [${required.from}, ${required.to}] all present — omission is not possible`,
  );
}

function finish(constraints: readonly ConstraintResult[]): RelationResult {
  return {
    satisfied: constraints.every((c) => c.satisfied),
    constraints,
    assumptions: [REMAINING_ASSUMPTION],
    zeroKnowledge: IS_ZERO_KNOWLEDGE,
  };
}

/**
 * Assembles an honest bundle from a commitment.
 *
 * Provided so the ordinary path does not require hand-building a witness: the
 * easiest thing to do should be the correct thing, and a hand-assembled
 * witness is where an accidental omission would come from.
 */
export function buildBudgetBundle(input: {
  readonly policy: SpendPolicy;
  readonly request: SpendRequest;
  readonly ruleId: string;
  readonly commitment: BucketCommitment;
  readonly windowMs: number;
}): BudgetProofBundle | null {
  const required = coveringBuckets(
    input.request.requestedAt,
    input.windowMs,
    input.commitment.bucketMs,
  );
  const opened = input.commitment.openRange(required);
  if (opened === null) return null;

  return {
    statement: {
      policyDigest: policyDigest(input.policy),
      commitment: {
        root: input.commitment.root,
        account: input.commitment.account,
        asset: input.commitment.asset,
        bucketMs: input.commitment.bucketMs,
        from: input.commitment.from,
        to: input.commitment.to,
      },
      requestDigest: digestOf(input.request),
      requestedAt: input.request.requestedAt,
      claimedOutcome: "ALLOW",
    },
    witness: {
      policy: input.policy,
      request: input.request,
      ruleId: input.ruleId,
      buckets: opened.map((o) => ({ leaf: o.leaf, inclusion: o.inclusion })),
    },
  };
}

/** A short report that never lets the reader forget what this is. */
export function explainRelation(result: RelationResult): string {
  const header = result.satisfied
    ? "RELATION HOLDS  (not a zero-knowledge proof — the witness is revealed)"
    : "RELATION FAILS";
  const body = result.constraints
    .map((c) => `  ${c.satisfied ? "ok  " : "FAIL"}  ${c.id}  ${c.name}\n        ${c.detail}`)
    .join("\n");
  const assumed = result.assumptions.map((a) => `  ASSUMED  ${a}`).join("\n");
  return `${header}\n${body}\n${assumed}`;
}

