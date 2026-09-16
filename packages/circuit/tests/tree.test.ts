/**
 * The Poseidon tree, checked against the shape the circuit assumes.
 *
 * These run without any proving artifacts, so they stay fast and they fail
 * loudly if the tree and the circuit ever drift apart on leaf construction or
 * path ordering — which is the failure that produces a valid-looking proof of
 * the wrong statement.
 */
import { ok, strictEqual, throws } from "node:assert/strict";
import { before, describe, it } from "node:test";

import { PoseidonBucketTree, fieldFor, loadPoseidon, type PoseidonHasher } from "../src/index.js";

const DEPTH = 5;
const LEAVES = 1 << DEPTH;
const key = { account: fieldFor("acct:a"), asset: fieldFor("TOK"), baseIndex: 1000n };

let hasher: PoseidonHasher;
before(async () => {
  hasher = await loadPoseidon();
});

const totals = (values: Partial<Record<number, bigint>> = {}) =>
  Array.from({ length: LEAVES }, (_, i) => values[i] ?? 0n);

describe("shape", () => {
  it("insists on exactly 2^depth leaves", () => {
    throws(() => new PoseidonBucketTree(hasher, key, [0n, 1n], DEPTH), /exactly 32/);
  });

  it("is deterministic", () => {
    const a = new PoseidonBucketTree(hasher, key, totals({ 3: 7n }), DEPTH);
    const b = new PoseidonBucketTree(hasher, key, totals({ 3: 7n }), DEPTH);
    strictEqual(a.root, b.root);
  });

  it("an all-zero tree still has a root", () => {
    ok(new PoseidonBucketTree(hasher, key, totals(), DEPTH).root > 0n);
  });
});

describe("the root moves with anything that matters", () => {
  const base = () => new PoseidonBucketTree(hasher, key, totals({ 3: 7n }), DEPTH).root;

  it("a changed total", () => {
    ok(new PoseidonBucketTree(hasher, key, totals({ 3: 8n }), DEPTH).root !== base());
  });

  it("the same total in a different bucket", () => {
    ok(new PoseidonBucketTree(hasher, key, totals({ 4: 7n }), DEPTH).root !== base());
  });

  it("a different account", () => {
    const other = { ...key, account: fieldFor("acct:b") };
    ok(new PoseidonBucketTree(hasher, other, totals({ 3: 7n }), DEPTH).root !== base());
  });

  it("a different asset", () => {
    const other = { ...key, asset: fieldFor("OTHER") };
    ok(new PoseidonBucketTree(hasher, other, totals({ 3: 7n }), DEPTH).root !== base());
  });

  it("a different base index", () => {
    const other = { ...key, baseIndex: 2000n };
    ok(new PoseidonBucketTree(hasher, other, totals({ 3: 7n }), DEPTH).root !== base());
  });
});

describe("paths", () => {
  it("every leaf has a path of exactly `depth` siblings", () => {
    const tree = new PoseidonBucketTree(hasher, key, totals({ 7: 5n }), DEPTH);
    for (let i = 0; i < LEAVES; i++) strictEqual(tree.siblings(i).length, DEPTH);
  });

  it("walking a path bottom-up reaches the root, using the bits of the index", () => {
    // This mirrors MerklePath in the circuit exactly. If the two ever disagree
    // on ordering, proofs would verify against a root nobody committed to.
    const tree = new PoseidonBucketTree(hasher, key, totals({ 11: 42n, 2: 9n }), DEPTH);
    for (const index of [0, 1, 2, 11, 30, 31]) {
      let running = hasher.hash([
        key.account,
        key.asset,
        key.baseIndex + BigInt(index),
        tree.totals()[index]!,
      ]);
      const siblings = tree.siblings(index);
      for (let d = 0; d < DEPTH; d++) {
        running =
          ((index >> d) & 1) === 0
            ? hasher.hash([running, siblings[d]!])
            : hasher.hash([siblings[d]!, running]);
      }
      strictEqual(running, tree.root, `path for leaf ${index}`);
    }
  });

  it("refuses an index outside the tree", () => {
    const tree = new PoseidonBucketTree(hasher, key, totals(), DEPTH);
    for (const bad of [-1, LEAVES, 1.5]) throws(() => tree.siblings(bad));
  });
});
