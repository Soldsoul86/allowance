#!/usr/bin/env node
/**
 * Proving you stayed inside a budget, without showing the budget.
 *
 *   node examples/budget-proof.mjs
 *
 * NOT a zero-knowledge proof. The bundle here carries its witness in the
 * clear; `IS_ZERO_KNOWLEDGE` is exported as false. What this shows is the
 * *relation* a circuit would enforce, and in particular the constraint that
 * closes the hole an entry-level commitment leaves open.
 */
import {
  ANY_REQUESTER,
  BucketCommitment,
  IS_ZERO_KNOWLEDGE,
  buildBudgetBundle,
  checkBudgetRelation,
  commitmentMatchesLedger,
  coveringBuckets,
  explainRelation,
} from "@allowance/policy";

const HOUR = 3_600_000;
const DAY = 86_400_000;
const T0 = Math.floor(Date.now() / HOUR) * HOUR;
const ACCOUNT = "acct:research-agent";
const TOKENS = "anthropic:tokens";
const say = (s = "") => process.stdout.write(`${s}\n`);

const policy = {
  account: ACCOUNT,
  version: 5,
  rules: [
    { id: "daily", kind: "WINDOW_BUDGET", scope: ANY_REQUESTER,
      asset: TOKENS, windowMs: DAY, maxTotal: 10_000n },
  ],
};

const entry = (id, amount, at) => ({
  requestId: id, account: ACCOUNT, asset: TOKENS, amount,
  destination: "vendor:api", requester: { kind: "AGENT", agentId: "researcher" },
  at, state: "SETTLED",
});

const request = {
  requestId: "call-9", account: ACCOUNT,
  requester: { kind: "AGENT", agentId: "researcher" },
  asset: TOKENS, amount: 2_000n, destination: "vendor:api",
  requestedAt: T0, approvals: [], attestations: [], memo: null,
};

const range = coveringBuckets(T0, DAY, HOUR);
const ledger = [
  entry("a", 3_000n, T0 - HOUR),
  entry("b", 4_000n, T0 - 2 * HOUR),
  entry("c", 9_000n, T0 - 3 * HOUR),   // the one a cheat would hide
];
const commitment = BucketCommitment.build(ledger, {
  account: ACCOUNT, asset: TOKENS, bucketMs: HOUR, from: range.from, to: range.to,
});

say(`\n  zero-knowledge: ${IS_ZERO_KNOWLEDGE}  — this is the relation, not a proof\n`);
say(`  ledger: 3,000 + 4,000 + 9,000 = 16,000 spent, limit is 10,000`);
say(`  commitment: ${commitment.size} hourly buckets, root ${commitment.root.slice(0, 16)}\n`);

const honest = buildBudgetBundle({ policy, request, ruleId: "daily", commitment, windowMs: DAY });

say("  1. the honest bundle — the payment does not fit, and says so\n");
say(explainRelation(checkBudgetRelation(honest)).split("\n").slice(0, 10).map((l) => `     ${l}`).join("\n"));

say("\n\n  2. the old attack: drop the bucket holding the 9,000\n");
const heavy = honest.witness.buckets.find((b) => b.leaf.total === 9_000n);
const cheat = {
  ...honest,
  witness: { ...honest.witness, buckets: honest.witness.buckets.filter((b) => b !== heavy) },
};
const cheated = checkBudgetRelation(cheat);
for (const c of cheated.constraints) {
  say(`     ${c.satisfied ? "ok  " : "FAIL"}  ${c.id}  ${c.name}`);
  if (!c.satisfied) say(`           ${c.detail}`);
}
say("\n     Under an entry-level commitment every one of those passed and the");
say("     sum came out at 7,000. The window fixes which buckets must appear,");
say("     so a missing one is a hole the verifier was already looking at.\n");

say("\n  3. what is still assumed, and how you check it\n");
say(`     ${cheated.assumptions[0]}\n`);
const understated = BucketCommitment.build(
  [entry("a", 3_000n, T0 - HOUR), entry("c", 10n, T0 - 3 * HOUR)],
  { account: ACCOUNT, asset: TOKENS, bucketMs: HOUR, from: range.from, to: range.to },
);
say(`     rebuilt from the real ledger, a doctored commitment matches: ` +
    `${commitmentMatchesLedger(understated, ledger)}`);
say(`     rebuilt from the real ledger, the real commitment matches:   ` +
    `${commitmentMatchesLedger(commitment, ledger)}\n`);
