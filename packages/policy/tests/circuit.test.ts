/**
 * The relation, now that completeness is a constraint rather than a hope.
 *
 * The previous version of this file ended with a test that *omitted* an
 * in-window entry and still satisfied every constraint — kept passing on
 * purpose, with a note that if the gap were ever closed it should start
 * failing. It has been closed, so that test is now inverted: omission is
 * caught, and the constraint that catches it is named.
 */
import { ok, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";

import type { BudgetProofBundle, LedgerEntry, SpendPolicy, SpendRequest } from "../src/index.js";
import {
  ANY_REQUESTER,
  BucketCommitment,
  IS_ZERO_KNOWLEDGE,
  buildBudgetBundle,
  checkBudgetRelation,
  commitmentMatchesLedger,
  coveringBuckets,
  evaluate,
} from "../src/index.js";

const HOUR = 3_600_000;
const DAY = 86_400_000;
/** Bucket-aligned, so window arithmetic is easy to reason about by hand. */
const T0 = Math.floor(Date.UTC(2026, 8, 16, 12, 0, 0) / HOUR) * HOUR;
const ACCOUNT = "acct:research-agent";
const TOKENS = "anthropic:tokens";

const policy: SpendPolicy = {
  account: ACCOUNT,
  version: 5,
  rules: [
    {
      id: "daily",
      kind: "WINDOW_BUDGET",
      scope: ANY_REQUESTER,
      asset: TOKENS,
      windowMs: DAY,
      maxTotal: 10_000n,
    },
  ],
};

const entry = (id: string, amount: bigint, at: number): LedgerEntry => ({
  requestId: id,
  account: ACCOUNT,
  asset: TOKENS,
  amount,
  destination: "vendor:api",
  requester: { kind: "AGENT", agentId: "researcher" },
  at,
  state: "SETTLED",
  intent: "",
  decision: null,
  expiresAt: null,
});

const request: SpendRequest = {
  requestId: "call-9",
  account: ACCOUNT,
  requester: { kind: "AGENT", agentId: "researcher" },
  asset: TOKENS,
  amount: 2_000n,
  destination: "vendor:api",
  requestedAt: T0,
  approvals: [],
  attestations: [],
  memo: null,
};

const RANGE = coveringBuckets(T0, DAY, HOUR);

function commit(entries: readonly LedgerEntry[]): BucketCommitment {
  return BucketCommitment.build(entries, {
    account: ACCOUNT,
    asset: TOKENS,
    bucketMs: HOUR,
    from: RANGE.from,
    to: RANGE.to,
  });
}

function bundle(
  entries: readonly LedgerEntry[] = [entry("a", 3_000n, T0 - HOUR), entry("b", 4_000n, T0 - 2 * HOUR)],
): BudgetProofBundle {
  const built = buildBudgetBundle({
    policy,
    request,
    ruleId: "daily",
    commitment: commit(entries),
    windowMs: DAY,
  });
  ok(built !== null, "bundle should assemble");
  return built;
}

const constraint = (b: BudgetProofBundle, id: string) =>
  checkBudgetRelation(b).constraints.find((c) => c.id === id);

describe("an honest bundle", () => {
  it("satisfies all seven constraints", () => {
    const result = checkBudgetRelation(bundle());
    strictEqual(result.satisfied, true, JSON.stringify(result.constraints, null, 2));
    strictEqual(result.constraints.length, 7);
  });

  it("covers the window with one leaf per hour, plus the partial edge", () => {
    strictEqual(bundle().witness.buckets.length, 25);
  });

  it("keeps the limit and the individual payments out of the public half", () => {
    const publicText = JSON.stringify(bundle().statement);
    ok(!publicText.includes("10000"), "the limit must not leak");
    ok(!publicText.includes("3000"), "individual amounts must not leak");
    ok(!publicText.includes("4000"));
  });
});

describe("completeness is now a constraint, not a hope", () => {
  it("catches an omitted bucket", () => {
    // The old attack: drop the bucket that would break the budget. It used to
    // satisfy every constraint.
    const entries = [
      entry("a", 3_000n, T0 - HOUR),
      entry("b", 4_000n, T0 - 2 * HOUR),
      entry("c", 9_000n, T0 - 3 * HOUR),
    ];
    const honest = bundle(entries);
    strictEqual(checkBudgetRelation(honest).satisfied, false, "the honest bundle should not fit");

    const heavy = honest.witness.buckets.find((b) => b.leaf.total === 9_000n);
    ok(heavy !== undefined);
    const dishonest: BudgetProofBundle = {
      ...honest,
      witness: {
        ...honest.witness,
        buckets: honest.witness.buckets.filter((b) => b !== heavy),
      },
    };

    const result = checkBudgetRelation(dishonest);
    strictEqual(result.satisfied, false);
    strictEqual(constraint(dishonest, "C6")?.satisfied, false);
    ok(constraint(dishonest, "C6")?.detail.includes("24"));
  });

  it("catches a bucket supplied twice to pad the count", () => {
    const honest = bundle();
    const buckets = [...honest.witness.buckets];
    buckets[5] = buckets[4]!;
    const padded = { ...honest, witness: { ...honest.witness, buckets } };
    strictEqual(constraint(padded, "C6")?.satisfied, false);
  });

  it("catches a commitment that does not cover the window", () => {
    const narrow = BucketCommitment.build([], {
      account: ACCOUNT,
      asset: TOKENS,
      bucketMs: HOUR,
      from: RANGE.from + 5,
      to: RANGE.to,
    });
    const b = bundle();
    const short: BudgetProofBundle = {
      ...b,
      statement: {
        ...b.statement,
        commitment: { ...b.statement.commitment, root: narrow.root, from: RANGE.from + 5 },
      },
    };
    strictEqual(constraint(short, "C6")?.satisfied, false);
  });

  it("the required range is computed from public values, not supplied", () => {
    // A prover cannot narrow the window by claiming fewer buckets are needed:
    // the range comes from requestedAt and the rule's own windowMs.
    const range = coveringBuckets(T0, DAY, HOUR);
    strictEqual(range.to - range.from + 1, 25);
  });
});

describe("soundness — each constraint catches its own forgery", () => {
  it("C1 catches a swapped policy", () => {
    const b = bundle();
    const looser: SpendPolicy = {
      ...policy,
      rules: [{ ...policy.rules[0]!, maxTotal: 10_000_000n } as SpendPolicy["rules"][number]],
    };
    strictEqual(constraint({ ...b, witness: { ...b.witness, policy: looser } }, "C1")?.satisfied, false);
  });

  it("C2 catches a swapped request", () => {
    const b = bundle();
    const bigger = { ...request, amount: 9_000n };
    strictEqual(constraint({ ...b, witness: { ...b.witness, request: bigger } }, "C2")?.satisfied, false);
  });

  it("C3 catches a shifted evaluation time", () => {
    const b = bundle();
    strictEqual(
      constraint({ ...b, statement: { ...b.statement, requestedAt: T0 + 1 } }, "C3")?.satisfied,
      false,
    );
  });

  it("C4 catches a leaf whose total was edited", () => {
    const b = bundle();
    const buckets = [...b.witness.buckets];
    // Must be a bucket that actually holds something: rewriting an empty one
    // to zero changes nothing, and there would be nothing to catch.
    const position = buckets.findIndex((x) => x.leaf.total > 0n);
    ok(position >= 0, "fixture should have a non-empty bucket");
    buckets[position] = {
      ...buckets[position]!,
      leaf: { ...buckets[position]!.leaf, total: 1n },
    };
    strictEqual(constraint({ ...b, witness: { ...b.witness, buckets } }, "C4")?.satisfied, false);
  });

  it("C5 catches a leaf lifted from a commitment with other parameters", () => {
    // Same shape, different bucket size — a leaf that proves inclusion in its
    // own tree but describes a different quantity.
    const foreign = BucketCommitment.build([entry("x", 1n, T0)], {
      account: ACCOUNT,
      asset: TOKENS,
      bucketMs: HOUR * 2,
      from: RANGE.from,
      to: RANGE.to,
    });
    const opened = foreign.open(RANGE.from)!;
    const b = bundle();
    const buckets = [...b.witness.buckets];
    buckets[0] = opened;
    const swapped = { ...b, witness: { ...b.witness, buckets } };
    strictEqual(constraint(swapped, "C5")?.satisfied, false);
  });

  it("C7 catches a payment that does not fit", () => {
    const heavy = [entry("a", 5_000n, T0 - HOUR), entry("b", 4_000n, T0 - 2 * HOUR)];
    strictEqual(constraint(bundle(heavy), "C7")?.satisfied, false);
  });

  it("refuses a rule that is not a window budget, rather than guessing", () => {
    const b = bundle();
    strictEqual(
      checkBudgetRelation({ ...b, witness: { ...b.witness, ruleId: "nonexistent" } }).satisfied,
      false,
    );
  });

  it("refuses a commitment in a different asset from the rule", () => {
    const b = bundle();
    const mismatched = {
      ...b,
      statement: { ...b.statement, commitment: { ...b.statement.commitment, asset: "USDC" } },
    };
    strictEqual(checkBudgetRelation(mismatched).satisfied, false);
  });
});

describe("agrees with the engine, and errs only toward refusing", () => {
  it("allows exactly what evaluate allows, on bucket-aligned spend", () => {
    const entries = [entry("a", 3_000n, T0 - HOUR), entry("b", 4_000n, T0 - 2 * HOUR)];
    strictEqual(evaluate(request, policy, entries).outcome, "ALLOW");
    strictEqual(checkBudgetRelation(bundle(entries)).satisfied, true);
  });

  it("refuses exactly what evaluate refuses", () => {
    const entries = [entry("a", 5_000n, T0 - HOUR), entry("b", 4_000n, T0 - 2 * HOUR)];
    strictEqual(evaluate(request, policy, entries).outcome, "DENY");
    strictEqual(checkBudgetRelation(bundle(entries)).satisfied, false);
  });

  it("over-counts the partial edge bucket, which can only refuse", () => {
    // A window that does NOT land on a bucket boundary. At exactly T0 the
    // 24-hour window is bucket-aligned and there is no partial edge at all,
    // so the case has to be built deliberately.
    const halfPast = T0 + HOUR / 2;
    const offRequest = { ...request, requestedAt: halfPast };
    // Five minutes after the edge bucket opens, but twenty-five minutes
    // before the window itself does.
    const straddling = entry("old", 9_000n, halfPast - DAY - 25 * 60_000);

    // The engine excludes it: it is outside the rolling window.
    strictEqual(evaluate(offRequest, policy, [straddling]).outcome, "ALLOW");

    // The commitment cannot exclude it, because a bucket is atomic. The
    // relation is therefore stricter than the policy — refusing something
    // that was allowable, never the reverse.
    const range = coveringBuckets(halfPast, DAY, HOUR);
    const commitment = BucketCommitment.build([straddling], {
      account: ACCOUNT,
      asset: TOKENS,
      bucketMs: HOUR,
      from: range.from,
      to: range.to,
    });
    const built = buildBudgetBundle({
      policy,
      request: offRequest,
      ruleId: "daily",
      commitment,
      windowMs: DAY,
    });
    ok(built !== null);
    strictEqual(checkBudgetRelation(built).satisfied, false);
    strictEqual(
      checkBudgetRelation(built).constraints.find((c) => c.id === "C7")?.satisfied,
      false,
    );
  });

  it("a reversed entry never enters a bucket at all", () => {
    const entries = [
      entry("a", 7_000n, T0 - HOUR),
      { ...entry("b", 9_000n, T0 - 2 * HOUR), state: "REVERSED" as const },
    ];
    strictEqual(checkBudgetRelation(bundle(entries)).satisfied, true);
  });

  it("another asset never enters a bucket at all", () => {
    const entries = [entry("a", 7_000n, T0 - HOUR), { ...entry("b", 90_000n, T0 - HOUR), asset: "USDC" }];
    strictEqual(checkBudgetRelation(bundle(entries)).satisfied, true);
  });
});

describe("the residual assumption is checkable", () => {
  it("a commitment rebuilt from the ledger matches", () => {
    const entries = [entry("a", 3_000n, T0 - HOUR), entry("b", 4_000n, T0 - 2 * HOUR)];
    strictEqual(commitmentMatchesLedger(commit(entries), entries), true);
  });

  it("a doctored commitment does not match the ledger it claims", () => {
    // The remaining attack: total dishonestly at commit time. Anyone holding
    // the ledger catches it, which is why this is a smaller assumption than
    // the one it replaced.
    const real = [entry("a", 3_000n, T0 - HOUR), entry("b", 9_000n, T0 - 2 * HOUR)];
    const understated = [entry("a", 3_000n, T0 - HOUR), entry("b", 10n, T0 - 2 * HOUR)];
    strictEqual(commitmentMatchesLedger(commit(understated), real), false);
  });
});

describe("honesty", () => {
  it("still does not claim to be zero-knowledge", () => {
    strictEqual(IS_ZERO_KNOWLEDGE, false);
    strictEqual(checkBudgetRelation(bundle()).zeroKnowledge, false);
  });

  it("completeness is a constraint now, and no longer an assumption", () => {
    const result = checkBudgetRelation(bundle());
    ok(result.constraints.some((c) => c.name === "completeness"));
    ok(!result.assumptions.some((a) => a.startsWith("COMPLETENESS")));
  });

  it("names what it still takes on trust", () => {
    const result = checkBudgetRelation(bundle());
    ok(result.assumptions.some((a) => a.startsWith("FAITHFUL TOTALLING")));
  });
});
