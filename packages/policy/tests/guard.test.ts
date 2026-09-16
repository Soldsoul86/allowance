/**
 * The shell around the engine.
 *
 * Two behaviours carry this file. The first is the concurrency test: ten
 * callers racing for a budget that fits three, which only passes because
 * `authorize` never suspends between reading the ledger and writing the
 * reservation. The second is what happens when an operation throws — the
 * guard refuses to guess whether the money moved, because a connection reset
 * before the call left and a lost response after the vendor charged look
 * identical from here.
 */
import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";

import type { Decision, GuardOutcome, SpendPolicy, SpendRequest } from "../src/index.js";
import {
  ANY_REQUESTER,
  ManualClock,
  MemoryLedgerStore,
  SpendGuard,
  singlePolicy,
} from "../src/index.js";

const ACCOUNT = "acct:research-agent";
const TOKENS = "anthropic:tokens";
const T0 = Date.UTC(2026, 8, 16, 4, 0, 0);

/** Budget for three calls of 1,000 tokens each, per hour. */
const policy: SpendPolicy = {
  account: ACCOUNT,
  version: 7,
  rules: [
    { id: "assets", kind: "ASSET_ALLOWLIST", scope: ANY_REQUESTER, assets: [TOKENS] },
    {
      id: "hourly",
      kind: "WINDOW_BUDGET",
      scope: ANY_REQUESTER,
      asset: TOKENS,
      windowMs: 3_600_000,
      maxTotal: 3_000n,
    },
  ],
};

function build(overrides: Partial<{ onDecision: (d: Decision, r: SpendRequest) => void }> = {}) {
  const store = new MemoryLedgerStore();
  const clock = new ManualClock(T0);
  const guard = new SpendGuard({
    store,
    clock,
    policyFor: singlePolicy(policy),
    ...(overrides.onDecision === undefined ? {} : { onDecision: overrides.onDecision }),
  });
  return { store, clock, guard };
}

const draft = (requestId: string, amount = 1_000n) => ({
  requestId,
  account: ACCOUNT,
  requester: { kind: "AGENT", agentId: "researcher" } as const,
  asset: TOKENS,
  amount,
  destination: "vendor:api",
});

describe("the critical section", () => {
  it("ten racing callers cannot overspend a budget that fits three", async () => {
    const { guard } = build();

    // Every call suspends inside its operation. If `authorize` suspended too,
    // all ten would observe an empty budget and all ten would be allowed.
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        guard.run(draft(`req-${i}`), async () => {
          await new Promise((resolve) => setTimeout(resolve, 1));
          return "done";
        }),
      ),
    );

    const completed = results.filter((r) => r.outcome === "COMPLETED");
    const refused = results.filter((r) => r.outcome === "REFUSED");
    strictEqual(completed.length, 3);
    strictEqual(refused.length, 7);
  });

  it("a refusal names the budget it hit", async () => {
    const { guard } = build();
    await guard.run(draft("a", 3_000n), async () => "done");
    const blocked = await guard.run(draft("b"), async () => "done");

    strictEqual(blocked.outcome, "REFUSED");
    if (blocked.outcome !== "REFUSED") return;
    strictEqual(blocked.decision.outcome, "DENY");
    if (blocked.decision.outcome !== "DENY") return;
    strictEqual(blocked.decision.reason, "BUDGET_EXHAUSTED");
    strictEqual(blocked.decision.ruleId, "hourly");
  });
});

describe("recording what actually happened", () => {
  it("settles at the reported figure, not the estimate", async () => {
    const { guard, store } = build();
    const result = await guard.run(draft("a", 1_000n), async (grant) => {
      grant.report(742n);
      return "done";
    });

    strictEqual(result.outcome, "COMPLETED");
    if (result.outcome !== "COMPLETED") return;
    strictEqual(result.reserved, 1_000n);
    strictEqual(result.actual, 742n);
    strictEqual(result.overage, 0n);
    strictEqual((await store.find("a"))?.amount, 742n);
  });

  it("records an overage rather than pretending it did not happen", async () => {
    const { guard, store } = build();
    const result = await guard.run(draft("a", 1_000n), async (grant) => {
      grant.report(1_400n);
      return "done";
    });

    strictEqual(result.outcome, "COMPLETED");
    if (result.outcome !== "COMPLETED") return;
    strictEqual(result.actual, 1_400n);
    strictEqual(result.overage, 400n);
    strictEqual((await store.find("a"))?.amount, 1_400n);
  });

  it("the next decision sees the true figure, so the budget self-corrects", async () => {
    const { guard } = build();
    // Two calls estimated at 1,000 that each really cost 1,400 leave only 200
    // of the 3,000 budget, not 1,000.
    for (const id of ["a", "b"]) {
      await guard.run(draft(id, 1_000n), async (grant) => {
        grant.report(1_400n);
        return "done";
      });
    }
    const third = await guard.run(draft("c", 1_000n), async () => "done");
    strictEqual(third.outcome, "REFUSED");
  });

  it("settles at the estimate when the operation reports nothing", async () => {
    const { guard, store } = build();
    await guard.run(draft("a", 900n), async () => "done");
    strictEqual((await store.find("a"))?.amount, 900n);
    strictEqual((await store.find("a"))?.state, "SETTLED");
  });
});

describe("when the operation fails", () => {
  it("holds the reservation when it cannot know whether money moved", async () => {
    const { guard, store } = build();
    const result = await guard.run(draft("a"), async () => {
      throw new Error("socket hang up");
    });

    strictEqual(result.outcome, "INDETERMINATE");
    // Still open, still consuming budget. Guessing would be the expensive
    // kind of wrong.
    strictEqual((await store.find("a"))?.state, "PENDING");
  });

  it("settles at zero when the operation proves nothing was spent", async () => {
    const { guard, store } = build();
    const result = await guard.run(draft("a"), async (grant) => {
      grant.report(0n);
      throw new Error("rejected before dispatch");
    });

    strictEqual(result.outcome, "FAILED");
    if (result.outcome !== "FAILED") return;
    strictEqual(result.actual, 0n);
    strictEqual((await store.find("a"))?.state, "SETTLED");
    strictEqual((await store.find("a"))?.amount, 0n);
  });

  it("a zero-cost attempt still counts against a velocity limit", async () => {
    const store = new MemoryLedgerStore();
    const clock = new ManualClock(T0);
    const guard = new SpendGuard({
      store,
      clock,
      policyFor: singlePolicy({
        account: ACCOUNT,
        version: 1,
        rules: [
          { id: "rate", kind: "WINDOW_VELOCITY", scope: ANY_REQUESTER, windowMs: 3_600_000, maxCount: 1 },
        ],
      }),
    });

    await guard.run(draft("a"), async (grant) => {
      grant.report(0n);
      throw new Error("failed");
    });
    // It cost nothing, but it happened.
    strictEqual((await guard.run(draft("b"), async () => "done")).outcome, "REFUSED");
  });

  it("settles what a failing operation admits it spent", async () => {
    const { guard, store } = build();
    const result = await guard.run(draft("a", 1_000n), async (grant) => {
      grant.report(600n);
      throw new Error("parse error after the vendor charged");
    });

    strictEqual(result.outcome, "FAILED");
    if (result.outcome !== "FAILED") return;
    strictEqual(result.actual, 600n);
    strictEqual((await store.find("a"))?.amount, 600n);
  });

  it("surfaces held reservations for reconciliation", async () => {
    const { guard, clock } = build();
    await guard.run(draft("a"), async () => {
      throw new Error("socket hang up");
    });

    strictEqual((await guard.openReservations(60_000)).length, 0);
    clock.advance(61_000);
    const stale = await guard.openReservations(60_000);
    strictEqual(stale.length, 1);
    strictEqual(stale[0]?.requestId, "a");
  });
});

describe("retries", () => {
  it("a repeated request id never spends twice", async () => {
    const { guard } = build();
    const first = await guard.run(draft("same"), async () => "done");
    const second = await guard.run(draft("same"), async () => "done");

    strictEqual(first.outcome, "COMPLETED");
    strictEqual(second.outcome, "DUPLICATE");
    if (second.outcome !== "DUPLICATE") return;
    strictEqual(second.existing.requestId, "same");
  });

  it("a duplicate does not run the operation at all", async () => {
    const { guard } = build();
    let runs = 0;
    const op = async () => {
      runs += 1;
      return "done";
    };
    await guard.run(draft("same"), op);
    await guard.run(draft("same"), op);
    strictEqual(runs, 1);
  });
});

describe("a reused id must be the same request", () => {
  /* The bug this replaced compared ids and nothing else, so a client that
     reused an id for a different amount was told "already done" about a spend
     it had never asked for. */

  const reserve = async (guard: SpendGuard, overrides: Record<string, unknown> = {}) =>
    guard.run({ ...draft("same"), ...overrides }, async () => "done");

  it("refuses a reused id carrying a different amount", async () => {
    const { guard, store } = build();
    await reserve(guard);
    const second = await reserve(guard, { amount: 2_000n });

    strictEqual(second.outcome, "MISMATCH");
    if (second.outcome !== "MISMATCH") return;
    ok(second.detail.includes("different spend"));
    // The first reservation is untouched; nothing new was written.
    strictEqual((await store.find("same"))?.amount, 1_000n);
  });

  it("refuses a reused id carrying a different destination", async () => {
    const { guard } = build();
    await reserve(guard);
    strictEqual((await reserve(guard, { destination: "vendor:elsewhere" })).outcome, "MISMATCH");
  });

  it("refuses a reused id carrying a different asset", async () => {
    const { guard } = build();
    await reserve(guard);
    strictEqual((await reserve(guard, { asset: "USDC" })).outcome, "MISMATCH");
  });

  it("refuses a reused id from a different requester", async () => {
    const { guard } = build();
    await reserve(guard);
    const other = { kind: "AGENT", agentId: "somebody-else" } as const;
    strictEqual((await reserve(guard, { requester: other })).outcome, "MISMATCH");
  });

  it("does not run the operation on a mismatch", async () => {
    const { guard } = build();
    let runs = 0;
    const op = async () => {
      runs += 1;
      return "done";
    };
    await guard.run(draft("same"), op);
    await guard.run({ ...draft("same"), amount: 2_000n }, op);
    strictEqual(runs, 1);
  });
});

describe("a duplicate returns the answer it gave the first time", () => {
  it("carries the original decision, not just the ledger entry", async () => {
    const { guard } = build();
    const first = await guard.run(draft("same"), async () => "done");
    strictEqual(first.outcome, "COMPLETED");

    const second = await guard.run(draft("same"), async () => "done");
    strictEqual(second.outcome, "DUPLICATE");
    if (second.outcome !== "DUPLICATE") return;
    strictEqual(second.decision?.outcome, "ALLOW");
    strictEqual(second.decision?.requestId, "same");
  });

  it("reports how the original turned out", async () => {
    const { guard } = build();
    await guard.run(draft("same", 1_000n), async (grant) => {
      grant.report(640n);
      return "done";
    });

    const retry = await guard.run(draft("same", 1_000n), async () => "done");
    strictEqual(retry.outcome, "DUPLICATE");
    if (retry.outcome !== "DUPLICATE") return;
    // A caller that lost its first answer can recover both halves: what was
    // decided, and what it ended up costing.
    strictEqual(retry.existing.state, "SETTLED");
    strictEqual(retry.existing.amount, 640n);
  });

  it("returns the ORIGINAL answer even though a fresh one would differ", async () => {
    // This is the whole point. Between the two attempts the budget fills up,
    // so re-evaluating now would deny. A retry must not be told its payment
    // was refused when it was in fact allowed and may already have happened.
    const { guard } = build();
    await guard.run(draft("same", 1_000n), async () => "done");
    await guard.run(draft("filler-a", 1_000n), async () => "done");
    await guard.run(draft("filler-b", 1_000n), async () => "done");

    // Proof the ledger really has moved on.
    strictEqual((await guard.run(draft("fresh", 1_000n), async () => "x")).outcome, "REFUSED");

    const retry = await guard.run(draft("same", 1_000n), async () => "done");
    strictEqual(retry.outcome, "DUPLICATE");
    if (retry.outcome !== "DUPLICATE") return;
    strictEqual(retry.decision?.outcome, "ALLOW");
  });

  it("returns the decision made under the policy in force at the time", async () => {
    const store = new MemoryLedgerStore();
    const clock = new ManualClock(T0);
    let current = policy;
    const guard = new SpendGuard({ store, clock, policyFor: () => current });

    await guard.run(draft("same"), async () => "done");

    // The rules change afterwards. The recorded decision names the old ones.
    current = { ...policy, version: 99 };
    const retry = await guard.run(draft("same"), async () => "done");

    strictEqual(retry.outcome, "DUPLICATE");
    if (retry.outcome !== "DUPLICATE") return;
    strictEqual(retry.decision?.policyVersion, 7);
  });

  it("an entry from before decisions were recorded says so, rather than inventing one", async () => {
    const store = new MemoryLedgerStore();
    await store.append({
      requestId: "legacy",
      account: ACCOUNT,
      asset: TOKENS,
      amount: 1_000n,
      destination: "vendor:api",
      requester: { kind: "AGENT", agentId: "researcher" },
      at: T0,
      state: "SETTLED",
      intent: "",
      decision: null,
      expiresAt: null,
    });
    const guard = new SpendGuard({
      store,
      clock: new ManualClock(T0),
      policyFor: singlePolicy(policy),
    });

    const retry = await guard.run(draft("legacy"), async () => "x");
    strictEqual(retry.outcome, "DUPLICATE");
    if (retry.outcome !== "DUPLICATE") return;
    // Re-deriving it now would answer a different question.
    strictEqual(retry.decision, null);
  });
});

describe("an honest retry is still a duplicate", () => {
  /* A fingerprint that is too wide rejects retries that were never wrong.
     These are the fields a genuine retry is expected to differ on. */

  it("a later timestamp — the shell stamps it from a clock", async () => {
    const { guard, clock } = build();
    await guard.run(draft("same"), async () => "done");
    clock.advance(5_000);
    strictEqual((await guard.run(draft("same"), async () => "done")).outcome, "DUPLICATE");
  });

  it("approvals collected since the first attempt", async () => {
    const { guard } = build();
    await guard.run(draft("same"), async () => "done");
    const withApproval = {
      ...draft("same"),
      approvals: [{ approver: "hari", at: T0 + 10 }],
    };
    strictEqual((await guard.run(withApproval, async () => "done")).outcome, "DUPLICATE");
  });

  it("a different memo", async () => {
    const { guard } = build();
    await guard.run(draft("same"), async () => "done");
    const noted = { ...draft("same"), memo: "retry after timeout" };
    strictEqual((await guard.run(noted, async () => "done")).outcome, "DUPLICATE");
  });

  it("the fingerprint survives settlement, which overwrites the amount", async () => {
    // `settle` replaces `amount` with what was really spent, so the entry can
    // never be the record of what was asked for. If `intent` were ever derived
    // from the stored amount, this is where the bug would come back.
    const { guard, store } = build();
    await guard.run(draft("same", 1_000n), async (grant) => {
      grant.report(400n);
      return "done";
    });
    strictEqual((await store.find("same"))?.amount, 400n);

    // The original request asked for 1,000, and that is still what matches.
    strictEqual((await guard.run(draft("same", 1_000n), async () => "x")).outcome, "DUPLICATE");
    strictEqual((await guard.run(draft("same", 400n), async () => "x")).outcome, "MISMATCH");
  });

  it("an entry with no fingerprint cannot be compared, so it is a duplicate", async () => {
    // Replayed from history written before fingerprints existed. No worse than
    // the behaviour this replaced, and it never passes a changed request off
    // as a matching one.
    const store = new MemoryLedgerStore();
    await store.append({
      requestId: "legacy",
      account: ACCOUNT,
      asset: TOKENS,
      amount: 1_000n,
      destination: "vendor:api",
      requester: { kind: "AGENT", agentId: "researcher" },
      at: T0,
      state: "SETTLED",
      intent: "",
      decision: null,
      expiresAt: null,
    });
    const guard = new SpendGuard({
      store,
      clock: new ManualClock(T0),
      policyFor: singlePolicy(policy),
    });
    const result = await guard.run({ ...draft("legacy"), amount: 9_999n }, async () => "x");
    strictEqual(result.outcome, "DUPLICATE");
  });
});

describe("deadlines", () => {
  /* A deadline marks a reservation as no longer expected to complete. It does
     NOT decide that nothing was spent -- that is the difference between this
     and a TTL that auto-releases. */

  const withTtl = (ttlMs: number, graceMs = 5_000) => {
    const store = new MemoryLedgerStore();
    const clock = new ManualClock(T0);
    const guard = new SpendGuard({
      store,
      clock,
      policyFor: singlePolicy(policy),
      reservationTtlMs: ttlMs,
      graceMs,
    });
    return { store, clock, guard };
  };

  /** Leaves a reservation open the way a crashed client does. */
  const strand = async (guard: SpendGuard, id: string, amount = 1_000n) => {
    const result = await guard.run(draft(id, amount), async () => {
      throw new Error("client died");
    });
    strictEqual(result.outcome, "INDETERMINATE");
  };

  it("nothing expires when no TTL is configured", async () => {
    const { guard, clock } = build();
    await strand(guard, "a");
    clock.advance(365 * 86_400_000);
    strictEqual((await guard.expiredReservations()).length, 0);
  });

  it("expires once the deadline and the grace period have passed", async () => {
    const { guard, clock } = withTtl(60_000);
    await strand(guard, "a");

    clock.advance(60_001);
    strictEqual((await guard.expiredReservations()).length, 0, "still inside grace");

    clock.advance(5_000);
    const expired = await guard.expiredReservations();
    strictEqual(expired.length, 1);
    strictEqual(expired[0]?.requestId, "a");
  });

  it("an expired reservation still holds its budget", async () => {
    // The whole point. A passed deadline is not evidence that nothing was
    // spent, so the budget stays held and the next spend is still refused.
    const { guard, clock, store } = withTtl(60_000);
    await strand(guard, "a", 3_000n);
    clock.advance(600_000);

    strictEqual((await guard.expiredReservations()).length, 1);
    strictEqual((await store.find("a"))?.state, "PENDING");
    strictEqual((await guard.run(draft("b", 1_000n), async () => "x")).outcome, "REFUSED");
  });

  it("a settlement inside the grace period is not a late arrival", async () => {
    const { guard, clock } = withTtl(60_000);
    const auth = await guard.authorize(draft("a"));
    ok(auth.granted);

    clock.advance(62_000);
    strictEqual((await guard.expiredReservations()).length, 0);
    await auth.settle(900n);
    strictEqual((await guard.expiredReservations()).length, 0);
  });

  it("a per-request TTL overrides the guard's default", async () => {
    const { guard, clock } = withTtl(60_000);
    await guard.run({ ...draft("slow"), ttlMs: 3_600_000 }, async () => {
      throw new Error("still running");
    });

    clock.advance(600_000);
    // Long past the default deadline, comfortably inside its own.
    strictEqual((await guard.expiredReservations()).length, 0);
  });
});

describe("extending a deadline", () => {
  const withTtl = (ttlMs: number) => {
    const store = new MemoryLedgerStore();
    const clock = new ManualClock(T0);
    const guard = new SpendGuard({
      store,
      clock,
      policyFor: singlePolicy(policy),
      reservationTtlMs: ttlMs,
    });
    return { store, clock, guard };
  };

  it("buys more time for an operation that is genuinely still running", async () => {
    const { guard, clock, store } = withTtl(60_000);
    const auth = await guard.authorize(draft("a"));
    ok(auth.granted);

    clock.advance(50_000);
    const result = await guard.extend("a", 600_000);
    strictEqual(result.extended, true);
    if (!result.extended) return;

    // Measured from now, so an extension buys the time it says it buys.
    strictEqual(result.expiresAt, T0 + 50_000 + 600_000);
    strictEqual((await store.find("a"))?.expiresAt, T0 + 50_000 + 600_000);

    clock.advance(300_000);
    strictEqual((await guard.expiredReservations()).length, 0);
  });

  it("refuses once the grace period is gone", async () => {
    // At that point the reservation's status is a question for reconciliation,
    // and extending it would bury the question.
    const { guard, clock } = withTtl(60_000);
    await guard.authorize(draft("a"));
    clock.advance(600_000);

    const result = await guard.extend("a", 60_000);
    strictEqual(result.extended, false);
    if (result.extended) return;
    strictEqual(result.reason, "EXPIRED");
    ok(result.detail.includes("reconcile"));
  });

  it("refuses a reservation that has already finished", async () => {
    const { guard } = withTtl(60_000);
    await guard.run(draft("a"), async () => "done");
    const result = await guard.extend("a", 60_000);
    strictEqual(result.extended, false);
    if (result.extended) return;
    strictEqual(result.reason, "NOT_PENDING");
  });

  it("refuses an unknown reservation and a non-positive extension", async () => {
    const { guard } = withTtl(60_000);
    await guard.authorize(draft("a"));

    strictEqual((await guard.extend("ghost", 1_000)).extended, false);
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      strictEqual((await guard.extend("a", bad)).extended, false);
    }
  });
});

describe("releasing expired reservations is an explicit guess", () => {
  it("reverses them and gives the budget back", async () => {
    const store = new MemoryLedgerStore();
    const clock = new ManualClock(T0);
    const guard = new SpendGuard({
      store,
      clock,
      policyFor: singlePolicy(policy),
      reservationTtlMs: 60_000,
    });

    await guard.run(draft("a", 3_000n), async () => {
      throw new Error("client died");
    });
    clock.advance(600_000);
    strictEqual((await guard.run(draft("b", 1_000n), async () => "x")).outcome, "REFUSED");

    // Opt-in, explicit, and journalled as a reversal somebody chose.
    const released = await guard.releaseExpired();
    deepStrictEqual(released, ["a"]);
    strictEqual((await store.find("a"))?.state, "REVERSED");
    strictEqual((await guard.run(draft("c", 1_000n), async () => "x")).outcome, "COMPLETED");
  });

  it("never touches a reservation that is still inside its deadline", async () => {
    const store = new MemoryLedgerStore();
    const guard = new SpendGuard({
      store,
      clock: new ManualClock(T0),
      policyFor: singlePolicy(policy),
      reservationTtlMs: 60_000,
    });
    await guard.authorize(draft("a"));
    deepStrictEqual(await guard.releaseExpired(), []);
    strictEqual((await store.find("a"))?.state, "PENDING");
  });
});

describe("policy source", () => {
  it("an unknown account has no policy, so nothing moves", async () => {
    const { guard } = build();
    const result = await guard.run({ ...draft("a"), account: "acct:unknown" }, async () => "done");

    strictEqual(result.outcome, "REFUSED");
    if (result.outcome !== "REFUSED") return;
    strictEqual(result.decision.outcome, "DENY");
    if (result.decision.outcome !== "DENY") return;
    strictEqual(result.decision.reason, "NO_POLICY");
  });
});

describe("the journal seam", () => {
  it("every decision is offered, allowed and refused alike", async () => {
    const seen: Decision[] = [];
    const { guard } = build({ onDecision: (decision) => seen.push(decision) });

    await guard.run(draft("a", 3_000n), async () => "done");
    await guard.run(draft("b"), async () => "done");

    deepStrictEqual(
      seen.map((d) => d.outcome),
      ["ALLOW", "DENY"],
    );
    // Every record carries the provenance a replay needs.
    for (const decision of seen) {
      strictEqual(decision.policyVersion, 7);
      strictEqual(decision.policyDigest.length, 64);
    }
  });

  it("a duplicate is not offered as a fresh decision", async () => {
    const seen: Decision[] = [];
    const { guard } = build({ onDecision: (decision) => seen.push(decision) });
    await guard.run(draft("same"), async () => "done");
    await guard.run(draft("same"), async () => "done");
    strictEqual(seen.length, 1);
  });
});

describe("the clock", () => {
  it("stamps the request, and a draft may override it", async () => {
    const { guard, clock } = build();
    clock.set(T0 + 5_000);
    const auth = await guard.authorize(draft("a"));
    ok(auth.granted);
    strictEqual(auth.request.requestedAt, T0 + 5_000);

    const fixed = await guard.authorize({ ...draft("b"), requestedAt: T0 });
    ok(fixed.granted);
    strictEqual(fixed.request.requestedAt, T0);
  });

  it("budget windows move with it", async () => {
    const { guard, clock } = build();
    await guard.run(draft("a", 3_000n), async () => "done");
    strictEqual((await guard.run(draft("b"), async () => "done")).outcome, "REFUSED");

    clock.advance(3_600_001);
    const later: GuardOutcome<string> = await guard.run(draft("c"), async () => "done");
    strictEqual(later.outcome, "COMPLETED");
  });
});
