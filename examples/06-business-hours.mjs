import { makeGuard, draft, spend, title, agent, ANY, HOUR } from "./lib.mjs";
title(6, "Spending allowed only 09:00-17:00 UTC; an overnight window wraps midnight correctly");
const policy = { account: "acct", version: 1, rules: [
  { id: "office-hours", kind: "TIME_WINDOW", scope: ANY, fromMinuteUtc: 9 * 60, toMinuteUtc: 17 * 60 },
]};
const { guard, clock } = makeGuard(policy);
await spend(guard, "09:00 UTC", draft("acct", agent("a"), "tok", 1n));
clock.advance(7 * HOUR + 59 * 60_000);
await spend(guard, "16:59 UTC", draft("acct", agent("a"), "tok", 1n));
clock.advance(60_000);
await spend(guard, "17:00 UTC (window is [from, to), so 17:00 is outside)", draft("acct", agent("a"), "tok", 1n));
const night = { account: "acct", version: 1, rules: [{ id: "batch", kind: "TIME_WINDOW", scope: ANY, fromMinuteUtc: 22 * 60, toMinuteUtc: 6 * 60 }] };
const n = makeGuard(night, { at: Date.UTC(2026, 8, 16, 23, 30) });
await spend(n.guard, "overnight batch window 22:00-06:00, at 23:30", draft("acct", agent("b"), "tok", 1n));
n.clock.advance(4 * HOUR);
await spend(n.guard, "same window at 03:30", draft("acct", agent("b"), "tok", 1n));
n.clock.advance(3 * HOUR);
await spend(n.guard, "same window at 06:30", draft("acct", agent("b"), "tok", 1n));
