import { makeGuard, draft, spend, title, agent, ANY, MIN } from "./lib.mjs";
title(3, "Rate limit: at most 3 paid calls per minute, regardless of size");
const policy = { account: "acct", version: 1, rules: [
  { id: "3-per-minute", kind: "WINDOW_VELOCITY", scope: ANY, windowMs: MIN, maxCount: 3 },
]};
const { guard, clock } = makeGuard(policy);
for (let i = 1; i <= 4; i++) await spend(guard, `call ${i} at t+0s`, draft("acct", agent("a"), "usd:cents", 1n));
clock.advance(61_000);
await spend(guard, "call 5 at t+61s (window has moved on)", draft("acct", agent("a"), "usd:cents", 1n));
