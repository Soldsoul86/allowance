import { makeGuard, draft, spend, title, agent, only, ANY, DAY } from "./lib.mjs";
title(1, "Different daily token budgets per agent (research: 100k, support: 20k, everyone else: 5k)");
const policy = { account: "team", version: 1, rules: [
  { id: "research-daily", kind: "WINDOW_BUDGET", scope: only("AGENT:research"), asset: "anthropic:tokens", windowMs: DAY, maxTotal: 100_000n },
  { id: "support-daily",  kind: "WINDOW_BUDGET", scope: only("AGENT:support"),  asset: "anthropic:tokens", windowMs: DAY, maxTotal: 20_000n },
  { id: "default-daily",  kind: "WINDOW_BUDGET", scope: only("AGENT:intern"),   asset: "anthropic:tokens", windowMs: DAY, maxTotal: 5_000n },
]};
const { guard } = makeGuard(policy);
await spend(guard, "research spends 80,000", draft("team", agent("research"), "anthropic:tokens", 80_000n));
await spend(guard, "research spends 30,000 more (would reach 110,000)", draft("team", agent("research"), "anthropic:tokens", 30_000n));
await spend(guard, "support spends 15,000", draft("team", agent("support"), "anthropic:tokens", 15_000n));
await spend(guard, "support spends 6,000 more (would reach 21,000)", draft("team", agent("support"), "anthropic:tokens", 6_000n));
await spend(guard, "intern spends 4,999", draft("team", agent("intern"), "anthropic:tokens", 4_999n));
await spend(guard, "intern spends 2", draft("team", agent("intern"), "anthropic:tokens", 2n));
