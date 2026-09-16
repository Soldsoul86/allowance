/**
 * Ledger arithmetic.
 *
 * Windows are inclusive at both ends and are tested at both edges; state
 * handling is tested because `PENDING` counting as fully as `SETTLED` is the
 * property that prevents a concurrent drain.
 */
import { strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";

import type { WindowQuery } from "../src/index.js";
import { consumesBudget, countWithin, spentWithin } from "../src/index.js";
import { AGENT, OWNER, T0, USDC, entry, usdc } from "./helpers.js";

const query = (overrides: Partial<WindowQuery> = {}): WindowQuery => ({
  from: T0 - 86_400_000,
  to: T0,
  requesters: null,
  excludeRequestId: "none",
  ...overrides,
});

describe("consumesBudget", () => {
  it("counts pending and settled, never reversed", () => {
    strictEqual(consumesBudget(entry({ state: "PENDING" })), true);
    strictEqual(consumesBudget(entry({ state: "SETTLED" })), true);
    strictEqual(consumesBudget(entry({ state: "REVERSED" })), false);
  });
});

describe("spentWithin", () => {
  it("sums one asset and ignores others", () => {
    const entries = [
      entry({ requestId: "a", amount: usdc(10) }),
      entry({ requestId: "b", amount: usdc(20) }),
      entry({ requestId: "c", amount: usdc(99), asset: "WETH" }),
    ];
    strictEqual(spentWithin(entries, USDC, query()), usdc(30));
  });

  it("excludes the named request", () => {
    const entries = [entry({ requestId: "a", amount: usdc(10) }), entry({ requestId: "b", amount: usdc(20) })];
    strictEqual(spentWithin(entries, USDC, query({ excludeRequestId: "a" })), usdc(20));
  });

  it("respects the window bounds inclusively", () => {
    const entries = [
      entry({ requestId: "edge-low", amount: usdc(1), at: T0 - 86_400_000 }),
      entry({ requestId: "edge-high", amount: usdc(2), at: T0 }),
      entry({ requestId: "outside", amount: usdc(4), at: T0 - 86_400_001 }),
    ];
    strictEqual(spentWithin(entries, USDC, query()), usdc(3));
  });

  it("filters by requester when scoped", () => {
    const entries = [
      entry({ requestId: "owner", amount: usdc(10), requester: OWNER }),
      entry({ requestId: "agent", amount: usdc(20), requester: AGENT }),
    ];
    strictEqual(spentWithin(entries, USDC, query({ requesters: ["AGENT:researcher"] })), usdc(20));
  });

  it("is zero over an empty ledger", () => {
    strictEqual(spentWithin([], USDC, query()), 0n);
  });
});

describe("countWithin", () => {
  it("counts across assets but honours state and window", () => {
    const entries = [
      entry({ requestId: "a" }),
      entry({ requestId: "b", asset: "WETH" }),
      entry({ requestId: "c", state: "REVERSED" }),
      entry({ requestId: "d", at: T0 - 86_400_001 }),
    ];
    strictEqual(countWithin(entries, query()), 2);
  });
});
