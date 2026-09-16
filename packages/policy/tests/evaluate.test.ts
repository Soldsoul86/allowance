/**
 * The engine's behaviour.
 *
 * Grouped by the property under test rather than by function, because the
 * properties are what must hold: deny by default, pending money holds its
 * budget, evaluation is idempotent, every rule is recorded, and the same
 * inputs always produce the same decision.
 */
import { deepStrictEqual, strictEqual, throws } from "node:assert/strict";
import { describe, it } from "node:test";

import { authorizedEntry, evaluate, explain, summarize } from "../src/index.js";
import { ACCOUNT, AGENT, OWNER, T0, USDC, anywhere, entry, policy, request, usdc } from "./helpers.js";

describe("structural refusals", () => {
  it("denies when the policy has no rules", () => {
    const decision = evaluate(request(), policy([]));
    strictEqual(decision.outcome, "DENY");
    if (decision.outcome !== "DENY") return;
    strictEqual(decision.reason, "NO_POLICY");
  });

  it("denies a request aimed at another account", () => {
    const decision = evaluate(
      request({ account: "acct:someone-else" }),
      policy([{ id: "assets", kind: "ASSET_ALLOWLIST", scope: anywhere, assets: [USDC] }]),
    );
    strictEqual(decision.outcome, "DENY");
    if (decision.outcome !== "DENY") return;
    strictEqual(decision.reason, "WRONG_ACCOUNT");
  });

  it("denies a zero or negative amount", () => {
    const rules = [{ id: "assets", kind: "ASSET_ALLOWLIST", scope: anywhere, assets: [USDC] }] as const;
    for (const amount of [0n, -1n]) {
      const decision = evaluate(request({ amount }), policy([...rules]));
      strictEqual(decision.outcome, "DENY");
      if (decision.outcome !== "DENY") continue;
      strictEqual(decision.reason, "INVALID_AMOUNT");
    }
  });
});

describe("list rules", () => {
  it("allows an allowlisted destination and denies anything else", () => {
    const p = policy([
      { id: "dests", kind: "DESTINATION_ALLOWLIST", scope: anywhere, destinations: ["addr:vendor-a"] },
    ]);
    strictEqual(evaluate(request(), p).outcome, "ALLOW");

    const denied = evaluate(request({ destination: "addr:unknown" }), p);
    strictEqual(denied.outcome, "DENY");
    if (denied.outcome !== "DENY") return;
    strictEqual(denied.reason, "DESTINATION_NOT_ALLOWED");
  });

  it("an empty allowlist freezes the account", () => {
    const frozen = policy([
      { id: "freeze", kind: "DESTINATION_ALLOWLIST", scope: anywhere, destinations: [] },
    ]);
    strictEqual(evaluate(request(), frozen).outcome, "DENY");
  });

  it("a denylist refuses a named destination", () => {
    const p = policy([
      { id: "sanctions", kind: "DESTINATION_DENYLIST", scope: anywhere, destinations: ["addr:bad"] },
    ]);
    strictEqual(evaluate(request(), p).outcome, "ALLOW");
    const denied = evaluate(request({ destination: "addr:bad" }), p);
    strictEqual(denied.outcome, "DENY");
    if (denied.outcome !== "DENY") return;
    strictEqual(denied.reason, "DESTINATION_DENIED");
  });

  it("restricts which assets may move", () => {
    const p = policy([{ id: "assets", kind: "ASSET_ALLOWLIST", scope: anywhere, assets: [USDC] }]);
    const denied = evaluate(request({ asset: "WETH" }), p);
    strictEqual(denied.outcome, "DENY");
    if (denied.outcome !== "DENY") return;
    strictEqual(denied.reason, "ASSET_NOT_ALLOWED");
  });
});

describe("per-transaction limit", () => {
  const p = policy([
    { id: "cap", kind: "PER_TRANSACTION_LIMIT", scope: anywhere, asset: USDC, maxAmount: usdc(100) },
  ]);

  it("allows exactly the limit", () => {
    strictEqual(evaluate(request({ amount: usdc(100) }), p).outcome, "ALLOW");
  });

  it("denies one base unit above the limit", () => {
    const decision = evaluate(request({ amount: usdc(100) + 1n }), p);
    strictEqual(decision.outcome, "DENY");
    if (decision.outcome !== "DENY") return;
    strictEqual(decision.reason, "TRANSACTION_TOO_LARGE");
  });

  it("ignores a request in a different asset", () => {
    const decision = evaluate(request({ asset: "WETH", amount: usdc(10_000) }), p);
    strictEqual(decision.outcome, "ALLOW");
    strictEqual(decision.evaluations[0]?.verdict, "NOT_APPLICABLE");
  });
});

describe("window budget", () => {
  const p = policy([
    {
      id: "daily",
      kind: "WINDOW_BUDGET",
      scope: anywhere,
      asset: USDC,
      windowMs: 86_400_000,
      maxTotal: usdc(100),
    },
  ]);

  it("counts settled spend inside the window", () => {
    const ledger = [entry({ amount: usdc(95) })];
    strictEqual(evaluate(request({ amount: usdc(5) }), p, ledger).outcome, "ALLOW");
    const denied = evaluate(request({ amount: usdc(6) }), p, ledger);
    strictEqual(denied.outcome, "DENY");
    if (denied.outcome !== "DENY") return;
    strictEqual(denied.reason, "BUDGET_EXHAUSTED");
  });

  it("counts PENDING spend exactly as much as SETTLED", () => {
    // The concurrency guarantee. If pending money did not hold its budget, N
    // simultaneous requests would each see an empty budget and each pass.
    const ledger = [entry({ requestId: "inflight", amount: usdc(95), state: "PENDING" })];
    const denied = evaluate(request({ amount: usdc(10) }), p, ledger);
    strictEqual(denied.outcome, "DENY");
    if (denied.outcome !== "DENY") return;
    strictEqual(denied.reason, "BUDGET_EXHAUSTED");
  });

  it("returns budget when a spend is REVERSED", () => {
    const ledger = [entry({ amount: usdc(95), state: "REVERSED" })];
    strictEqual(evaluate(request({ amount: usdc(100) }), p, ledger).outcome, "ALLOW");
  });

  it("ignores spend that fell out of the window", () => {
    const ledger = [entry({ amount: usdc(95), at: T0 - 86_400_001 })];
    strictEqual(evaluate(request({ amount: usdc(100) }), p, ledger).outcome, "ALLOW");
  });

  it("ignores another account's ledger", () => {
    const ledger = [entry({ account: "acct:other", amount: usdc(95) })];
    strictEqual(evaluate(request({ amount: usdc(100) }), p, ledger).outcome, "ALLOW");
  });

  it("is idempotent for a request already in the ledger", () => {
    // Re-evaluating an in-flight request must not count it against itself.
    const inflight = request({ requestId: "req-1", amount: usdc(60) });
    const ledger = [entry({ requestId: "req-1", amount: usdc(60), state: "PENDING" })];
    strictEqual(evaluate(inflight, p, []).outcome, "ALLOW");
    strictEqual(evaluate(inflight, p, ledger).outcome, "ALLOW");
  });
});

describe("velocity", () => {
  const p = policy([
    { id: "rate", kind: "WINDOW_VELOCITY", scope: anywhere, windowMs: 3_600_000, maxCount: 3 },
  ]);

  it("allows up to the count and refuses the next", () => {
    const two = [entry({ requestId: "a" }), entry({ requestId: "b" })];
    strictEqual(evaluate(request(), p, two).outcome, "ALLOW");

    const three = [...two, entry({ requestId: "c" })];
    const denied = evaluate(request(), p, three);
    strictEqual(denied.outcome, "DENY");
    if (denied.outcome !== "DENY") return;
    strictEqual(denied.reason, "TOO_MANY_TRANSACTIONS");
  });
});

describe("approval threshold", () => {
  const p = policy([
    {
      id: "two-eyes",
      kind: "APPROVAL_THRESHOLD",
      scope: anywhere,
      asset: USDC,
      atOrAboveAmount: usdc(1_000),
      approvalsRequired: 2,
    },
  ]);

  it("passes straight through below the threshold", () => {
    strictEqual(evaluate(request({ amount: usdc(999) }), p).outcome, "ALLOW");
  });

  it("holds exactly at the threshold", () => {
    const decision = evaluate(request({ amount: usdc(1_000) }), p);
    strictEqual(decision.outcome, "REQUIRES_APPROVAL");
    if (decision.outcome !== "REQUIRES_APPROVAL") return;
    strictEqual(decision.approvalsRequired, 2);
    strictEqual(decision.approvalsHeld, 0);
  });

  it("counts distinct approvers only", () => {
    const duplicated = request({
      amount: usdc(5_000),
      approvals: [
        { approver: "hari", at: T0 },
        { approver: "hari", at: T0 + 1 },
        { approver: "hari", at: T0 + 2 },
      ],
    });
    const held = evaluate(duplicated, p);
    strictEqual(held.outcome, "REQUIRES_APPROVAL");
    if (held.outcome !== "REQUIRES_APPROVAL") return;
    strictEqual(held.approvalsHeld, 1);

    const genuine = request({
      amount: usdc(5_000),
      approvals: [
        { approver: "hari", at: T0 },
        { approver: "meera", at: T0 + 1 },
      ],
    });
    strictEqual(evaluate(genuine, p).outcome, "ALLOW");
  });
});

describe("time window", () => {
  const daytime = policy([
    { id: "hours", kind: "TIME_WINDOW", scope: anywhere, fromMinuteUtc: 9 * 60, toMinuteUtc: 17 * 60 },
  ]);

  it("allows inside the window", () => {
    strictEqual(evaluate(request({ requestedAt: T0 }), daytime).outcome, "ALLOW");
  });

  it("denies outside the window", () => {
    const night = Date.UTC(2026, 2, 10, 3, 0, 0);
    const decision = evaluate(request({ requestedAt: night }), daytime);
    strictEqual(decision.outcome, "DENY");
    if (decision.outcome !== "DENY") return;
    strictEqual(decision.reason, "OUTSIDE_TIME_WINDOW");
  });

  it("wraps around midnight", () => {
    const overnight = policy([
      { id: "night", kind: "TIME_WINDOW", scope: anywhere, fromMinuteUtc: 22 * 60, toMinuteUtc: 6 * 60 },
    ]);
    strictEqual(evaluate(request({ requestedAt: Date.UTC(2026, 2, 10, 23, 30) }), overnight).outcome, "ALLOW");
    strictEqual(evaluate(request({ requestedAt: Date.UTC(2026, 2, 10, 2, 30) }), overnight).outcome, "ALLOW");
    strictEqual(evaluate(request({ requestedAt: Date.UTC(2026, 2, 10, 12, 0) }), overnight).outcome, "DENY");
  });
});

describe("scope", () => {
  const p = policy([
    {
      id: "agent-cap",
      kind: "PER_TRANSACTION_LIMIT",
      scope: { kind: "REQUESTERS", requesters: ["AGENT:researcher"] },
      asset: USDC,
      maxAmount: usdc(50),
    },
  ]);

  it("constrains the named requester", () => {
    const decision = evaluate(request({ requester: AGENT, amount: usdc(100) }), p);
    strictEqual(decision.outcome, "DENY");
  });

  it("leaves everyone else alone", () => {
    const decision = evaluate(request({ requester: OWNER, amount: usdc(100) }), p);
    strictEqual(decision.outcome, "ALLOW");
    strictEqual(decision.evaluations[0]?.verdict, "NOT_APPLICABLE");
  });

  it("scopes a budget to the agent's own spend", () => {
    const scoped = policy([
      {
        id: "agent-budget",
        kind: "WINDOW_BUDGET",
        scope: { kind: "REQUESTERS", requesters: ["AGENT:researcher"] },
        asset: USDC,
        windowMs: 86_400_000,
        maxTotal: usdc(100),
      },
    ]);
    // The owner's spend must not consume the agent's envelope.
    const ownerSpend = [entry({ requester: OWNER, amount: usdc(95) })];
    strictEqual(evaluate(request({ requester: AGENT, amount: usdc(100) }), scoped, ownerSpend).outcome, "ALLOW");

    const agentSpend = [entry({ requester: AGENT, amount: usdc(95) })];
    strictEqual(evaluate(request({ requester: AGENT, amount: usdc(100) }), scoped, agentSpend).outcome, "DENY");
  });
});

describe("precedence and explainability", () => {
  const p = policy([
    { id: "assets", kind: "ASSET_ALLOWLIST", scope: anywhere, assets: [USDC] },
    {
      id: "approval",
      kind: "APPROVAL_THRESHOLD",
      scope: anywhere,
      asset: USDC,
      atOrAboveAmount: usdc(10),
      approvalsRequired: 1,
    },
    { id: "deny", kind: "DESTINATION_DENYLIST", scope: anywhere, destinations: ["addr:vendor-a"] },
  ]);

  it("a denial outranks a pending approval", () => {
    const decision = evaluate(request(), p);
    strictEqual(decision.outcome, "DENY");
    if (decision.outcome !== "DENY") return;
    strictEqual(decision.ruleId, "deny");
  });

  it("records every rule it evaluated, not only the deciding one", () => {
    const decision = evaluate(request(), p);
    strictEqual(decision.evaluations.length, 3);
    deepStrictEqual(
      decision.evaluations.map((e) => e.verdict),
      ["ALLOW", "REQUIRES_APPROVAL", "DENY"],
    );
  });

  it("carries the policy digest and version for replay", () => {
    const decision = evaluate(request(), p);
    strictEqual(decision.policyVersion, 1);
    strictEqual(decision.policyDigest.length, 64);
    strictEqual(decision.account, ACCOUNT);
  });
});

describe("determinism", () => {
  const p = policy([
    { id: "cap", kind: "PER_TRANSACTION_LIMIT", scope: anywhere, asset: USDC, maxAmount: usdc(100) },
    {
      id: "daily",
      kind: "WINDOW_BUDGET",
      scope: anywhere,
      asset: USDC,
      windowMs: 86_400_000,
      maxTotal: usdc(500),
    },
  ]);

  it("produces an identical decision every time", () => {
    const req = request({ amount: usdc(40) });
    const ledger = [entry({ amount: usdc(60) })];
    const first = evaluate(req, p, ledger);
    for (let i = 0; i < 5; i++) deepStrictEqual(evaluate(req, p, ledger), first);
  });

  it("does not mutate its inputs", () => {
    const req = request();
    const ledger = [entry()];
    const reqCopy = structuredClone(req);
    const ledgerCopy = structuredClone(ledger);
    evaluate(req, p, ledger);
    deepStrictEqual(req, reqCopy);
    deepStrictEqual(ledger, ledgerCopy);
  });
});

describe("authorizedEntry", () => {
  const p = policy([{ id: "assets", kind: "ASSET_ALLOWLIST", scope: anywhere, assets: [USDC] }]);

  it("produces a PENDING entry from an allow", () => {
    const req = request();
    const built = authorizedEntry(req, evaluate(req, p));
    strictEqual(built.state, "PENDING");
    strictEqual(built.requestId, req.requestId);
    strictEqual(built.amount, req.amount);
  });

  it("refuses to authorize anything that was not allowed", () => {
    const req = request({ asset: "WETH" });
    throws(() => authorizedEntry(req, evaluate(req, p)), /cannot authorize a DENY/);
  });
});

describe("rendering", () => {
  const p = policy([
    { id: "dests", kind: "DESTINATION_ALLOWLIST", scope: anywhere, destinations: ["addr:ok"] },
  ]);

  it("explains a denial with every rule it read", () => {
    const text = explain(evaluate(request(), p));
    strictEqual(text.includes("DENY"), true);
    strictEqual(text.includes("dests"), true);
    strictEqual(text.includes("DESTINATION_NOT_ALLOWED"), true);
  });

  it("summarizes to one line", () => {
    const line = summarize(evaluate(request(), p));
    strictEqual(line.includes("\n"), false);
    strictEqual(line.startsWith("DENY"), true);
  });
});
