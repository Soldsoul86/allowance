import { makeGuard, draft, spend, title, agent, ANY, DAY } from "./lib.mjs";
title(4, "Only approved vendors can be paid; one vendor is explicitly blocked even if added later");
const policy = { account: "acct", version: 3, rules: [
  { id: "vendors", kind: "DESTINATION_ALLOWLIST", scope: ANY, destinations: ["vendor:anthropic", "vendor:openai", "vendor:sketchy"] },
  { id: "blocked", kind: "DESTINATION_DENYLIST",  scope: ANY, destinations: ["vendor:sketchy"] },
  { id: "assets",  kind: "ASSET_ALLOWLIST",       scope: ANY, assets: ["usd:cents"] },
]};
const { guard } = makeGuard(policy);
await spend(guard, "pay vendor:anthropic in usd:cents", draft("acct", agent("a"), "usd:cents", 500n, "vendor:anthropic"));
await spend(guard, "pay vendor:unknown", draft("acct", agent("a"), "usd:cents", 500n, "vendor:unknown"));
await spend(guard, "pay vendor:sketchy (on allowlist AND denylist: deny wins)", draft("acct", agent("a"), "usd:cents", 500n, "vendor:sketchy"));
await spend(guard, "pay vendor:anthropic in ETH wei (asset not allowed)", draft("acct", agent("a"), "eth:wei", 500n, "vendor:anthropic"));
