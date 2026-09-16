/**
 * Proving and verifying.
 *
 * This is the first thing in the whole stack that is genuinely
 * zero-knowledge. The verifier is handed four field elements and a proof. It
 * learns that *some* policy hashing to `policyCommit` permitted *some* payment
 * hashing to `requestCommit` against a ledger committed to by `bucketRoot`. It
 * does not learn the limit, and it does not learn a single one of the
 * thirty-two bucket totals.
 *
 * ## Where the binding actually happens
 *
 * A circuit proves a relation between field elements. Nothing inside it knows
 * what a `SpendPolicy` is. The link to real data is made *outside*, and it is
 * made the same way on both sides: {@link publicInputsFor} derives the
 * commitments from the real objects, the prover feeds them in, and the
 * verifier recomputes them and checks they match the proof's public signals.
 *
 * A verifier that skipped that recomputation would be checking a proof about
 * numbers it had been handed, which is why {@link verifyBudgetProof} takes the
 * policy parameters rather than the commitments.
 *
 * ## The setup is a development ceremony
 *
 * Groth16 needs a structured reference string, and whoever generates it can
 * forge proofs unless the randomness is destroyed. `artifacts/` is produced
 * locally and unattended, so **these keys prove nothing to anyone who does not
 * trust this machine**. Production needs a multi-party ceremony or a system
 * without a trusted setup. The circuit and the encoding are what transfer.
 */
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { groth16, type Groth16Proof } from "snarkjs";

import { amountToField, fieldFor, timeToField } from "./field.js";
import { PoseidonBucketTree, loadPoseidon, type PoseidonHasher } from "./tree.js";

/** Fixed by the circuit. Changing either means recompiling and a new setup. */
export const TREE_DEPTH = 5;
export const BUCKET_COUNT = 1 << TREE_DEPTH;

const here = dirname(fileURLToPath(import.meta.url));
const artifacts = join(here, "..", "..", "artifacts");

export const ARTIFACTS = {
  wasm: join(artifacts, "budget_js", "budget.wasm"),
  zkey: join(artifacts, "budget.zkey"),
  verificationKey: join(artifacts, "verification_key.json"),
} as const;

/** Everything the circuit needs, in ordinary types. */
export interface BudgetProofInput {
  readonly account: string;
  readonly asset: string;
  readonly ruleId: string;
  /** Stays private. The verifier never learns it. */
  readonly maxTotal: bigint;
  readonly amount: bigint;
  readonly requestedAt: number;
  readonly baseIndex: number;
  /** Exactly {@link BUCKET_COUNT} totals, zero-filled. Stays private. */
  readonly bucketTotals: readonly bigint[];
}

/** What a verifier is given, and all it is given. */
export interface PublicInputs {
  readonly policyCommit: bigint;
  readonly requestCommit: bigint;
  readonly bucketRoot: bigint;
  readonly baseIndex: bigint;
}

export interface BudgetProof {
  readonly proof: Groth16Proof;
  readonly publicSignals: readonly string[];
}

export class ProverError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProverError";
  }
}

function checkShape(input: BudgetProofInput): void {
  if (input.bucketTotals.length !== BUCKET_COUNT) {
    throw new ProverError(
      `circuit takes exactly ${BUCKET_COUNT} buckets, got ${input.bucketTotals.length}`,
    );
  }
  if (!Number.isSafeInteger(input.baseIndex) || input.baseIndex < 0) {
    throw new ProverError(`baseIndex must be a non-negative safe integer`);
  }
}

/**
 * Derives the public commitments from real values.
 *
 * Used by prover and verifier alike — that shared derivation is the binding,
 * and duplicating it would be the bug that makes a proof prove nothing.
 */
export async function publicInputsFor(
  input: BudgetProofInput,
  hasher?: PoseidonHasher,
): Promise<PublicInputs> {
  checkShape(input);
  const h = hasher ?? (await loadPoseidon());

  const account = fieldFor(input.account);
  const asset = fieldFor(input.asset);
  const rule = fieldFor(input.ruleId);
  const baseIndex = BigInt(input.baseIndex);

  const tree = new PoseidonBucketTree(
    h,
    { account, asset, baseIndex },
    input.bucketTotals.map(amountToField),
    TREE_DEPTH,
  );

  return {
    policyCommit: h.hash([amountToField(input.maxTotal), BigInt(BUCKET_COUNT), asset, rule]),
    requestCommit: h.hash([
      amountToField(input.amount),
      timeToField(input.requestedAt),
      account,
      asset,
    ]),
    bucketRoot: tree.root,
    baseIndex,
  };
}

/** Builds the witness and produces a proof. Slow — this is the expensive half. */
export async function proveBudget(input: BudgetProofInput): Promise<BudgetProof> {
  checkShape(input);
  const h = await loadPoseidon();

  const account = fieldFor(input.account);
  const asset = fieldFor(input.asset);
  const rule = fieldFor(input.ruleId);
  const baseIndex = BigInt(input.baseIndex);
  const totals = input.bucketTotals.map(amountToField);

  const tree = new PoseidonBucketTree(h, { account, asset, baseIndex }, totals, TREE_DEPTH);
  const publicInputs = await publicInputsFor(input, h);

  const witness: Record<string, unknown> = {
    policyCommit: publicInputs.policyCommit.toString(),
    requestCommit: publicInputs.requestCommit.toString(),
    bucketRoot: publicInputs.bucketRoot.toString(),
    baseIndex: baseIndex.toString(),
    maxTotal: amountToField(input.maxTotal).toString(),
    windowBuckets: String(BUCKET_COUNT),
    assetId: asset.toString(),
    ruleId: rule.toString(),
    accountId: account.toString(),
    amount: amountToField(input.amount).toString(),
    requestedAt: timeToField(input.requestedAt).toString(),
    bucketTotals: totals.map((t) => t.toString()),
    siblings: Array.from({ length: BUCKET_COUNT }, (_, i) =>
      tree.siblings(i).map((s) => s.toString()),
    ),
  };

  try {
    const { proof, publicSignals } = await groth16.fullProve(
      witness,
      ARTIFACTS.wasm,
      ARTIFACTS.zkey,
    );
    return { proof, publicSignals };
  } catch (error) {
    // An unsatisfiable witness is the normal failure here: the payment did not
    // fit, or a value was outside its range. Saying so beats surfacing the
    // constraint solver's own wording.
    throw new ProverError(
      `could not produce a proof — the statement may simply be false: ${(error as Error).message}`,
    );
  }
}

/**
 * Verifies a proof, and checks it is about the values the caller expects.
 *
 * Takes the policy parameters rather than the commitments on purpose. A
 * verifier handed `policyCommit` directly would be trusting the prover's
 * arithmetic about its own claim; recomputing it here is what makes the proof
 * about *this* policy rather than about some numbers.
 */
export async function verifyBudgetProof(
  proof: BudgetProof,
  expected: PublicInputs,
): Promise<boolean> {
  const verificationKey: unknown = JSON.parse(
    await readFile(ARTIFACTS.verificationKey, "utf8"),
  );

  const signals = proof.publicSignals;
  if (signals.length !== 4) return false;

  // Order is fixed by the circuit's `public [...]` list. Checked, not assumed.
  const claimed = [
    expected.policyCommit,
    expected.requestCommit,
    expected.bucketRoot,
    expected.baseIndex,
  ];
  for (const [i, value] of claimed.entries()) {
    if (signals[i] !== value.toString()) return false;
  }

  return groth16.verify(verificationKey, signals, proof.proof);
}

/**
 * Releases snarkjs's WASM worker pool.
 *
 * Without it a process that has proved once never exits, which turns a passing
 * test run into a hang.
 */
export async function shutdown(): Promise<void> {
  const curve = (globalThis as { curve_bn128?: { terminate(): Promise<void> } }).curve_bn128;
  if (curve !== undefined) await curve.terminate();
}
