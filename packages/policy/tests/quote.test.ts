/**
 * The seller's commitment.
 *
 * The test that matters most is the one proving a quote closes the hole the
 * buyer could not: an operation that would have overrun its estimate is
 * authorised against the seller's stated ceiling instead, so the
 * authorisation is exact — and a seller that charges past its own ceiling is
 * caught rather than absorbed.
 */
import { ok, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";

import type { Quote } from "../src/index.js";
import {
  ANY_REQUESTER,
  MemoryLedgerStore,
  ManualClock,
  SpendGuard,
  assessQuote,
  quoteDigest,
  quotedDraft,
  settlementAgainstQuote,
  singlePolicy,
} from "../src/index.js";

const T0 = Date.UTC(2026, 8, 16, 4, 0, 0);
const ACCOUNT = "acct:research-agent";
const TOKENS = "anthropic:tokens";
const AGENT = { kind: "AGENT", agentId: "researcher" } as const;

const quote = (overrides: Partial<Quote> = {}): Quote => ({
  quoteId: "q-1",
  issuer: "vendor:messages-api",
  subject: { kind: "api.call", digest: "a".repeat(64) },
  asset: TOKENS,
  maxAmount: 5_000n,
  payTo: "vendor:messages-api/pay",
  issuedAt: T0 - 1_000,
  expiresAt: T0 + 60_000,
  audience: null,
  requestId: null,
  ...overrides,
});

const context = (overrides: Partial<Parameters<typeof assessQuote>[1]> = {}) => ({
  now: T0,
  audience: ACCOUNT,
  requestId: "call-1",
  ...overrides,
});

describe("assessing a quote", () => {
  it("accepts a live, unbound quote", () => {
    strictEqual(assessQuote(quote(), context()).usable, true);
  });

  it("expires exclusively — sitting exactly on the deadline is too late", () => {
    const q = quote({ expiresAt: T0 });
    const result = assessQuote(q, context({ now: T0 }));
    strictEqual(result.usable, false);
    if (result.usable) return;
    strictEqual(result.reason, "EXPIRED");

    strictEqual(assessQuote(q, context({ now: T0 - 1 })).usable, true);
  });

  it("refuses a quote from the future", () => {
    const result = assessQuote(quote({ issuedAt: T0 + 1 }), context());
    strictEqual(result.usable, false);
    if (result.usable) return;
    strictEqual(result.reason, "NOT_YET_VALID");
  });

  it("refuses a quote addressed to somebody else", () => {
    const result = assessQuote(quote({ audience: "acct:another" }), context());
    strictEqual(result.usable, false);
    if (result.usable) return;
    strictEqual(result.reason, "WRONG_AUDIENCE");
  });

  it("refuses a quote bound to a different request", () => {
    const result = assessQuote(quote({ requestId: "call-9" }), context());
    strictEqual(result.usable, false);
    if (result.usable) return;
    strictEqual(result.reason, "WRONG_REQUEST");
  });

  it("honours a binding that matches", () => {
    strictEqual(
      assessQuote(quote({ audience: ACCOUNT, requestId: "call-1" }), context()).usable,
      true,
    );
  });

  it("refuses a malformed quote", () => {
    for (const bad of [
      quote({ maxAmount: 0n }),
      quote({ expiresAt: T0 - 5_000, issuedAt: T0 - 1_000 }),
      quote({ payTo: "" }),
    ]) {
      const result = assessQuote(bad, context());
      strictEqual(result.usable, false);
      if (result.usable) continue;
      strictEqual(result.reason, "MALFORMED");
    }
  });
});

describe("the ceiling", () => {
  it("returns headroom when the seller charges less", () => {
    const settlement = settlementAgainstQuote(quote(), 3_100n);
    strictEqual(settlement.honoured, true);
    if (!settlement.honoured) return;
    strictEqual(settlement.headroom, 1_900n);
  });

  it("charging exactly the ceiling is honoured", () => {
    strictEqual(settlementAgainstQuote(quote(), 5_000n).honoured, true);
  });

  it("one unit over is a broken promise, not a rounding error", () => {
    const settlement = settlementAgainstQuote(quote(), 5_001n);
    strictEqual(settlement.honoured, false);
    if (settlement.honoured) return;
    strictEqual(settlement.exceededBy, 1n);
  });
});

describe("the bridge into policy", () => {
  it("authorises the quoted ceiling, never an estimate", () => {
    const draft = quotedDraft(quote({ maxAmount: 5_000n }), {
      requestId: "call-1",
      account: ACCOUNT,
      requester: AGENT,
      requestedAt: T0,
    });
    strictEqual(draft.amount, 5_000n);
    strictEqual(draft.asset, TOKENS);
    // The seller's payee becomes the destination, so ordinary policy sees it.
    strictEqual(draft.destination, "vendor:messages-api/pay");
  });

  it("an unapproved seller is refused by an ordinary allowlist", async () => {
    const guard = new SpendGuard({
      store: new MemoryLedgerStore(),
      clock: new ManualClock(T0),
      policyFor: singlePolicy({
        account: ACCOUNT,
        version: 1,
        rules: [
          {
            id: "known-vendors",
            kind: "DESTINATION_ALLOWLIST",
            scope: ANY_REQUESTER,
            destinations: ["vendor:messages-api/pay"],
          },
        ],
      }),
    });

    const stranger = quote({ payTo: "vendor:unknown/pay" });
    const result = await guard.run(
      quotedDraft(stranger, {
        requestId: "call-1",
        account: ACCOUNT,
        requester: AGENT,
        requestedAt: T0,
      }),
      async () => "done",
    );
    strictEqual(result.outcome, "REFUSED");
    if (result.outcome !== "REFUSED") return;
    strictEqual(result.decision.outcome, "DENY");
    if (result.decision.outcome !== "DENY") return;
    // No new rule kind was needed for "do I trust this seller".
    strictEqual(result.decision.reason, "DESTINATION_NOT_ALLOWED");
  });

  it("closes the overage hole the buyer could not close alone", async () => {
    const store = new MemoryLedgerStore();
    const guard = new SpendGuard({
      store,
      clock: new ManualClock(T0),
      policyFor: singlePolicy({
        account: ACCOUNT,
        version: 1,
        rules: [
          {
            id: "per-call",
            kind: "PER_TRANSACTION_LIMIT",
            scope: ANY_REQUESTER,
            asset: TOKENS,
            maxAmount: 5_000n,
          },
        ],
      }),
    });

    // Unquoted: the caller guesses 1,000, really burns 40,000, and the guard
    // can only record the damage after the fact.
    const guessed = await guard.run(
      {
        requestId: "unquoted",
        account: ACCOUNT,
        requester: AGENT,
        asset: TOKENS,
        amount: 1_000n,
        destination: "vendor:messages-api/pay",
      },
      async (grant) => {
        grant.report(40_000n);
        return "done";
      },
    );
    strictEqual(guessed.outcome, "COMPLETED");
    strictEqual((await store.find("unquoted"))?.amount, 40_000n);

    // Quoted: the seller states its ceiling, the buyer authorises that, and a
    // ceiling above the policy limit is refused *before* anything is spent.
    const expensive = quote({ maxAmount: 40_000n });
    const refused = await guard.run(
      quotedDraft(expensive, {
        requestId: "quoted",
        account: ACCOUNT,
        requester: AGENT,
        requestedAt: T0,
      }),
      async () => "done",
    );
    strictEqual(refused.outcome, "REFUSED");
    strictEqual(await store.find("quoted"), undefined);
  });
});

describe("the digest", () => {
  it("is stable and moves with the promise", () => {
    strictEqual(quoteDigest(quote()), quoteDigest(quote()));
    ok(quoteDigest(quote()) !== quoteDigest(quote({ maxAmount: 5_001n })));
    ok(quoteDigest(quote()) !== quoteDigest(quote({ expiresAt: T0 + 60_001 })));
  });
});
