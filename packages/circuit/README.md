# @allowance/circuit

**A Groth16 proof that a payment stayed inside a budget, without revealing the budget.**

This is the first thing in the stack that is genuinely zero-knowledge. The
verifier is handed four field elements and a proof. It learns that *some*
policy permitted *some* payment against *some* ledger. It does not learn the
limit, and it does not learn a single bucket total.

```
npm run circuit          # compile + trusted setup (minutes, once)
npm test -w @allowance/circuit
```

## Install

```bash
npm install @allowance/circuit
```

**The published package contains the circuit source, not proving keys.** You run
your own ceremony:

```bash
npm run circuit     # ~40 minutes; writes artifacts/ locally
```

That is deliberate, and the section below says why. A proving key is 48MB and
the ceremony that produces it here is a single-participant development one. Had
we shipped those keys, every user would be trusting randomness that was never
destroyed — by someone else, silently, because it came down with an `npm
install`. Build your own, or run a real multi-party ceremony.

## Why it is a separate package

`@allowance/policy` must run anywhere, offline, with nothing installed — it
is what decides whether money moves. A proving system is a large, opinionated
dependency with a WASM runtime and a hundred megabytes of keys. Keeping it out
is the same discipline that keeps model providers behind ports rather than in
the kernel: proving is an optional capability layered on top, never a
precondition for deciding.

## What the circuit proves

| | |
|---|---|
| **Public** | `policyCommit`, `requestCommit`, `bucketRoot`, `baseIndex` |
| **Private** | the limit, the payment amount, and all bucket totals |

Constraints, in `circuits/budget.circom`:

- `Poseidon(maxTotal, windowBuckets, asset, rule) == policyCommit` — the limit
  is pinned without being shown
- `Poseidon(amount, requestedAt, account, asset) == requestCommit`
- each bucket's leaf is `Poseidon(account, asset, index, total)` and its path
  is walked to `bucketRoot`
- `sum(totals) + amount <= maxTotal`

## Completeness became structural

The reference relation in `@allowance/policy` has to *check* that the prover
supplied every bucket in the window. The circuit does not need to:
`nBuckets` is fixed at compile time, each slot is verified at its own position,
and the path directions are the bits of a **loop constant** rather than a
prover input.

There is no slot to leave empty and no way to move a leaf. Omission is not
refused — it is unrepresentable.

## Range checks are not optional

Field arithmetic wraps. Without decomposing every amount to 64 bits, a prover
supplies `p-1` as a bucket total, the sum wraps past the modulus, and an
arbitrarily large spend reads as tiny. Every total and the payment are
range-checked before they are added.

## ⚠️ The trusted setup is for development only

Groth16 needs a structured reference string, and whoever generates it can forge
proofs unless the randomness is destroyed. `artifacts/` is produced locally and
unattended by `npm run circuit`, so **these keys prove nothing to anyone who
does not trust this machine.**

Production needs a multi-party ceremony, or a proving system with no trusted
setup (PLONK with a universal SRS, or a STARK). The circuit, the encoding and
the tests are what transfer; the keys are not.

## Documents

- [`DESIGN.md`](./DESIGN.md) — the encoding layer, and where soundness actually lives
- [`API.md`](./API.md) — the exported surface
- [`TESTS.md`](./TESTS.md) — what is covered, including what the verifier cannot see
