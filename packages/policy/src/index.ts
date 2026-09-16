/**
 * @allowance/policy — programmable spend authority.
 *
 * A payment may be requested by anyone: a person, a schedule, an autonomous
 * agent. **Spend authority belongs to the policy.** Nothing a requester sends
 * can raise a limit, skip an approval, or widen a window; the request carries
 * facts about itself and no authority over how it is judged.
 *
 * The engine is pure and total: same request, same policy, same ledger, same
 * decision — forever, on any device, at any later replay. It performs no I/O,
 * reads no clock, and knows nothing about rails, chains, custody or
 * settlement. What moves the money lives elsewhere; what decides whether it
 * may move lives here.
 */

/* -- Vocabulary ----------------------------------------------------------- */
export type { AssetId, Amount, Requester, Approval, SpendRequest } from "./model.js";
export { requesterKey, distinctApprovers } from "./model.js";
export type { Attestation } from "./attestation.js";
export { attestationIsCurrent, satisfying } from "./attestation.js";

export type { AssetUnit } from "./units.js";
export { MAX_DECIMALS, unitFor, formatAmount } from "./units.js";

/* -- Policy --------------------------------------------------------------- */
export type { Rule, RuleKind, RuleScope, SpendPolicy } from "./policy.js";
export {
  ANY_REQUESTER,
  PolicyConfigError,
  validatePolicy,
  policyDigest,
  scopeCovers,
  minuteOfDayUtc,
  withinDailyWindow,
} from "./policy.js";

/* -- Ledger --------------------------------------------------------------- */
export type { LedgerEntry, LedgerState, WindowQuery } from "./ledger.js";
export { consumesBudget, isExpired, spentWithin, countWithin } from "./ledger.js";

/* -- The engine ----------------------------------------------------------- */
export type { Decision, DenialReason, RuleEvaluation, Verdict } from "./evaluate.js";
export { evaluate, authorizedEntry } from "./evaluate.js";

/* -- The shell ------------------------------------------------------------ */
export type { Clock } from "./clock.js";
export { systemClock, ManualClock } from "./clock.js";

export type { LedgerStore } from "./store.js";
export { MemoryLedgerStore, LedgerProjection, LedgerStoreError } from "./store.js";

export {
  JournalLedgerStore,
  applyLedgerEvent,
  requestIdOf,
  LEDGER_SCHEMA,
  RESERVED,
  SETTLED,
  REVERSED,
  EXTENDED,
} from "./journal-store.js";
export type { JournalLedgerStoreOptions } from "./journal-store.js";

export type {
  Quote,
  QuoteSubject,
  PaymentRequired,
  QuoteAssessment,
  QuoteRejection,
  QuoteContext,
  QuotedDraftInput,
  QuoteSettlement,
} from "./quote.js";
export {
  quoteDigest,
  assessQuote,
  quotedDraft,
  settlementAgainstQuote,
} from "./quote.js";

export {
  RECEIPT_VERSION,
  SUPPORTED_RECEIPT_VERSIONS,
  buildReceipt,
  encodeReceipt,
  receiptDigest,
  verifyReceipt,
  explainVerification,
} from "./receipt.js";
export type {
  SpendReceipt,
  ReceiptOutcome,
  BuildReceiptInput,
  ReceiptCheck,
  CheckStatus,
  VerificationResult,
} from "./receipt.js";

/* -- Attribution ---------------------------------------------------------- */
export type {
  Signature,
  SignatureAlgorithm,
  Signed,
  Signer,
  PublicKeyRecord,
  KeyDirectory,
  KeyLookup,
  Disposition,
  SignatureRejection,
  SignatureCheck,
  SignatureVerification,
} from "./signing.js";
export {
  MemoryKeyDirectory,
  ed25519Signer,
  sign,
  countersign,
  verifySignatures,
  explainAttribution,
  signQuote,
  verifySignedQuote,
  signReceipt,
  verifySignedReceipt,
} from "./signing.js";

export { toWire, canonicalText, canonicalBytes, digestOf } from "./wire.js";

/* -- Commitments and the circuit relation --------------------------------- */
export type { InclusionProof, PathStep } from "./commitment.js";
export { LedgerCommitment, verifyInclusion, emptyRoot } from "./commitment.js";

export type {
  BucketLeaf,
  BucketRange,
  BucketCommitmentParams,
} from "./buckets.js";
export {
  BucketCommitment,
  BucketCommitmentError,
  MAX_BUCKETS,
  bucketIndex,
  coveringBuckets,
  commitmentMatchesLedger,
} from "./buckets.js";

export type {
  BudgetStatement,
  CommitmentStatement,
  BudgetWitness,
  BudgetProofBundle,
  WitnessBucket,
  ConstraintId,
  ConstraintResult,
  RelationResult,
} from "./circuit.js";
export {
  IS_ZERO_KNOWLEDGE,
  checkBudgetRelation,
  buildBudgetBundle,
  explainRelation,
} from "./circuit.js";

/* -- Transport ------------------------------------------------------------ */
export type {
  PaymentAuthorization,
  DecodeRejection,
  DecodeResult,
  Admission,
  AdmissionInput,
  AdmissionRejection,
} from "./transport.js";
export {
  PAYMENT_REQUIRED_HEADER,
  PAYMENT_SIGNATURE_HEADER,
  PAYMENT_RESPONSE_HEADER,
  DEFAULT_MAX_HEADER_BYTES,
  readAmount,
  encodeChallenge,
  decodeChallenge,
  encodeAuthorization,
  decodeAuthorization,
  encodeSettlement,
  decodeSettlement,
  admitPayment,
  challengeToWire,
} from "./transport.js";

export { reconcile } from "./reconcile.js";
export type {
  SpendObserver,
  SpendObservation,
  ReconciliationReport,
  ReconcileOptions,
} from "./reconcile.js";

export type {
  SpendDraft,
  PolicySource,
  Authorization,
  Grant,
  GuardOutcome,
  GuardOptions,
  ExtendOutcome,
} from "./guard.js";
export { SpendGuard, singlePolicy } from "./guard.js";

/* -- Presentation --------------------------------------------------------- */
export { explain, summarize } from "./explain.js";
