# API — @allowance/policy

Everything is exported from the package root. No deep imports.

## Vocabulary

```ts
type AssetId = string;                 // opaque; never converted, never priced
type Amount  = bigint;                 // base units, always an integer

type Requester =
  | { kind: "OWNER" }
  | { kind: "AGENT";    agentId: string }
  | { kind: "SCHEDULE"; scheduleId: string }
  | { kind: "DELEGATE"; delegateId: string };

interface Approval { approver: string; at: number }

interface SpendRequest {
  requestId: string;
  account: string;
  requester: Requester;
  asset: AssetId;
  amount: Amount;
  destination: string;
  requestedAt: number;                 // the instant the policy is evaluated at
  approvals: readonly Approval[];      // counted, not authenticated
  attestations: readonly Attestation[];// matched, not authenticated
  memo: string | null;
}

interface Attestation {
  claimId: string;                     // e.g. "goods.dispatched"
  attester: string;                    // identifier, never personal details
  assertedAt: number;
  evidenceDigest: string;              // hash of the document; the document never travels
}
```

| Function | Returns |
|---|---|
| `requesterKey(r: Requester)` | `string` — canonical form, e.g. `"AGENT:researcher"` |
| `distinctApprovers(req)` | `readonly string[]` — sorted, deduplicated approver ids |
| `requestIntent(req)` | `string` — fingerprint of account/requester/asset/amount/destination |
| `attestationIsCurrent(a, asOf, maxAgeMs)` | `boolean` — not future-dated, not stale |
| `satisfying(attestations, claimId, attesters, asOf, maxAgeMs)` | `readonly Attestation[]` |

## Denominations

```ts
interface AssetUnit {
  asset: AssetId;
  decimals: number;    // 6 for USDC, 18 for ETH, 0 for something counted
  symbol: string;      // for people; never compared
  maxAmount: Amount;   // largest sane single amount — a ceiling on nonsense
}

const MAX_DECIMALS = 36;
function unitFor(units: readonly AssetUnit[] | undefined, asset): AssetUnit | undefined;
function formatAmount(amount: Amount, unit: AssetUnit): string;   // presentation only
```

Declared on the policy (`units`), so the **policy digest covers them** — a
receipt then proves which denominations were in force, not merely which limits.

Omitting `units` keeps the previous behaviour exactly, including the digest.
Declaring them adds two refusals, checked **before any rule**:

| Reason | When |
|---|---|
| `UNIT_NOT_DECLARED` | the request's asset is not one the policy declares |
| `AMOUNT_OUT_OF_RANGE` | the amount exceeds that asset's `maxAmount` |

and one load-time check: `validatePolicy` rejects a rule naming an asset the
policy does not declare, because such a rule **fails open** — it never applies,
and the spend is simply not covered by it.

## Policy

```ts
interface SpendPolicy {
  account: string; version: number; rules: readonly Rule[];
  units?: readonly AssetUnit[];      // omitted = no unit checking
}

type RuleScope =
  | { kind: "ANY" }
  | { kind: "REQUESTERS"; requesters: readonly string[] };   // requesterKey values

const ANY_REQUESTER: RuleScope;
```

Every rule has `{ id: string; scope: RuleScope }` plus:

| `kind` | Fields | Denies when |
|---|---|---|
| `REQUESTER_ALLOWLIST` | `requesters` | requester key is absent |
| `DESTINATION_ALLOWLIST` | `destinations` | destination is absent (empty list freezes the account) |
| `DESTINATION_DENYLIST` | `destinations` | destination is present |
| `ASSET_ALLOWLIST` | `assets` | asset is absent |
| `PER_TRANSACTION_LIMIT` | `asset`, `maxAmount` | `amount > maxAmount` (equal is allowed) |
| `WINDOW_BUDGET` | `asset`, `windowMs`, `maxTotal` | `committed + amount > maxTotal` |
| `WINDOW_VELOCITY` | `windowMs`, `maxCount` | this would be transaction `maxCount + 1` |
| `APPROVAL_THRESHOLD` | `asset`, `atOrAboveAmount`, `approvalsRequired` | *holds* (does not deny) when `amount >= atOrAboveAmount` and approvers are short |
| `ATTESTATION_REQUIRED` | `claimId`, `attesters`, `maxAgeMs` | no current attestation for `claimId` from a permitted attester (empty `attesters` = any; `maxAgeMs: null` = never stale; an attestation dated after `requestedAt` is never current) |
| `TIME_WINDOW` | `fromMinuteUtc`, `toMinuteUtc` | outside `[from, to)`; `from > to` wraps midnight |

A rule whose `asset` differs from the request's is `NOT_APPLICABLE`, not a pass.

| Function | Notes |
|---|---|
| `validatePolicy(policy)` | Throws `PolicyConfigError`. Run at load time, not evaluation time. |
| `policyDigest(policy)` | `string` — 64-char SHA-256 hex over a canonical encoding. |
| `scopeCovers(scope, key)` | `boolean` |
| `minuteOfDayUtc(epochMs)` | `number` in `[0, 1440)` |
| `withinDailyWindow(minute, from, to)` | `boolean`, half-open, wrap-aware |

## Ledger

```ts
type LedgerState = "PENDING" | "SETTLED" | "REVERSED";

interface LedgerEntry {
  requestId: string; account: string; asset: AssetId; amount: Amount;
  destination: string; requester: Requester;
  at: number;                          // when authorized, not when settled
  state: LedgerState;
  intent: string;                      // requestIntent at reservation; "" = unknown (legacy)
  decision: Decision | null;           // why it was allowed; null = unknown (legacy)
  expiresAt: number | null;            // deadline; null = never
}

function isExpired(entry: LedgerEntry, now: number, graceMs?: number): boolean;
```

**Expiry is derived, never recorded, and never releases budget.** A passed
deadline is not evidence that nothing was spent, so `consumesBudget` ignores
deadlines entirely — only `REVERSED` gives budget back. Expiry marks a
reservation as no longer expected to complete, so something can go and find out
what happened.

```ts

interface WindowQuery {
  from: number; to: number;            // both inclusive
  requesters: readonly string[] | null;
  excludeRequestId: string;
}
```

| Function | Notes |
|---|---|
| `consumesBudget(entry)` | `state !== "REVERSED"` — **pending money holds its budget** |
| `spentWithin(entries, asset, query)` | `Amount` |
| `countWithin(entries, query)` | `number`, across all assets |

## The engine

```ts
function evaluate(
  request: SpendRequest,
  policy: SpendPolicy,
  ledger?: readonly LedgerEntry[],     // defaults to []
): Decision;
```

Pure and total. Entries for another account are ignored. The request is
excluded from its own ledger, so re-evaluation is idempotent.

```ts
type Decision = DecisionBase & (
  | { outcome: "ALLOW" }
  | { outcome: "DENY"; reason: DenialReason; ruleId: string | null; detail: string }
  | { outcome: "REQUIRES_APPROVAL"; ruleId: string;
      approvalsRequired: number; approvalsHeld: number; detail: string }
);

interface DecisionBase {
  requestId: string; account: string;
  policyVersion: number; policyDigest: string;
  evaluatedAt: number;
  evaluations: readonly RuleEvaluation[];   // every rule, not just the deciding one
}

interface RuleEvaluation {
  ruleId: string; kind: RuleKind;
  verdict: "ALLOW" | "DENY" | "REQUIRES_APPROVAL" | "NOT_APPLICABLE";
  observed: string | null;             // decimal strings — bigints must survive JSON
  limit: string | null;
  detail: string;
}
```

`DenialReason` is one of `NO_POLICY`, `WRONG_ACCOUNT`, `INVALID_AMOUNT`,
`REQUESTER_NOT_PERMITTED`, `DESTINATION_NOT_ALLOWED`, `DESTINATION_DENIED`,
`ASSET_NOT_ALLOWED`, `TRANSACTION_TOO_LARGE`, `BUDGET_EXHAUSTED`,
`TOO_MANY_TRANSACTIONS`, `OUTSIDE_TIME_WINDOW`, `ATTESTATION_MISSING`,
`UNIT_NOT_DECLARED`, `AMOUNT_OUT_OF_RANGE`.

Precedence: **DENY** > **REQUIRES_APPROVAL** > **ALLOW**; within a tier, the
first rule in policy order.

| Function | Notes |
|---|---|
| `authorizedEntry(request, decision)` | Builds the `PENDING` ledger entry. Throws unless the decision is `ALLOW`. |

## Presentation

| Function | Returns |
|---|---|
| `explain(decision)` | Multi-line audit text — header, provenance, every rule evaluated |
| `summarize(decision)` | One line, for a log |

Rendering cannot change what was decided; it reads a finished `Decision`.

## The shell

```ts
interface Clock { now(): number }
const systemClock: Clock;
class ManualClock implements Clock { constructor(startAt: number); advance(ms); set(at) }
```

```ts
interface LedgerStore {                       // async; the guard holds the lock
  entries(account: string): Promise<readonly LedgerEntry[]>;
  find(requestId: string): Promise<LedgerEntry | undefined>;
  append(entry: LedgerEntry): Promise<void>;  // rejects on a duplicate request id
  settle(requestId: string, actualAmount: Amount): Promise<void>;
  reverse(requestId: string): Promise<void>;
  staleReservations(asOf: number, ageMs: number): Promise<readonly LedgerEntry[]>;
}

class MemoryLedgerStore implements LedgerStore {}        // in-process; forgets on exit
class LedgerProjection {}                                // the shared fold both stores use

class JournalLedgerStore implements LedgerStore {
  static open(options: { journal: Journal }): Promise<JournalLedgerStore>;
  close(): void;                                         // stops following the journal
  readonly size: number;
}

const LEDGER_SCHEMA: SchemaRef;                          // orb.payment.ledger v1
const RESERVED = "payment.reserved";
const SETTLED  = "payment.settled";
const REVERSED = "payment.reversed";
function applyLedgerEvent(projection: LedgerProjection, event: OrbEvent): boolean;
```

```ts
type PolicySource = (account: string) => SpendPolicy | undefined;   // undefined denies
function singlePolicy(policy: SpendPolicy): PolicySource;

class SpendGuard {
  constructor(options: {
    store: LedgerStore;
    policyFor: PolicySource;
    clock?: Clock;                            // defaults to systemClock
    reservationTtlMs?: number;                // omitted = no deadline
    graceMs?: number;                         // default 5000
    onDecision?: (d: Decision, r: SpendRequest) => void;   // the journal seam
  });

  authorize(draft: SpendDraft): Promise<Authorization>;     // serialised + durable
  run<T>(draft: SpendDraft, operation: (grant: Grant) => Promise<T>): Promise<GuardOutcome<T>>;
  openReservations(ageMs: number): Promise<readonly LedgerEntry[]>;
  expiredReservations(now?: number): Promise<readonly LedgerEntry[]>;
  extend(requestId: string, additionalMs: number): Promise<ExtendOutcome>;
  releaseExpired(now?: number): Promise<readonly string[]>;
  reconcile(observer: SpendObserver, ageMs: number): Promise<ReconciliationReport>;
}
```

## Reconciliation

```ts
type SpendObservation =
  | { state: "SETTLED"; actualAmount: Amount }   // it happened, this is the real cost
  | { state: "NOT_SPENT" }                       // it provably did not happen
  | { state: "UNKNOWN" };                        // say so; do not resolve it

interface SpendObserver { observe(entry: LedgerEntry): Promise<SpendObservation> }

interface ReconciliationReport {
  examined: number;
  settled:  readonly { requestId: string; amount: Amount }[];
  reversed: readonly string[];
  unresolved: readonly LedgerEntry[];                        // still open, on purpose
  failed: readonly { requestId: string; error: unknown }[];  // also still open
}

function reconcile(options: {
  store: LedgerStore; observer: SpendObserver;
  asOf: number; ageMs: number;
  serialize?: <T>(work: () => Promise<T>) => Promise<T>;
}): Promise<ReconciliationReport>;
```

`extend` measures from *now*, so an extension buys the time it says it buys. It
is refused once the grace period is gone (`reason: "EXPIRED"`), because at that
point the reservation's status is a question for reconciliation and extending
it would bury the question.

`releaseExpired` reverses expired reservations **on the assumption nothing was
spent**. That is a guess in the unsafe direction — use `reconcile` with a
`SpendObserver` where you can. It is opt-in and every reversal is journalled.

`SpendDraft` adds `ttlMs` for one long-running operation, and is a
`SpendRequest` with `requestedAt`, `approvals`,
`attestations` and `memo` optional — the shell stamps the clock and defaults
the rest.

`Grant` carries `request`, `decision`, and `report(actualAmount)`: call it with
what was really consumed. Reporting before throwing is how a failing operation
declares what it cost (or, with `0n`, that it cost nothing).

| `GuardOutcome` | Meaning | Ledger state |
|---|---|---|
| `COMPLETED` | ran; carries `reserved`, `actual`, `overage` | `SETTLED` at `actual` |
| `REFUSED` | policy said no; carries the `decision` | nothing written |
| `DUPLICATE` | same id, same request; **the operation never runs**. Carries the **original** `decision` and `existing` (read `state` and `amount` for how it turned out) | unchanged |
| `MISMATCH` | same id, **different** request; the operation never runs | unchanged |
| `FAILED` | threw, but declared its cost | `SETTLED` at that cost |
| `INDETERMINATE` | threw without declaring; we do not guess | stays `PENDING` |

`Authorization` is a four-way union — `{granted: true, …}`,
`{granted: false, refusal: "DENIED", decision}`,
`{granted: false, refusal: "DUPLICATE", existing, decision}`, or
`{granted: false, refusal: "MISMATCH", existing, detail}`. Granted
authorizations carry `settle(actual)` and `reverse()`.

### Idempotency

A reused request id is only a duplicate if it is **the same request**.
`requestIntent` fingerprints what would actually move — account, requester,
asset, amount, destination — and a reused id carrying anything different is
refused as `MISMATCH` rather than absorbed.

Deliberately *excluded* from the fingerprint, because an honest retry differs
on them: `requestedAt` (stamped from a clock), `approvals` and `attestations`
(a retry may carry more), and `memo`.

The fingerprint is stamped at reservation and never touched by settlement —
`amount` becomes what was *actually* spent, so the entry cannot serve as the
record of what was asked for.

`intent: ""` means unknown: an entry replayed from history written before
fingerprints existed. Such a retry falls back to plain duplicate detection.

A duplicate returns **the answer given the first time**, not a fresh
evaluation. A retry that arrives after the budget has filled, or after the
policy changed, still gets the original `ALLOW` — re-deciding would tell a
caller its payment was refused when it was in fact allowed and may already
have happened.

The canonical encoding is `wire.ts`'s, and it **conforms to RFC 8785 (JCS)** —
measured against the RFC, not asserted (`tests/jcs.test.ts`). Protocols that
mandate JCS by name are satisfied by it. One deliberate narrowing: a `bigint`
is encoded as a decimal *string* before canonicalisation, because JSON has no
bigint and a float would lose base units. That is a choice about the value's
JSON shape, made before JCS runs, not a divergence from JCS.

## Receipts

```ts
interface SpendReceipt {
  version: number; issuedAt: number;
  request: SpendRequest;
  decision: Decision;
  policy: SpendPolicy | null;                    // null = redacted
  ledgerContext: readonly LedgerEntry[] | null;  // null = redacted
  facts: readonly OrbEvent[];                    // journal events, self-verifying
  outcome: { state: LedgerState; amount: Amount };
}

function buildReceipt(input: BuildReceiptInput): SpendReceipt;
function encodeReceipt(receipt: SpendReceipt): string;   // canonical; amounts as strings
function receiptDigest(receipt: SpendReceipt): string;   // sha256 hex
function verifyReceipt(receipt: SpendReceipt): VerificationResult;
function explainVerification(result: VerificationResult): string;
```

`verifyReceipt` consults no network and no issuer storage — everything is
recomputed from the receipt's own contents.

| Check | Proves | Skipped when |
|---|---|---|
| `VERSION` | the shape is understood | — |
| `FACTS_INTACT` | each journal event hashes to its own contents | no events attached |
| `FACTS_MATCH_REQUEST` | the events concern this request | no events attached |
| `POLICY_BINDING` | the decision was made under the attached policy | policy redacted |
| `DECISION_REPRODUCES` | **the decision was correct**, by recomputation | policy or ledger redacted |
| `OUTCOME_CONSISTENT` | the stated outcome matches the events | no events attached |

`verified` is true only when every check ran and passed. `partial` is true when
everything checkable passed but something was redacted.

```ts
class JournalLedgerStore {
  factsFor(requestId: string): readonly OrbEvent[];   // the evidence a receipt carries
}
function requestIdOf(event: OrbEvent): string | null;
```

## Quotes

```ts
interface Quote {
  quoteId: string;
  issuer: string;                  // identifier; nothing here proves it
  subject: { kind: string; digest: string };   // what is being bought, by hash
  asset: AssetId;
  maxAmount: Amount;               // the ceiling: the seller may charge less, never more
  payTo: string;                   // becomes the request's destination
  issuedAt: number;
  expiresAt: number;               // exclusive
  audience: string | null;         // bound to one buyer, or bearer
  requestId: string | null;        // bound to one request, or any
}

interface PaymentRequired { quote: Quote; accepts: readonly string[] }
```

| Function | Notes |
|---|---|
| `quoteDigest(quote)` | 64-char SHA-256 hex over a canonical encoding |
| `assessQuote(quote, { now, audience, requestId })` | `MALFORMED`, `NOT_YET_VALID`, `EXPIRED`, `WRONG_AUDIENCE`, `WRONG_REQUEST`, or usable. Pure — the instant arrives in the context |
| `quotedDraft(quote, { requestId, account, requester, requestedAt, memo? })` | A `SpendDraft` whose `amount` is the **quoted ceiling** and whose `destination` is `payTo` |
| `settlementAgainstQuote(quote, charged)` | `{honoured: true, headroom}` or `{honoured: false, exceededBy}` |

A receipt may carry the quote; `verifyReceipt` then runs `QUOTE_HONOURED`,
which checks the bindings, the payee, the asset and the ceiling.

### Check statuses

`SKIPPED` and `NOT_APPLICABLE` look alike and mean opposite things. `SKIPPED`
means the evidence exists and was withheld — the result is `PARTIAL`.
`NOT_APPLICABLE` means there is nothing to check (a refused request reserved
nothing; an unquoted payment has no ceiling), and does **not** downgrade an
otherwise complete receipt.

## Signing

```ts
interface Signature { keyId: string; algorithm: "ed25519"; value: string; signedAt: number }
interface Signed<T> { payload: T; signatures: readonly Signature[] }

interface Signer { readonly keyId: string; readonly algorithm: "ed25519";
                   sign(bytes: Buffer, signedAt: number): string }

interface PublicKeyRecord {
  keyId: string; algorithm: "ed25519"; publicKeyPem: string;
  speaksFor: readonly string[];      // identities this key may sign for
  notBefore: number; notAfter: number | null;
  revoked: boolean;                  // compromise; fails whenever it signed
}

type KeyLookup =
  | { found: true; record: PublicKeyRecord }
  | { found: false; reason: "UNKNOWN" | "UNAVAILABLE"; detail: string };

interface KeyDirectory { publicKey(keyId: string): KeyLookup }
class MemoryKeyDirectory implements KeyDirectory { constructor(records?); add(record) }
```

`KeyDirectory` is synchronous so verification stays replayable: a caller with a
remote directory resolves first and verifies against that snapshot — and reports
`UNAVAILABLE` if that resolution failed. `UNKNOWN` ("no such key") and
`UNAVAILABLE` ("could not look") are different facts, and a directory that
collapses them hands its own outage to the verifier as an accusation.

| Function | Notes |
|---|---|
| `ed25519Signer(keyId, privateKeyPem)` | Key captured in a closure, never on the object |
| `sign(payload, signer, signedAt)` | `Signed<T>` over the payload's canonical bytes |
| `countersign(signed, signer, signedAt)` | Adds a signature without disturbing the first |
| `verifySignatures(signed, directory, identity?)` | `SignatureVerification`; omit `identity` to ask only whether the bytes bind |
| `signQuote` / `verifySignedQuote` | Identity is `quote.issuer` |
| `signReceipt` / `verifySignedReceipt` | Identity defaults to `request.account` |
| `explainAttribution(result)` | Human-readable report |

```ts
interface SignatureVerification {
  identity: string | null;        // the claim checked against, or null
  disposition: Disposition;       // the strongest across all signatures
  attributed: boolean;            // disposition === "authentic"
  checks: readonly SignatureCheck[];
}
```

`attributed` requires a signature that is both cryptographically sound **and**
made by a key entitled to the claimed identity. `disposition` says how far
verification got when it did not, because the four ways of falling short call
for different responses:

| `Disposition` | Means | What a reader should do |
|---|---|---|
| `authentic` | Sound signature, key authorised for the claimed identity | Rely on it |
| `binding_only` | Sound signature, no identity claimed | Bytes bind; authorship unestablished |
| `signer_authority_failed` | The directory answered: this key may not speak for that identity | Investigate the key |
| `signer_resolution_failed` | The directory could not be consulted | Retry — this says nothing about the signer |
| `signature_invalid` | The bytes do not verify | Treat as tampering |

Ranked best-first in that order, so the strongest outcome across several
signatures wins. A definite "no" outranks "could not tell", and tampering is
surfaced last so it is never hidden by a softer result.

Passing no `identity` reaches `binding_only` at best: there is no claim to check
the signer against. That is the right question when inspecting a payload whose
claimed identity you have not yet decided to trust, and the wrong one when
deciding whether to act on it.

An unsigned payload reports `signature_invalid`, not a gentler disposition —
absence must never read better than a bad signature.

`SignatureRejection` (the specific cause, retained alongside the disposition):
`UNKNOWN_KEY`, `DIRECTORY_UNAVAILABLE`, `ALGORITHM_MISMATCH`,
`KEY_NOT_AUTHORIZED`, `KEY_NOT_YET_VALID`, `KEY_EXPIRED`, `KEY_REVOKED`,
`BAD_SIGNATURE`, `MALFORMED`.

Adopted from the [Cycles evidence spec](https://github.com/runcycles/cycles-protocol),
which draws this line better than the boolean it replaces.

## Canonical encoding

```ts
function toWire(value: unknown): unknown;        // bigint -> decimal string
function canonicalText(value: unknown): string;  // sorted keys, no whitespace
function canonicalBytes(value: unknown): Buffer; // what signatures are made over
function digestOf(value: unknown): string;       // sha256 hex
```

One encoder, used by quotes, receipts and signatures alike. Two encoders that
agree today diverge after one is edited, and then a signature made by one fails
under the other for no visible reason.

## Transport

```ts
const PAYMENT_REQUIRED_HEADER  = "payment-required";   // 402 response
const PAYMENT_SIGNATURE_HEADER = "payment-signature";  // the retry
const PAYMENT_RESPONSE_HEADER  = "payment-response";   // settlement
const DEFAULT_MAX_HEADER_BYTES = 65536;

interface PaymentAuthorization {
  quoteDigest: string;      // binds to the exact offer
  requestId: string;
  account: string;
  asset: AssetId;
  amount: Amount;           // the quoted ceiling, in full
  authorizedAt: number;
  policyDigest: string;     // binds to the decision that approved it
}

type DecodeResult<T> =
  | { ok: true; value: T }
  | { ok: false; reason: "MISSING" | "TOO_LARGE" | "NOT_BASE64" | "NOT_JSON" | "MALFORMED";
      detail: string };
```

| Function | Notes |
|---|---|
| `encodeChallenge` / `decodeChallenge` | `Signed<PaymentRequired>`, base64 canonical JSON |
| `encodeAuthorization` / `decodeAuthorization` | `Signed<PaymentAuthorization>` |
| `encodeSettlement` / `decodeSettlement` | `Signed<SpendReceipt>` — **structural only**, see below |
| `readAmount(value)` | Canonical decimal only: no hex, exponent, sign, leading zeros, whitespace |
| `admitPayment({ authorization, quote, directory, now })` | The seller's gate |
| `challengeToWire(challenge)` | Plain object for a non-Node transport to serialise |

`decodeSettlement` validates the envelope and refuses to re-derive the
receipt's interior: `verifyReceipt` already recomputes the whole decision and
is the real gate. A second, weaker validator would become a second opinion
people trusted by mistake. **Run `verifySignedReceipt` and `verifyReceipt`
before believing a decoded settlement.**

`AdmissionRejection`: `NOT_ATTRIBUTED`, `ATTRIBUTION_INDETERMINATE`,
`WRONG_QUOTE`, `QUOTE_EXPIRED`, `ASSET_MISMATCH`, `AMOUNT_MISMATCH`.

`ATTRIBUTION_INDETERMINATE` is the seller's own key directory being unreachable
(`signer_resolution_failed`), never a judgement about the buyer. Retry it; do
not blacklist the buyer, and do not deliver. Collapsing it into
`NOT_ATTRIBUTED` turns an outage into an accusation.

## Commitments

```ts
class LedgerCommitment<T> {
  constructor(values: readonly T[]);
  readonly root: string;            // RFC 6962 Merkle root
  readonly size: number;
  values(): readonly T[];
  prove(index: number): InclusionProof | null;
}

interface InclusionProof { index: number; size: number; path: readonly PathStep[] }
interface PathStep { hash: string; right: boolean }

function verifyInclusion(value: unknown, proof: InclusionProof, root: string): boolean;
function emptyRoot(): string;
```

Leaves carry a `0x00` prefix and nodes `0x01`, so an internal node cannot be
presented as a leaf. Odd levels are promoted, never duplicated, so two
different ledgers cannot share a root.

## Bucketed totals

```ts
const MAX_BUCKETS = 512;

function bucketIndex(at: number, bucketMs: number): number;
function coveringBuckets(requestedAt, windowMs, bucketMs): { from: number; to: number };

interface BucketLeaf {
  account: string; asset: AssetId; bucketMs: number;
  index: number; total: Amount;
}

class BucketCommitment {
  static build(entries: readonly LedgerEntry[], params: {
    account: string; asset: AssetId; bucketMs: number; from: number; to: number;
  }): BucketCommitment;
  readonly root: string; readonly size: number;
  readonly account: string; readonly asset: AssetId;
  readonly bucketMs: number; readonly from: number; readonly to: number;
  open(index: number): { leaf: BucketLeaf; inclusion: InclusionProof } | null;
  openRange(range): readonly { leaf; inclusion }[] | null;
}

function commitmentMatchesLedger(commitment, entries): boolean;
```

Dense and zero-filled: position `p` in the tree **is** bucket `from + p`, which
is what makes omission detectable. `build` applies the same three exclusions
`evaluate` does — wrong account, wrong asset, reversed.

## The circuit relation — NOT a proof

```ts
const IS_ZERO_KNOWLEDGE = false;   // assert on it

interface BudgetStatement {        // public
  policyDigest: string;
  commitment: { root; account; asset; bucketMs; from; to };
  requestDigest: string; requestedAt: number; claimedOutcome: "ALLOW";
}
interface BudgetWitness {          // private in a real circuit; revealed here
  policy: SpendPolicy; request: SpendRequest; ruleId: string;
  buckets: readonly { leaf: BucketLeaf; inclusion: InclusionProof }[];
}
interface BudgetProofBundle { statement: BudgetStatement; witness: BudgetWitness }

function buildBudgetBundle(input): BudgetProofBundle | null;   // assembles an honest one
function checkBudgetRelation(bundle): RelationResult;
function explainRelation(result): string;
```

| | Constraint | In a circuit |
|---|---|---|
| C1 | `hash(policy) == policyDigest` | hash gadget |
| C2 | `hash(request) == requestDigest` | hash gadget |
| C3 | request time matches the statement | one equality |
| C4 | each leaf included under the root | **dominates the cost** |
| C5 | each leaf's key matches its position | a few equalities |
| C6 | leaves are exactly the covered range | **completeness** |
| C7 | `sum + amount <= maxTotal` | addition + one comparison |

`RelationResult.assumptions` carries **FAITHFUL TOTALLING** — the committer is
assumed to have summed correctly. Unlike the completeness gap it replaced, that
is checkable: `commitmentMatchesLedger` rebuilds and compares roots.
