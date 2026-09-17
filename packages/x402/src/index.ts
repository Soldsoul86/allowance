/**
 * @spendcap/x402 — x402 behind a spend guard.
 *
 * The policy decides before anything is signed, the budget is reserved before
 * the authorization exists, and a retry of the same purchase presents the
 * same authorization instead of minting a new one and paying twice.
 */
export { guardX402, GuardedX402, purchaseId } from "./guarded.js";
export { SpendRefusedError, SpendDuplicateError, SpendMismatchError } from "./guarded.js";
export type { GuardX402Options, GuardedFetch, GuardedRequestInit, Purchase } from "./guarded.js";
