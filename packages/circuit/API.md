# API — @allowance/circuit

Everything is exported from the package root.

## Encoding

```ts
const FIELD_MODULUS: bigint;   // BN254 scalar field
const MAX_AMOUNT: bigint;      // 2^64 - 1, matching the circuit's range check

function fieldFor(text: string): bigint;      // identifier -> field element
function amountToField(amount: bigint): bigint;
function timeToField(at: number): bigint;
class FieldEncodingError extends Error {}
```

`fieldFor` is SHA-256 truncated to 31 bytes: total, deterministic, and free of
the low-end bias a plain `mod` introduces. Prover and verifier must use the
same function — that shared derivation *is* the binding.

## The tree

```ts
function loadPoseidon(): Promise<PoseidonHasher>;   // async once; WASM init

class PoseidonBucketTree {
  constructor(hasher: PoseidonHasher, key: LeafKey, totals: readonly bigint[], depth: number);
  readonly root: bigint;
  readonly depth: number;
  readonly leafCount: number;
  totals(): readonly bigint[];
  siblings(index: number): readonly bigint[];   // bottom-first; directions omitted
}

interface LeafKey { account: bigint; asset: bigint; baseIndex: bigint }
```

Perfect tree, exactly `2^depth` leaves, zero-filled. Leaf is
`Poseidon(account, asset, index, total)`; node is `Poseidon(left, right)`.
`siblings` returns only the siblings — the directions are the bits of the
index, which the circuit knows as constants and the prover therefore cannot
choose.

## Proving

```ts
const TREE_DEPTH = 5;
const BUCKET_COUNT = 32;
const ARTIFACTS: { wasm: string; zkey: string; verificationKey: string };

interface BudgetProofInput {
  account: string; asset: string; ruleId: string;
  maxTotal: bigint;                  // private
  amount: bigint;                    // private
  requestedAt: number;
  baseIndex: number;
  bucketTotals: readonly bigint[];   // exactly BUCKET_COUNT, private
}

interface PublicInputs {
  policyCommit: bigint; requestCommit: bigint; bucketRoot: bigint; baseIndex: bigint;
}

function publicInputsFor(input, hasher?): Promise<PublicInputs>;
function proveBudget(input: BudgetProofInput): Promise<BudgetProof>;
function verifyBudgetProof(proof: BudgetProof, expected: PublicInputs): Promise<boolean>;
function shutdown(): Promise<void>;
class ProverError extends Error {}
```

`verifyBudgetProof` takes the **expected public inputs**, which the verifier
derives itself with `publicInputsFor` from the values it believes. Passing the
prover's own commitments straight through would verify a proof about numbers
the prover chose.

`proveBudget` **throws on a false statement** rather than returning an invalid
proof: the witness is unsatisfiable, so no proof exists.

`shutdown` releases snarkjs's WASM worker pool. Without it a process that has
proved once never exits.

## Building the artifacts

```
npm run circuit     # compile + ceremony + setup, minutes
```

`scripts/setup.mjs` is resumable — each step is skipped when its output exists.
Artifacts are build outputs, not source, and the ceremony is **development
only** (see the README).
