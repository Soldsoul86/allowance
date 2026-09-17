#!/usr/bin/env node
/**
 * What the verifier actually receives.
 *
 *   node packages/circuit/scripts/demo.mjs
 *
 * A payer has spent 3,000 and 4,000 out of a 10,000 daily limit and wants to
 * spend 2,000 more. It proves the payment is inside the limit, and hands over
 * four numbers.
 *
 * None of those numbers is the limit. None is a bucket total. They are not
 * redacted or omitted by convention — they were never inputs to anything the
 * verifier receives.
 */
import {
  BUCKET_COUNT,
  proveBudget,
  publicInputsFor,
  shutdown,
  verifyBudgetProof,
} from "@spendcap/circuit";

const say = (s = "") => process.stdout.write(`${s}\n`);

const input = {
  account: "acct:research-agent",
  asset: "anthropic:tokens",
  ruleId: "daily",
  maxTotal: 10_000n,          // private
  amount: 2_000n,             // private
  requestedAt: 1_789_538_400_000,
  baseIndex: 497_094,
  bucketTotals: Array.from({ length: BUCKET_COUNT }, (_, i) =>
    i === 3 ? 3_000n : i === 17 ? 4_000n : 0n,  // private
  ),
};

say("\n  the payer knows:  limit 10,000   spent 3,000 + 4,000   paying 2,000\n");

const started = Date.now();
const proof = await proveBudget(input);
say(`  proved in ${((Date.now() - started) / 1000).toFixed(1)}s\n`);

say("  the verifier receives, in full:\n");
proof.publicSignals.forEach((s, i) => {
  const name = ["policyCommit ", "requestCommit", "bucketRoot   ", "baseIndex    "][i];
  say(`     ${name}  ${s}`);
});

const expected = await publicInputsFor(input);
say(`\n  verifies: ${await verifyBudgetProof(proof, expected)}`);

const wire = JSON.stringify(proof);
const leaked = ["10000", "3000", "4000", "2000"].filter((s) => wire.includes(s));
say(`  secrets found anywhere in the proof: ${leaked.length === 0 ? "none" : leaked.join(", ")}\n`);

say("  a verifier who believes a different limit gets nothing:");
const wrongLimit = await publicInputsFor({ ...input, maxTotal: 99_999n });
say(`     verifies against a claimed 99,999 limit: ${await verifyBudgetProof(proof, wrongLimit)}\n`);

say("  and an overspend cannot be proved at all, rather than proved badly:");
try {
  await proveBudget({ ...input, amount: 3_001n });
  say("     unexpectedly produced a proof\n");
} catch {
  say("     proving 3,001 against a 10,000 limit with 7,000 spent: refused\n");
}

await shutdown();
