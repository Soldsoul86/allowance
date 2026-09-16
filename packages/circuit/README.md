# @soldsoul86/circuit

A Groth16 circuit proving a payment stayed inside a budget **without revealing
the budget**, the amount, or the ledger.

```bash
npm install @soldsoul86/circuit
```

**The published package contains the circuit source, not proving keys.** Run
your own ceremony:

```bash
npm run circuit     # ~40 minutes; writes artifacts/ locally
```

That is deliberate. A proving key is 48MB, and the ceremony that produces it
here is a single-participant development one — whoever generates it can forge
proofs unless the randomness is destroyed. Shipping those keys would hand that
trust to strangers silently, as a side effect of `npm install`. Build your own,
or run a real multi-party ceremony.

The verifier receives four field elements: a policy commitment, a request
commitment, a ledger root, and a public bucket index. The limit, the amount and
every bucket total are inputs to a Poseidon hash and never values on the wire.

110,028 constraints, 32 buckets, BN254. Proofs take roughly six seconds.

⚠️ **Not production-ready without a trusted setup you actually trust.** The
circuit and the encoding are what transfer; the keys are not.

Apache-2.0 — but snarkjs, circomlibjs and circom are **GPL-3.0**. This is the
one package here whose distribution terms are not simply Apache-2.0. See
[`NOTICE`](NOTICE).
