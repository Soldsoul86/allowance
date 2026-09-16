/**
 * The ledger as a projection of the journal.
 *
 * The tests that matter here are the ones the in-memory store could not pass:
 * a budget that survives a restart, a fold that two devices agree on, and
 * amounts that round-trip through an encoding which refuses `bigint`.
 */
import { deepStrictEqual, ok, rejects, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";

import { Journal, MemoryJournalStore, type JournalStore } from "@allowance/journal";

import type { LedgerEntry, SpendPolicy } from "../src/index.js";
import {
  ANY_REQUESTER,
  JournalLedgerStore,
  ManualClock,
  SpendGuard,
  singlePolicy,
} from "../src/index.js";

const ACCOUNT = "acct:treasury";
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

const reservation = (requestId: string, amount: bigint, at = T0): LedgerEntry => ({
  requestId,
  account: ACCOUNT,
  asset: TOKENS,
  amount,
  destination: "vendor:api",
  requester: { kind: "AGENT", agentId: "researcher" },
  at,
  state: "PENDING",
  intent: "",
  decision: null,
  expiresAt: null,
});

async function openStore(journalStore: JournalStore, lane = "device-a") {
  const journal = await Journal.open({ lane, device: lane, store: journalStore });
  const store = await JournalLedgerStore.open({ journal });
  return { journal, store };
}

describe("durability", () => {
  it("a reservation survives a restart", async () => {
    const disk = new MemoryJournalStore();

    const first = await openStore(disk);
    await first.store.append(reservation("a", 6_000n));
    first.store.close();
    await first.journal.close();

    // A different process, a fresh projection, the same history.
    const second = await openStore(disk);
    const recovered = await second.store.find("a");
    strictEqual(recovered?.amount, 6_000n);
    strictEqual(recovered?.state, "PENDING");
  });

  it("the budget a restarted process enforces is the one it left behind", async () => {
    const disk = new MemoryJournalStore();
    const clock = new ManualClock(T0);

    const first = await openStore(disk);
    const guardA = new SpendGuard({ store: first.store, clock, policyFor: singlePolicy(policy) });
    await guardA.run(
      {
        requestId: "a",
        account: ACCOUNT,
        requester: { kind: "AGENT", agentId: "researcher" },
        asset: TOKENS,
        amount: 9_000n,
        destination: "vendor:api",
      },
      async () => "done",
    );
    first.store.close();
    await first.journal.close();

    const second = await openStore(disk);
    const guardB = new SpendGuard({ store: second.store, clock, policyFor: singlePolicy(policy) });
    const afterRestart = await guardB.run(
      {
        requestId: "b",
        account: ACCOUNT,
        requester: { kind: "AGENT", agentId: "researcher" },
        asset: TOKENS,
        amount: 2_000n,
        destination: "vendor:api",
      },
      async () => "done",
    );

    // The in-memory store would have forgotten the 9,000 and allowed this.
    strictEqual(afterRestart.outcome, "REFUSED");
  });

  it("settlements and reversals replay too", async () => {
    const disk = new MemoryJournalStore();

    const first = await openStore(disk);
    await first.store.append(reservation("a", 5_000n));
    await first.store.settle("a", 4_231n);
    await first.store.append(reservation("b", 5_000n));
    await first.store.reverse("b");
    first.store.close();
    await first.journal.close();

    const second = await openStore(disk);
    strictEqual((await second.store.find("a"))?.amount, 4_231n);
    strictEqual((await second.store.find("a"))?.state, "SETTLED");
    strictEqual((await second.store.find("b"))?.state, "REVERSED");
  });

  it("the fold is deterministic across repeated replays", async () => {
    const disk = new MemoryJournalStore();
    const first = await openStore(disk);
    await first.store.append(reservation("a", 1_000n));
    await first.store.settle("a", 900n);
    await first.store.append(reservation("b", 2_000n));
    first.store.close();
    await first.journal.close();

    const a = await openStore(disk);
    const b = await openStore(disk);
    deepStrictEqual(await a.store.entries(ACCOUNT), await b.store.entries(ACCOUNT));
  });
});

describe("amounts", () => {
  it("round-trip through an encoding that refuses bigint", async () => {
    const disk = new MemoryJournalStore();
    const huge = 2n ** 80n + 7n;

    const first = await openStore(disk);
    await first.store.append(reservation("a", huge));
    first.store.close();
    await first.journal.close();

    const second = await openStore(disk);
    strictEqual((await second.store.find("a"))?.amount, huge);
  });
});

describe("history cannot be corrected", () => {
  it("refuses a duplicate reservation before writing it", async () => {
    const { store, journal } = await openStore(new MemoryJournalStore());
    await store.append(reservation("a", 1_000n));
    await rejects(() => store.append(reservation("a", 1_000n)), /duplicate reservation/);
    store.close();
    await journal.close();
  });

  it("refuses to settle twice", async () => {
    const { store, journal } = await openStore(new MemoryJournalStore());
    await store.append(reservation("a", 1_000n));
    await store.settle("a", 900n);
    await rejects(() => store.settle("a", 800n), /already SETTLED/);
    store.close();
    await journal.close();
  });

  it("refuses to settle something never reserved", async () => {
    const { store, journal } = await openStore(new MemoryJournalStore());
    await rejects(() => store.settle("ghost", 1n), /no reservation/);
    store.close();
    await journal.close();
  });
});

describe("the idempotency fingerprint", () => {
  it("survives a restart, so a mismatch is still caught", async () => {
    const disk = new MemoryJournalStore();
    const clock = new ManualClock(T0);

    const first = await openStore(disk);
    const guardA = new SpendGuard({ store: first.store, clock, policyFor: singlePolicy(policy) });
    await guardA.run(
      {
        requestId: "call-1",
        account: ACCOUNT,
        requester: { kind: "AGENT", agentId: "researcher" },
        asset: TOKENS,
        amount: 1_000n,
        destination: "vendor:api",
      },
      async () => "done",
    );
    first.store.close();
    await first.journal.close();

    // A fingerprint held only in memory would be lost here, and the reused id
    // would read as an ordinary duplicate on the other side of the restart.
    const second = await openStore(disk);
    strictEqual((await second.store.find("call-1"))?.intent.length, 64);

    const guardB = new SpendGuard({ store: second.store, clock, policyFor: singlePolicy(policy) });
    const changed = await guardB.run(
      {
        requestId: "call-1",
        account: ACCOUNT,
        requester: { kind: "AGENT", agentId: "researcher" },
        asset: TOKENS,
        amount: 5_000n,
        destination: "vendor:api",
      },
      async () => "done",
    );
    strictEqual(changed.outcome, "MISMATCH");
  });
});

describe("the recorded decision", () => {
  it("survives a restart, so a retry still gets its original answer", async () => {
    const disk = new MemoryJournalStore();
    const clock = new ManualClock(T0);
    const spend = (requestId: string, amount: bigint) => ({
      requestId,
      account: ACCOUNT,
      requester: { kind: "AGENT", agentId: "researcher" } as const,
      asset: TOKENS,
      amount,
      destination: "vendor:api",
    });

    const first = await openStore(disk);
    const guardA = new SpendGuard({ store: first.store, clock, policyFor: singlePolicy(policy) });
    await guardA.run(spend("call-1", 1_000n), async () => "done");
    first.store.close();
    await first.journal.close();

    const second = await openStore(disk);
    const restored = await second.store.find("call-1");
    strictEqual(restored?.decision?.outcome, "ALLOW");
    strictEqual(restored?.decision?.policyDigest.length, 64);

    const guardB = new SpendGuard({ store: second.store, clock, policyFor: singlePolicy(policy) });
    const retry = await guardB.run(spend("call-1", 1_000n), async () => "done");
    strictEqual(retry.outcome, "DUPLICATE");
    if (retry.outcome !== "DUPLICATE") return;
    strictEqual(retry.decision?.outcome, "ALLOW");
  });

  it("keeps every rule the decision evaluated, not just the verdict", async () => {
    const { store, journal } = await openStore(new MemoryJournalStore());
    const guard = new SpendGuard({
      store,
      clock: new ManualClock(T0),
      policyFor: singlePolicy(policy),
    });
    await guard.run(
      {
        requestId: "call-1",
        account: ACCOUNT,
        requester: { kind: "AGENT", agentId: "researcher" },
        asset: TOKENS,
        amount: 1_000n,
        destination: "vendor:api",
      },
      async () => "done",
    );

    // The audit value of a decision is the rules it passed, not only the one
    // that would have failed.
    const evaluations = (await store.find("call-1"))?.decision?.evaluations ?? [];
    strictEqual(evaluations.length, policy.rules.length);
    store.close();
    await journal.close();
  });
});

describe("deadlines across a restart", () => {
  const spend = (requestId: string, amount: bigint) => ({
    requestId,
    account: ACCOUNT,
    requester: { kind: "AGENT", agentId: "researcher" } as const,
    asset: TOKENS,
    amount,
    destination: "vendor:api",
  });

  it("a deadline and an extension both survive", async () => {
    const disk = new MemoryJournalStore();
    const clock = new ManualClock(T0);

    const first = await openStore(disk);
    const guardA = new SpendGuard({
      store: first.store,
      clock,
      policyFor: singlePolicy(policy),
      reservationTtlMs: 60_000,
    });
    const auth = await guardA.authorize(spend("call-1", 1_000n));
    ok(auth.granted);
    strictEqual(auth.reservation.expiresAt, T0 + 60_000);

    clock.advance(30_000);
    strictEqual((await guardA.extend("call-1", 600_000)).extended, true);
    first.store.close();
    await first.journal.close();

    // A deadline held only in memory would come back as "never expires", and a
    // reservation nobody is coming back for would look healthy forever.
    const second = await openStore(disk);
    strictEqual((await second.store.find("call-1"))?.expiresAt, T0 + 30_000 + 600_000);
  });

  it("an expired reservation is still expired, and still holding, after a reload", async () => {
    const disk = new MemoryJournalStore();
    const clock = new ManualClock(T0);

    const first = await openStore(disk);
    const guardA = new SpendGuard({
      store: first.store,
      clock,
      policyFor: singlePolicy(policy),
      reservationTtlMs: 60_000,
    });
    await guardA.run(spend("call-1", 9_000n), async () => {
      throw new Error("client died");
    });
    first.store.close();
    await first.journal.close();

    clock.advance(600_000);
    const second = await openStore(disk);
    const guardB = new SpendGuard({
      store: second.store,
      clock,
      policyFor: singlePolicy(policy),
      reservationTtlMs: 60_000,
    });

    strictEqual((await guardB.expiredReservations()).length, 1);
    // Still holding, so the budget is still gone. A restart is not a release.
    strictEqual((await guardB.run(spend("call-2", 2_000n), async () => "x")).outcome, "REFUSED");
  });
});

describe("two devices, one envelope", () => {
  it("a replicated reservation consumes the shared budget", async () => {
    const diskA = new MemoryJournalStore();
    const diskB = new MemoryJournalStore();

    const a = await openStore(diskA, "device-a");
    await a.store.append(reservation("from-a", 9_000n));

    const b = await openStore(diskB, "device-b");
    strictEqual(b.store.size, 0);

    // Replication is the set union of immutable lanes (Art. IV §18).
    await b.journal.replicate("device-a", await a.journal.readLane("device-a"));

    const seen = await b.store.find("from-a");
    strictEqual(seen?.amount, 9_000n);

    const guardB = new SpendGuard({
      store: b.store,
      clock: new ManualClock(T0),
      policyFor: singlePolicy(policy),
    });
    const blocked = await guardB.run(
      {
        requestId: "from-b",
        account: ACCOUNT,
        requester: { kind: "AGENT", agentId: "researcher" },
        asset: TOKENS,
        amount: 2_000n,
        destination: "vendor:api",
      },
      async () => "done",
    );
    strictEqual(blocked.outcome, "REFUSED");

    a.store.close();
    b.store.close();
    await a.journal.close();
    await b.journal.close();
  });
});

describe("integrity", () => {
  it("the hash chain still verifies after a full lifecycle", async () => {
    const { store, journal } = await openStore(new MemoryJournalStore());
    await store.append(reservation("a", 1_000n));
    await store.settle("a", 900n);
    await store.append(reservation("b", 1_000n));
    await store.reverse("b");
    await journal.verify();
    store.close();
    await journal.close();
  });
});
