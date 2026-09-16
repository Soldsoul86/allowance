// Shared helpers for the examples. Each example is a standalone script:
//   node examples/01-per-agent-token-budgets.mjs
// or all of them in order with `npm run examples`.
import { SpendGuard, MemoryLedgerStore, ManualClock, singlePolicy, summarize } from "@soldsoul86/policy";

export const T0 = Date.UTC(2026, 8, 16, 9, 0, 0); // 2026-09-16 09:00 UTC
export const MIN = 60_000;
export const HOUR = 60 * MIN;
export const DAY = 24 * HOUR;

export const agent = (id) => ({ kind: "AGENT", agentId: id });
export const OWNER = { kind: "OWNER" };
export const ANY = { kind: "ANY" };
export const only = (...keys) => ({ kind: "REQUESTERS", requesters: keys });

export function makeGuard(policy, opts = {}) {
  const clock = new ManualClock(opts.at ?? T0);
  const store = opts.store ?? new MemoryLedgerStore();
  const guard = new SpendGuard({ store, policyFor: singlePolicy(policy), clock, ...opts.guard });
  return { guard, clock, store };
}

let seq = 0;
export const draft = (account, requester, asset, amount, destination = "vendor:api", extra = {}) => ({
  requestId: `r${++seq}`, account, requester, asset, amount, destination, ...extra,
});

/** Runs one spend and prints a one-line verdict. Returns the outcome. */
export async function spend(guard, label, d, actual = d.amount) {
  const out = await guard.run(d, async (grant) => { grant.report(actual); return true; });
  const verdict =
    out.outcome === "COMPLETED" ? "ALLOW  " :
    out.outcome === "REFUSED" ? (out.decision.outcome === "REQUIRES_APPROVAL" ? "HOLD   " : "DENY   ") :
    out.outcome.padEnd(7);
  const why =
    out.outcome === "REFUSED" ? summarize(out.decision).replace(/^\S+ \S+ /, "") :
    out.outcome === "COMPLETED" ? `spent ${out.actual}` : "";
  console.log(`  ${verdict} ${label.padEnd(58)} ${why}`);
  return out;
}

export const title = (n, s) => console.log(`\n[${n}] ${s}`);
