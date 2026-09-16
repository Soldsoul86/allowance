pragma circom 2.1.6;

include "poseidon.circom";
include "comparators.circom";
include "bitify.circom";

/*
 * Proving a payment stayed inside a private budget.
 *
 * Public:   policyCommit, requestCommit, bucketRoot, baseIndex
 * Private:  the limit, the amount, and every per-bucket total
 *
 * The verifier learns that some policy hashing to `policyCommit` permitted
 * some payment hashing to `requestCommit` against a ledger committed to by
 * `bucketRoot`. It learns neither the limit nor what was spent.
 *
 * ## Completeness is structural here
 *
 * The reference implementation had to *check* that the prover supplied every
 * bucket in the window. A circuit does not: `nBuckets` is fixed at compile
 * time, each slot is verified at its own position, and the path directions are
 * the bits of a loop constant rather than a prover input. There is no slot to
 * leave empty and no way to move a leaf. Omission is not refused — it is
 * unrepresentable.
 *
 * ## Range checks are not optional
 *
 * Field arithmetic wraps. Without constraining every amount to 64 bits, a
 * prover supplies p-1 as a bucket total, the sum wraps past the modulus, and
 * an arbitrarily large spend reads as tiny. Every total and the payment itself
 * are decomposed to 64 bits before they are summed. 32 buckets of 2^64 is
 * 2^69, far below the modulus, so the sum itself cannot wrap.
 */

/* One leaf: this account, this asset, this bucket, this total. The key is
   inside the hash, so a leaf cannot be lifted into another commitment. */
template BucketLeaf() {
    signal input account;
    signal input asset;
    signal input index;
    signal input total;
    signal output out;

    component h = Poseidon(4);
    h.inputs[0] <== account;
    h.inputs[1] <== asset;
    h.inputs[2] <== index;
    h.inputs[3] <== total;
    out <== h.out;
}

/*
 * Walks one leaf up to the root along a path whose directions are constants.
 *
 * `position` is a compile-time constant supplied by the caller's loop, so the
 * bits that decide left-from-right are baked into the constraint system. The
 * prover chooses only the sibling hashes, and a wrong sibling cannot reach the
 * committed root.
 */
template MerklePath(depth, position) {
    signal input leaf;
    signal input siblings[depth];
    signal output root;

    signal levels[depth + 1];
    levels[0] <== leaf;

    component hashes[depth];
    for (var i = 0; i < depth; i++) {
        hashes[i] = Poseidon(2);
        /* (position >> i) & 1 is a constant: 0 means we are the left child. */
        if (((position >> i) & 1) == 0) {
            hashes[i].inputs[0] <== levels[i];
            hashes[i].inputs[1] <== siblings[i];
        } else {
            hashes[i].inputs[0] <== siblings[i];
            hashes[i].inputs[1] <== levels[i];
        }
        levels[i + 1] <== hashes[i].out;
    }

    root <== levels[depth];
}

template BudgetProof(depth) {
    var nBuckets = 1 << depth;

    /* ---- public ---- */
    signal input policyCommit;
    signal input requestCommit;
    signal input bucketRoot;
    signal input baseIndex;

    /* ---- private ---- */
    signal input maxTotal;
    signal input windowBuckets;
    signal input assetId;
    signal input ruleId;
    signal input accountId;
    signal input amount;
    signal input requestedAt;
    signal input bucketTotals[nBuckets];
    signal input siblings[nBuckets][depth];

    /* C1 — the limit is bound by a commitment the verifier recomputes, so it
       is pinned without ever being revealed. */
    component policyHash = Poseidon(4);
    policyHash.inputs[0] <== maxTotal;
    policyHash.inputs[1] <== windowBuckets;
    policyHash.inputs[2] <== assetId;
    policyHash.inputs[3] <== ruleId;
    policyCommit === policyHash.out;

    /* C2 — same for the payment. */
    component requestHash = Poseidon(4);
    requestHash.inputs[0] <== amount;
    requestHash.inputs[1] <== requestedAt;
    requestHash.inputs[2] <== accountId;
    requestHash.inputs[3] <== assetId;
    requestCommit === requestHash.out;

    /* C3 — the window really is the one the commitment spans. A prover that
       could shrink it would prove a weaker statement than it claims. */
    windowBuckets === nBuckets;

    /* Range checks before any addition. See the header. */
    component amountBits = Num2Bits(64);
    amountBits.in <== amount;

    component totalBits[nBuckets];
    component leaves[nBuckets];
    component paths[nBuckets];
    signal running[nBuckets + 1];
    running[0] <== 0;

    for (var i = 0; i < nBuckets; i++) {
        totalBits[i] = Num2Bits(64);
        totalBits[i].in <== bucketTotals[i];

        /* C4, C5, C6 at once. The leaf carries its own index, and the path is
           walked at position i — a constant. Nothing here is negotiable by the
           prover, which is why completeness needs no separate check. */
        leaves[i] = BucketLeaf();
        leaves[i].account <== accountId;
        leaves[i].asset <== assetId;
        leaves[i].index <== baseIndex + i;
        leaves[i].total <== bucketTotals[i];

        paths[i] = MerklePath(depth, i);
        paths[i].leaf <== leaves[i].out;
        for (var d = 0; d < depth; d++) {
            paths[i].siblings[d] <== siblings[i][d];
        }
        bucketRoot === paths[i].root;

        running[i + 1] <== running[i] + bucketTotals[i];
    }

    /* C7 — the spend, including this payment, is inside the private limit. */
    component fits = LessEqThan(70);
    fits.in[0] <== running[nBuckets] + amount;
    fits.in[1] <== maxTotal;
    fits.out === 1;
}

/* depth 5 => 32 buckets. A day at 45-minute buckets, or any window the
   encoding layer chooses to express as 32 of them. */
component main {public [policyCommit, requestCommit, bucketRoot, baseIndex]} = BudgetProof(5);
