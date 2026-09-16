import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Journal, FileJournalStore } from "@soldsoul86/journal";
import { JournalLedgerStore, buildReceipt, verifyReceipt } from "@soldsoul86/policy";
import { makeGuard, draft, spend, title, agent, ANY, DAY, T0 } from "./lib.mjs";
title(10, "Durable ledger on disk: a restart resumes the budget, an ambiguous failure is reconciled, a receipt verifies");
const policy = { account: "acct", version: 1, rules: [
  { id: "daily", kind: "WINDOW_BUDGET", scope: ANY, asset: "anthropic:tokens", windowMs: DAY, maxTotal: 10_000n },
]};
const dir = mkdtempSync(join(tmpdir(), "allowance-"));
const open = async () => {
  const journal = await Journal.open({ store: await FileJournalStore.open(dir), device: "laptop", lane: "laptop", now: () => T0 });
  const store = await JournalLedgerStore.open({ journal });
  return { journal, store, ...makeGuard(policy, { store }) };
};
let run = await open();
await spend(run.guard, "process 1: spend 6,000", draft("acct", agent("a"), "anthropic:tokens", 6_000n));
const lost = await run.guard.run(draft("acct", agent("a"), "anthropic:tokens", 3_000n), async () => { throw new Error("socket hang up"); });
console.log(`  ${lost.outcome.padEnd(7)} process 1: 3,000 call died mid-flight, reservation ${lost.reservation.requestId} stays open`);
await run.journal.close();
console.log("  ---     process exits; only the journal files on disk survive");
run = await open();
console.log(`  RESUMED process 2 rebuilt the ledger from disk: ${run.store.size} entries, journal verified`);
await spend(run.guard, "process 2: spend 2,000 (6,000 + 3,000 held + 2,000 = 11,000)", draft("acct", agent("a"), "anthropic:tokens", 2_000n));
run.clock.advance(1);
const report = await run.guard.reconcile({ observe: async (entry) => entry.amount === 3_000n ? { state: "NOT_SPENT" } : { state: "UNKNOWN" } }, 0);
console.log(`  RECON   vendor's billing says the 3,000 never happened: reversed ${report.reversed.length}, unresolved ${report.unresolved.length}`);
await spend(run.guard, "process 2: spend 2,000 again (6,000 + 2,000 = 8,000)", draft("acct", agent("a"), "anthropic:tokens", 2_000n));
// The receipt for the payment that never happened. Its request is rebuilt
// from the reservation; a real caller keeps the SpendRequest it authorised.
const r = lost.reservation;
const request = { requestId: r.requestId, account: r.account, requester: r.requester, asset: r.asset,
  amount: r.amount, destination: r.destination, requestedAt: r.at, approvals: [], attestations: [], memo: null };
const facts = run.store.factsFor(r.requestId);
const receipt = buildReceipt({ request, decision: lost.decision, outcome: { state: "REVERSED", amount: 0n },
  facts, issuedAt: T0, policy, ledgerContext: await run.store.entries("acct") });
const v = verifyReceipt(receipt);
console.log(`  RECEIPT for the reversed payment: ${v.verified ? "VERIFIED" : v.partial ? "PARTIAL" : "FAILED"} (${v.checks.filter(c => c.status === "PASS").length}/${v.checks.length} checks passed, ${facts.length} journal events attached)`);
await run.journal.close();
