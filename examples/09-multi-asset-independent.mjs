import { makeGuard, draft, spend, title, agent, OWNER, ANY, only, DAY } from "./lib.mjs";
title(9, "Tokens and USDC have independent budgets; the owner has a higher cap than agents on the same account");
const policy = { account: "acct", version: 1, rules: [
  { id: "tokens",      kind: "WINDOW_BUDGET", scope: ANY,           asset: "anthropic:tokens", windowMs: DAY, maxTotal: 10_000n },
  { id: "usdc-agents", kind: "WINDOW_BUDGET", scope: only("AGENT:bot"), asset: "usdc", windowMs: DAY, maxTotal: 20_000_000n },
  { id: "usdc-owner",  kind: "WINDOW_BUDGET", scope: only("OWNER"),     asset: "usdc", windowMs: DAY, maxTotal: 500_000_000n },
]};
const { guard } = makeGuard(policy);
await spend(guard, "bot uses all 10,000 tokens", draft("acct", agent("bot"), "anthropic:tokens", 10_000n));
await spend(guard, "bot pays 20 USDC (token budget being empty is irrelevant)", draft("acct", agent("bot"), "usdc", 20_000_000n));
await spend(guard, "bot pays 1 more USDC", draft("acct", agent("bot"), "usdc", 1_000_000n));
await spend(guard, "owner pays 400 USDC on the same account", draft("acct", OWNER, "usdc", 400_000_000n));
await spend(guard, "owner asks for 1 token (shared token budget is spent)", draft("acct", OWNER, "anthropic:tokens", 1n));
