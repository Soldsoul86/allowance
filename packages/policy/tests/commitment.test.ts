/**
 * The commitment.
 *
 * Two tests here are about attacks rather than behaviour: an internal node
 * must not be presentable as a leaf (domain separation), and two different
 * ledgers must never share a root (which is what padding by duplication
 * silently breaks). Both are the reason this follows RFC 6962 rather than the
 * obvious hand-rolled tree.
 */
import { ok, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";

import { LedgerCommitment, emptyRoot, verifyInclusion } from "../src/index.js";

const entries = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `e-${i}`, amount: BigInt(i) }));

describe("roots", () => {
  it("an empty ledger has a root of its own", () => {
    strictEqual(new LedgerCommitment([]).root, emptyRoot());
  });

  it("the root is stable for the same contents", () => {
    strictEqual(new LedgerCommitment(entries(7)).root, new LedgerCommitment(entries(7)).root);
  });

  it("adding an entry changes the root", () => {
    ok(new LedgerCommitment(entries(7)).root !== new LedgerCommitment(entries(8)).root);
  });

  it("reordering changes the root", () => {
    const forward = entries(4);
    const swapped = [forward[1]!, forward[0]!, forward[2]!, forward[3]!];
    ok(new LedgerCommitment(forward).root !== new LedgerCommitment(swapped).root);
  });

  it("two ledgers of different length never collide", () => {
    // The classic break: padding an odd level by duplicating the last leaf
    // makes [a, b, b] and [a, b] produce the same root. RFC 6962 promotes
    // instead, so they cannot.
    const three = [{ id: "a" }, { id: "b" }, { id: "b" }];
    const two = [{ id: "a" }, { id: "b" }];
    ok(new LedgerCommitment(three).root !== new LedgerCommitment(two).root);
  });
});

describe("inclusion proofs", () => {
  it("every leaf proves, at every size", () => {
    for (const size of [1, 2, 3, 4, 5, 8, 9, 16, 33]) {
      const tree = new LedgerCommitment(entries(size));
      for (let i = 0; i < size; i++) {
        const proof = tree.prove(i);
        ok(proof !== null, `no proof at ${i}/${size}`);
        ok(verifyInclusion(entries(size)[i], proof, tree.root), `failed at ${i}/${size}`);
      }
    }
  });

  it("a proof does not transfer to another value", () => {
    const tree = new LedgerCommitment(entries(8));
    const proof = tree.prove(3)!;
    strictEqual(verifyInclusion({ id: "e-4", amount: 4n }, proof, tree.root), false);
  });

  it("a proof does not transfer to another root", () => {
    const tree = new LedgerCommitment(entries(8));
    const other = new LedgerCommitment(entries(9));
    strictEqual(verifyInclusion(entries(8)[3], tree.prove(3)!, other.root), false);
  });

  it("an internal node cannot be presented as a leaf", () => {
    // Without the 0x00/0x01 domain separation this is a second-preimage
    // attack: a proof of inclusion proving something never inserted.
    const tree = new LedgerCommitment(entries(4));
    const sibling = tree.prove(0)!.path[0]!.hash;
    strictEqual(verifyInclusion(sibling, { index: 0, size: 2, path: [] }, tree.root), false);
  });

  it("refuses an out-of-range index instead of proving one", () => {
    const tree = new LedgerCommitment(entries(4));
    for (const index of [-1, 4, 1.5, Number.NaN]) {
      strictEqual(tree.prove(index), null);
    }
  });
});

describe("malformed proofs never throw", () => {
  const tree = new LedgerCommitment(entries(8));
  const good = tree.prove(3)!;

  it("rejects nonsense indices and sizes", () => {
    for (const proof of [
      { ...good, index: -1 },
      { ...good, index: 8, size: 8 },
      { ...good, size: 0 },
      { ...good, index: 1.5 },
      { ...good, size: Number.NaN },
    ]) {
      strictEqual(verifyInclusion(entries(8)[3], proof, tree.root), false);
    }
  });

  it("rejects a path that is not hashes", () => {
    for (const path of [
      [{ hash: "zz", right: true }],
      [{ hash: "", right: true }],
      [{ hash: "ab".repeat(64), right: false }],
    ]) {
      strictEqual(verifyInclusion(entries(8)[3], { ...good, path }, tree.root), false);
    }
  });

  it("rejects an absurdly deep path rather than walking it", () => {
    const deep = Array.from({ length: 100 }, () => ({ hash: "00".repeat(32), right: true }));
    strictEqual(verifyInclusion(entries(8)[3], { ...good, path: deep }, tree.root), false);
  });
});
