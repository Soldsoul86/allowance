import { makeGuard, draft, spend, title, agent, ANY, DAY } from "./lib.mjs";
title(2, "A per-call cap of 8,000 tokens on top of a 50,000 daily budget; the ledger records real cost");
const policy = { account: "acct", version: 1, rules: [
  { id: "per-call", kind: "PER_TRANSACTION_LIMIT", scope: ANY, asset: "anthropic:tokens", maxAmount: 8_000n },
  { id: "daily",    kind: "WINDOW_BUDGET",         scope: ANY, asset: "anthropic:tokens", windowMs: DAY, maxTotal: 50_000n },
]};
const { guard } = makeGuard(policy);
await spend(guard, "estimate 8,000, actually used 8,900 (overage is recorded, not hidden)", draft("acct", agent("a"), "anthropic:tokens", 8_000n), 8_900n);
await spend(guard, "estimate 8,001 (over the per-call cap)", draft("acct", agent("a"), "anthropic:tokens", 8_001n));
await spend(guard, "estimate 5,000, actually used 1,200 (budget gets the difference back)", draft("acct", agent("a"), "anthropic:tokens", 5_000n), 1_200n);
console.log("          daily used so far: 8,900 + 1,200 = 10,100 of 50,000");
await spend(guard, "estimate 8,000 x5 in a row (fits: 10,100 + 40,000 = 50,100 > 50,000 on the fifth)", draft("acct", agent("a"), "anthropic:tokens", 8_000n));
for (let i = 0; i < 4; i++) await spend(guard, `  ...call ${i + 2}`, draft("acct", agent("a"), "anthropic:tokens", 8_000n));
