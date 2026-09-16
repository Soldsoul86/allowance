/**
 * Closing the Art. 42 loop.
 *
 * The guard refuses to guess whether a failed operation spent money. These
 * tests cover what turns that refusal from a dead end into a cycle — and the
 * one behaviour that makes the reconciler trustworthy: `UNKNOWN` resolves
 * nothing at all.
 */
import { strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";

import type { LedgerEntry, SpendObservation, SpendObserver, SpendPolicy } from "../src/index.js";
import { ANY_REQUESTER, ManualClock, MemoryLedgerStore, SpendGuard, singlePolicy } from "../src/index.js";

const ACCOUNT = "acct:research-agent";
const TOKENS = "anthropic:tokens";
const T0 = Date.UTC(2026, 8, 16, 4, 0, 0);

const policy: SpendPolicy = {
  account: ACCOUNT,
  version: 1,
  rules: [
    {
      id: "daily",
      kind: "WINDOW_BUDGET",
      scope: ANY_REQUESTER,
      asset: TOKENS,
      windowMs: 86_400_000,
      maxTotal: 10_000n,
    },
  ],
};

const draft = (requestId: string, amount = 5_000n) => ({
  requestId,
  account: ACCOUNT,
  requester: { kind: "AGENT", agentId: "researcher" } as const,
  asset: TOKENS,
  amount,
  destination: "vendor:api",
});

/** A sensor a test drives directly. */
class ScriptedObserver implements SpendObserver {
  readonly seen: string[] = [];
  constructor(private readonly answers: Map<string, SpendObservation | Error>) {}
  async observe(entry: LedgerEntry): Promise<SpendObservation> {
    this.seen.push(entry.requestId);
    const answer = this.answers.get(entry.requestId) ?? { state: "UNKNOWN" as const };
    if (answer instanceof Error) throw answer;
    return answer;
  }
}

function build() {
  const store = new MemoryLedgerStore();
  const clock = new ManualClock(T0);
  const guard = new SpendGuard({ store, clock, policyFor: singlePolicy(policy) });
  return { store, clock, guard };
}

/** Leaves one reservation open the way a real failure does. */
async function stranded(guard: SpendGuard, id: string, amount = 5_000n) {
  const result = await guard.run(draft(id, amount), async () => {
    throw new Error("socket hang up");
  });
  strictEqual(result.outcome, "INDETERMINATE");
}

describe("resolving what reality can answer", () => {
  it("settles at the figure the sensor observed, not the one reserved", async () => {
    const { guard, store, clock } = build();
    await stranded(guard, "a", 5_000n);
    clock.advance(120_000);

    const report = await guard.reconcile(
      new ScriptedObserver(new Map([["a", { state: "SETTLED", actualAmount: 3_100n }]])),
      60_000,
    );

    strictEqual(report.examined, 1);
    strictEqual(report.settled.length, 1);
    strictEqual(report.settled[0]?.amount, 3_100n);
    strictEqual((await store.find("a"))?.state, "SETTLED");
    strictEqual((await store.find("a"))?.amount, 3_100n);
  });

  it("returns the budget when the sensor proves it never happened", async () => {
    const { guard, store, clock } = build();
    await stranded(guard, "a", 9_000n);
    clock.advance(120_000);

    const report = await guard.reconcile(
      new ScriptedObserver(new Map([["a", { state: "NOT_SPENT" }]])),
      60_000,
    );

    strictEqual(report.reversed.length, 1);
    strictEqual((await store.find("a"))?.state, "REVERSED");

    // The envelope is whole again, so the next call fits.
    const next = await guard.run(draft("b", 9_000n), async () => "done");
    strictEqual(next.outcome, "COMPLETED");
  });
});

describe("what it refuses to do", () => {
  it("leaves an unknown open, and offers it again next sweep", async () => {
    const { guard, store, clock } = build();
    await stranded(guard, "a");
    clock.advance(120_000);

    const observer = new ScriptedObserver(new Map([["a", { state: "UNKNOWN" }]]));
    const first = await guard.reconcile(observer, 60_000);
    strictEqual(first.unresolved.length, 1);
    strictEqual((await store.find("a"))?.state, "PENDING");

    // Still consuming budget, on purpose.
    const blocked = await guard.run(draft("b", 9_000n), async () => "done");
    strictEqual(blocked.outcome, "REFUSED");

    const second = await guard.reconcile(observer, 60_000);
    strictEqual(second.unresolved.length, 1);
    strictEqual(observer.seen.length, 2);
  });

  it("does not abandon the sweep when one observation throws", async () => {
    const { guard, store, clock } = build();
    await stranded(guard, "a", 2_000n);
    await stranded(guard, "b", 2_000n);
    clock.advance(120_000);

    const report = await guard.reconcile(
      new ScriptedObserver(
        new Map<string, SpendObservation | Error>([
          ["a", new Error("vendor unreachable")],
          ["b", { state: "NOT_SPENT" }],
        ]),
      ),
      60_000,
    );

    strictEqual(report.examined, 2);
    strictEqual(report.failed.length, 1);
    strictEqual(report.failed[0]?.requestId, "a");
    strictEqual(report.reversed.length, 1);
    // The one that failed is untouched, not guessed at.
    strictEqual((await store.find("a"))?.state, "PENDING");
    strictEqual((await store.find("b"))?.state, "REVERSED");
  });

  it("ignores reservations that are not yet stale", async () => {
    const { guard, clock } = build();
    await stranded(guard, "a");
    clock.advance(30_000);

    const observer = new ScriptedObserver(new Map([["a", { state: "NOT_SPENT" }]]));
    const report = await guard.reconcile(observer, 60_000);
    strictEqual(report.examined, 0);
    strictEqual(observer.seen.length, 0);
  });

  it("never touches a settled entry", async () => {
    const { guard, clock } = build();
    await guard.run(draft("done", 1_000n), async () => "ok");
    clock.advance(120_000);

    const observer = new ScriptedObserver(new Map([["done", { state: "NOT_SPENT" }]]));
    const report = await guard.reconcile(observer, 60_000);
    strictEqual(report.examined, 0);
  });
});

describe("the full cycle", () => {
  it("decide, act, fail, observe, close", async () => {
    const { guard, store, clock } = build();

    // 1. decide and act; the call dies without saying what it cost
    await stranded(guard, "call-1", 5_000n);
    strictEqual((await store.find("call-1"))?.state, "PENDING");

    // 2. the budget is held, so the agent cannot keep spending on a guess
    strictEqual((await guard.run(draft("call-2", 6_000n), async () => "ok")).outcome, "REFUSED");

    // 3. later, a sensor looks at the vendor's usage record
    clock.advance(3_600_000);
    const report = await guard.reconcile(
      new ScriptedObserver(new Map([["call-1", { state: "SETTLED", actualAmount: 900n }]])),
      60_000,
    );
    strictEqual(report.settled.length, 1);

    // 4. reality is recorded, and the envelope reflects what was truly spent
    const resumed = await guard.run(draft("call-3", 9_000n), async () => "ok");
    strictEqual(resumed.outcome, "COMPLETED");
  });
});
