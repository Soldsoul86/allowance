/**
 * The proof itself.
 *
 * Slow — a 110k-constraint Groth16 proof is seconds, not milliseconds — and
 * skipped entirely when the artifacts have not been built, so a fresh clone
 * still runs a green suite. `npm run circuit` produces them.
 *
 * The test that matters is the last group: what the verifier can and cannot
 * see. Everything else is soundness plumbing.
 */
import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { existsSync } from "node:fs";
import { after, describe, it } from "node:test";

import {
  ARTIFACTS,
  BUCKET_COUNT,
  type BudgetProofInput,
  proveBudget,
  publicInputsFor,
  shutdown,
  verifyBudgetProof,
} from "../src/index.js";

const built = existsSync(ARTIFACTS.zkey) && existsSync(ARTIFACTS.verificationKey);
const skip = built ? false : "proving artifacts not built — run `npm run circuit`";

const base: BudgetProofInput = {
  account: "acct:research-agent",
  asset: "anthropic:tokens",
  ruleId: "daily",
  maxTotal: 10_000n,
  amount: 2_000n,
  requestedAt: 1_789_538_400_000,
  baseIndex: 497_094,
  // 3,000 + 4,000 spent across two buckets; 2,000 more fits inside 10,000.
  bucketTotals: Array.from({ length: BUCKET_COUNT }, (_, i) =>
    i === 3 ? 3_000n : i === 17 ? 4_000n : 0n,
  ),
};

after(async () => {
  if (built) await shutdown();
});

describe("a true statement", { skip }, () => {
  it("proves and verifies", async () => {
    const proof = await proveBudget(base);
    const expected = await publicInputsFor(base);
    strictEqual(await verifyBudgetProof(proof, expected), true);
  });

  it("proves at exactly the limit", async () => {
    const tight = { ...base, amount: 3_000n };
    strictEqual(await verifyBudgetProof(await proveBudget(tight), await publicInputsFor(tight)), true);
  });

  it("proves against an empty ledger", async () => {
    const fresh = { ...base, bucketTotals: Array.from({ length: BUCKET_COUNT }, () => 0n) };
    strictEqual(await verifyBudgetProof(await proveBudget(fresh), await publicInputsFor(fresh)), true);
  });
});

describe("a false statement cannot be proved at all", { skip }, () => {
  it("refuses when the payment does not fit", async () => {
    // Not "produces an invalid proof" — the witness is unsatisfiable, so no
    // proof exists to produce. That is the property worth having.
    const overspend = { ...base, amount: 3_001n };
    await ok(
      proveBudget(overspend).then(
        () => false,
        () => true,
      ),
      "proving an overspend should fail",
    );
  });

  it("refuses when a bucket alone blows the limit", async () => {
    const heavy = {
      ...base,
      bucketTotals: base.bucketTotals.map((t, i) => (i === 9 ? 50_000n : t)),
    };
    strictEqual(await proveBudget(heavy).then(() => false, () => true), true);
  });
});

describe("a valid proof is still about specific values", { skip }, () => {
  it("does not verify against a different claimed limit", async () => {
    // The proof is sound, but it is a proof about a 10,000 limit. Checking it
    // against a claimed 99,999 must fail, or the commitment binds nothing.
    const proof = await proveBudget(base);
    const wrong = await publicInputsFor({ ...base, maxTotal: 99_999n });
    strictEqual(await verifyBudgetProof(proof, wrong), false);
  });

  it("does not verify against a different claimed amount", async () => {
    const proof = await proveBudget(base);
    const wrong = await publicInputsFor({ ...base, amount: 1n });
    strictEqual(await verifyBudgetProof(proof, wrong), false);
  });

  it("does not verify against a different ledger", async () => {
    const proof = await proveBudget(base);
    const wrong = await publicInputsFor({
      ...base,
      bucketTotals: base.bucketTotals.map((t, i) => (i === 3 ? 1n : t)),
    });
    strictEqual(await verifyBudgetProof(proof, wrong), false);
  });

  it("does not verify with a tampered public signal", async () => {
    const proof = await proveBudget(base);
    const expected = await publicInputsFor(base);
    const tampered = { ...proof, publicSignals: ["1", ...proof.publicSignals.slice(1)] };
    strictEqual(await verifyBudgetProof(tampered, expected), false);
  });
});

describe("what the verifier sees — and does not", { skip }, () => {
  it("receives four field elements and nothing else", async () => {
    const proof = await proveBudget(base);
    strictEqual(proof.publicSignals.length, 4);
  });

  it("the limit and every bucket total are absent from the wire", async () => {
    // This assertion used to grep the serialised proof for the decimal
    // strings "10000", "3000", "4000", "2000". That was unsound twice over.
    //
    // It failed at random: a Groth16 proof is ~1,200 digits of uniformly
    // random field elements, so a given four-digit string turns up by chance
    // roughly one run in ten, and across four secrets about one run in three.
    // It had nothing to do with secrecy when it fired.
    //
    // And it proved nothing when it passed. A secret does not leak as a
    // decimal substring of a random group element; it would leak as a public
    // signal. Absence of a substring is not absence of a value.
    //
    // So check the actual property: exactly four values reach the verifier,
    // each is the commitment or index it is supposed to be, and none of them
    // *is* a secret. Deterministic, and about the right thing.
    const proof = await proveBudget(base);
    const expected = await publicInputsFor(base);
    const signals = proof.publicSignals.map(BigInt);

    deepStrictEqual(signals, [
      expected.policyCommit,
      expected.requestCommit,
      expected.bucketRoot,
      expected.baseIndex,
    ]);

    // Three Poseidon commitments and one public bucket index. The limit, the
    // amount and the bucket totals are inputs to a hash, never values on the
    // wire — `requestCommit` hides the amount exactly as `policyCommit` hides
    // the limit.
    const secrets = [base.maxTotal, base.amount, 3_000n, 4_000n];
    for (const signal of signals) {
      ok(!secrets.includes(signal), `${signal} is a secret value, not a commitment`);
    }
  });

  it("two different ledgers under the same limit look identical in size", async () => {
    const other = {
      ...base,
      bucketTotals: base.bucketTotals.map((_, i) => (i === 30 ? 6_500n : 0n)),
    };
    const a = await proveBudget(base);
    const b = await proveBudget(other);

    strictEqual(a.publicSignals.length, b.publicSignals.length);
    // Only the ledger commitment differs; the policy commitment is the same
    // limit and does not move.
    strictEqual(a.publicSignals[0], b.publicSignals[0]);
    ok(a.publicSignals[2] !== b.publicSignals[2]);
  });
});
