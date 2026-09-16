/**
 * @allowance/circuit — a Groth16 proof that a payment stayed inside a
 * private budget.
 *
 * Separate from `@allowance/policy` on purpose. A proving system is a large,
 * opinionated dependency, and the package that decides whether payments are
 * allowed must stay free of it: the engine has to run anywhere, offline, with
 * nothing installed. Proving is an optional capability layered on top.
 */
export { FIELD_MODULUS, MAX_AMOUNT, FieldEncodingError, fieldFor, amountToField, timeToField } from "./field.js";
export { PoseidonBucketTree, loadPoseidon } from "./tree.js";
export type { PoseidonHasher, LeafKey } from "./tree.js";
export {
  TREE_DEPTH,
  BUCKET_COUNT,
  ARTIFACTS,
  ProverError,
  publicInputsFor,
  proveBudget,
  verifyBudgetProof,
  shutdown,
} from "./prover.js";
export type { BudgetProofInput, PublicInputs, BudgetProof } from "./prover.js";
