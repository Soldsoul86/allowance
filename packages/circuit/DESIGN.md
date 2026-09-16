# Design — @allowance/circuit

## The encoding is where soundness actually lives

A circuit computes over elements of a prime field. Strings, JSON and `bigint`
amounts do not exist inside it. Every value has to be mapped in, and **the map
has to be identical on both sides** — otherwise a proof about your data is a
proof about different numbers, and it verifies perfectly.

This is the layer people skip when they say "and then we add a zk proof". It
lives in one file (`field.ts`), is deterministic, and is used by prover and
verifier alike.

`fieldFor` hashes an identifier with SHA-256 and truncates to 31 bytes. The
truncation is not laziness: reducing a full 32-byte digest modulo the field
biases the low end of the range, and truncating avoids that while keeping the
map total — no identifier ever has to be rejected for landing badly.

## Binding happens outside the circuit

Nothing inside the constraint system knows what a `SpendPolicy` is. The link to
real data is made outside it, and made the same way twice: `publicInputsFor`
derives the commitments from the real values, the prover feeds them in, and the
verifier **recomputes them and checks they match the proof's public signals**.

That is why `verifyBudgetProof` takes the policy parameters rather than the
commitments. A verifier handed `policyCommit` directly would be checking a
proof about numbers the prover chose — sound, and about nothing in particular.

## Why Poseidon, and why the tree is rebuilt

`@allowance/policy` commits with SHA-256, which is right for a commitment
people verify on a CPU and wrong for one verified inside a circuit: a SHA-256
compression is tens of thousands of constraints and a 32-leaf tree would need
hundreds of them. Poseidon is designed for the field and costs a couple of
hundred.

So the tree is rebuilt in `tree.ts` rather than reused. The two must agree on
*shape* while disagreeing on hash, and the circuit is the specification: a
perfect tree of exactly `2^depth` leaves, a leaf that carries its own key, and
path directions taken from the bits of the index. A test walks a path by hand
and checks it reaches the root, because if the tree and the circuit ever drift
on ordering the result is a valid-looking proof of the wrong statement.

## Completeness, one layer down

The reference relation checks that the witness holds every bucket in the
window. The circuit cannot be given a partial witness at all: `nBuckets` is a
compile-time constant, each slot is constrained at its own position, and
`(position >> i) & 1` is evaluated by the compiler rather than supplied. The
prover chooses only the sibling hashes, and wrong siblings cannot reach the
committed root.

That is the difference between a rule that is enforced and a rule that is
impossible to break.

## Range checks before addition

Field arithmetic wraps at the modulus. A prover who supplies `p-1` as a bucket
total makes the sum wrap and a vast spend read as small. Every total and the
payment go through `Num2Bits(64)` first. 32 buckets of 2^64 is 2^69, far below
the modulus, so the sum itself cannot overflow — the comparison is then a
plain `LessEqThan(70)`.

`amountToField` enforces the same 64-bit bound in TypeScript, so a caller gets
a clear error rather than an unsatisfiable constraint two layers down.

## A false statement produces no proof at all

Worth stating precisely, because it is the property that matters: an overspend
does not yield an invalid proof that a verifier then rejects. The witness is
unsatisfiable, so **no proof exists to produce**. The prover fails.

## Known limits

- **The trusted setup is a development ceremony.** Generated locally,
  unattended, entropy not destroyed. Anyone with this machine's history could
  forge proofs. Production needs a multi-party ceremony or a setup-free system.
- **The window is exactly 32 buckets.** Expressing a policy's `windowMs` as
  some number of buckets is the encoding layer's job, and carries the
  edge over-count documented in `@allowance/policy`.
- **Amounts are capped at 64 bits.** Enforced in both places; larger assets
  would need a wider range check and a larger comparator.
- **One statement.** Only the window-budget rule is proved. Allowlists,
  velocity and approvals are not in the circuit, and each would be its own
  statement rather than an extension of this one.
- **Proving is slow and the keys are large.** Seconds per proof and a zkey in
  the tens of megabytes; this is why the dependency stays out of the engine.
