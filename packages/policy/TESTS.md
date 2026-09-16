# Tests — @allowance/policy

`npm test -w @allowance/policy` — **278 tests, all passing.** (703 across the repo.)

Unit tests only. The package has no I/O to integrate with, which is the point
— the guard's clock and store are both injected.

## What is covered

### Structural refusals (`evaluate.test.ts`)
Deny-by-default on an empty policy; a request aimed at another account; zero
and negative amounts. These run before any rule, so a malformed request is
never measured against limits written for a different subject.

### Every rule kind
Allowlists and denylists for destination, asset and requester — including that
an **empty allowlist freezes the account**, which is a feature rather than a
bug. Per-transaction limits are tested at the boundary: exactly the limit
passes, one base unit above denies.

### Window budgets — the concurrency property
Five tests around the single most important behaviour:

- settled spend inside the window counts;
- **`PENDING` spend counts exactly as much as `SETTLED`** (without this, N
  simultaneous requests each see an empty budget and all pass);
- `REVERSED` spend returns its budget;
- spend outside the window does not count;
- another account's ledger does not count.

Plus **idempotency**: re-evaluating a request that is already `PENDING` in the
ledger returns the same answer, because the request is excluded from its own
ledger.

### Approvals
Below-threshold passes through. **At** the threshold holds — the boundary is
`>=`, matching the hard-exit sentinel, because a threshold you can sit
precisely on without consequence is not a threshold. Three signatures from one
approver count as one.

### Attestation-gated settlement (`attestation.test.ts`)
Written around a real shape — an India/Europe chemical shipment — because an
abstract claim id hides the questions that matter. Payment is held until the
claim is attested; released when a named attester asserts it; refused for the
wrong attester, the wrong claim, or a stale certificate. Any of several
permitted attesters satisfies a claim, and an empty attester list accepts
whoever the shell vouched for.

Two edges are tested deliberately: an attestation **exactly** at the age limit
is accepted, and one **dated after the request** is refused — a document from
the future is a clock problem or a forgery, and either way must not release
money. Multi-condition policies require every condition, and the decision
records the **evidence digest, never the document**.

Composition is tested too: attested but over the per-transaction cap still
denies, with the limit named as the reason.

### Time windows
Inside, outside, and the wrap-around case (22:00→06:00) which is where an
off-by-one would hide.

### Scope
A rule scoped to `AGENT:researcher` constrains that agent and leaves the owner
alone. A scoped budget is measured over the scoped requesters only, so the
owner's spend does not consume the agent's envelope.

### Precedence and explainability
A denial outranks a pending approval. **All three rules appear in
`evaluations`** with their individual verdicts, not just the deciding one.
Decisions carry the policy version and a 64-character digest.

### Determinism
The same inputs produce a deep-equal decision across repeated calls, and
`evaluate` does not mutate the request or the ledger (verified by
`structuredClone` comparison).

### Denominations (`units.test.ts`)

**The showpiece demonstrates the bug before the fix.** With no units declared,
a full budget correctly refuses the right spelling — and then the *same spend*
under `"USDC "` with a trailing space sails through, because the rule simply
does not apply to it. Declaring units turns that into `UNIT_NOT_DECLARED`.

Scale mistakes: six decimals confused for eighteen is caught as
`AMOUNT_OUT_OF_RANGE`; exactly the declared ceiling passes the unit check and
is then judged by the rules; and an asset that is both undeclared *and*
absurdly scaled reports the unit problem, proving denomination is checked
before any rule.

Backward compatibility is asserted, not assumed: a policy declaring no units
allows any asset and **hashes exactly as it did before units existed**, so no
existing receipt is invalidated. Declaring them changes the digest — including
changing only `decimals` — which is what lets a receipt prove them.

Validation rejects a rule naming an undeclared asset (it would fail open), an
allowlist doing the same, duplicate declarations, an empty asset or symbol,
negative, fractional and oversized `decimals`, and a non-positive `maxAmount`.

`formatAmount` pads the fraction, because "5.5" and "5.000005" differ only in
zeros a naive conversion drops; omits the point for a counted asset; and
survives 18 decimals without losing a digit.

### Policy validation (`policy.test.ts`)
Duplicate rule ids, a scope naming nobody, negative limits, non-positive
windows, zero required approvals, a minute outside `[0, 1440)`, an empty time
window, a non-positive version.

### Digest stability
Key ordering does not change the digest; changing a limit does; changing the
version does; a `bigint` too large for JSON still hashes.

### Ledger arithmetic (`ledger.test.ts`)
Asset filtering, request exclusion, inclusive window bounds at both edges,
requester filtering, the empty ledger, and state handling in `countWithin`.

### The guard (`guard.test.ts`)

Two tests carry this file.

**Ten racing callers against a budget that fits three.** Every call suspends
inside its operation; exactly three complete and seven are refused. It only
passes because `authorize` never suspends between reading the ledger and
writing the reservation. If that ever regresses, this test goes to ten
completions.

**What happens when the operation throws.** A failure with no declared cost
leaves the reservation `PENDING` and returns `INDETERMINATE` — the guard
refuses to guess whether money moved — and `openReservations` surfaces it once
it is stale. A failure that reports `0n` settles at zero, and one that reports
a real figure settles at that figure. A zero-cost attempt still counts against
a velocity limit, because it cost nothing but it happened.

Also covered: settling at the reported figure rather than the estimate;
overages recorded rather than prevented; the budget self-correcting because
the next decision sees the true figure; retries with a repeated request id
returning `DUPLICATE` **without running the operation**; an unknown account
denying with `NO_POLICY`; `onDecision` firing for allowed and refused alike
(and not for duplicates); and budget windows moving with an injected clock.

### The journal-backed ledger (`journal-store.test.ts`)

The tests the in-memory store could not pass. **A reservation survives a
restart**, and — the one that matters — a restarted process enforces the
budget it left behind: 9,000 of a 10,000 envelope spent before the restart,
and the 2,000 request after it is refused. With `MemoryLedgerStore` that
request is allowed.

Also: settlements and reversals replay; the fold is deterministic across
repeated replays; a `2^80` amount round-trips through an encoding that refuses
`bigint`; history cannot be corrected (duplicate reservation, double settle,
settling something never reserved all reject); a **replicated** reservation
from another device's lane consumes the shared envelope; and the hash chain
still verifies after a full lifecycle.

### Reconciliation (`reconcile.test.ts`)

An observed `SETTLED` records the sensor's figure, not the reserved estimate.
`NOT_SPENT` reverses and the envelope is whole again — proven by the next call
fitting.

The refusals are tested harder than the resolutions, because they are what
makes it trustworthy: **`UNKNOWN` leaves the entry `PENDING`**, still
consuming budget, and offers it again on the next sweep. An observer that
throws is recorded in `failed` and its entry is left untouched rather than
guessed at — and the sweep continues to the next one. Reservations that are
not yet stale are never examined; settled entries are never touched.

The last test walks the full cycle: decide, act, fail indeterminately, hold
the budget, observe, close.

### Receipts (`receipt.test.ts`)

Six tampering tests carry this file, because a receipt that can be quietly
altered is a log with extra steps. An edited amount fails
`DECISION_REPRODUCES` — *"recomputing gives DENY, receipt claims ALLOW"*. A
swapped policy fails `POLICY_BINDING`. An altered journal event fails
`FACTS_INTACT`. An outcome the events do not support, events belonging to a
different request, and an unknown receipt version all fail their own check.

Redaction is tested as carefully as verification: a receipt without the ledger
reports `PARTIAL` with `DECISION_REPRODUCES` **skipped, not passed**, while
`FACTS_INTACT` and `POLICY_BINDING` still pass. A redacted receipt whose
outcome has been forged still fails outright — redaction weakens the proof, it
does not disable it.

The wire form is checked for lossless `bigint` encoding (decimal strings,
never `Number`) and stable hashing.

### Quotes (`quote.test.ts`)

The test that matters proves a quote closes the hole the buyer cannot: the
same guard, the same 5,000 per-call limit. **Unquoted**, a caller guessing
1,000 that really burns 40,000 completes and the ledger records 40,000 after
the fact. **Quoted**, a ceiling of 40,000 is refused outright and nothing is
reserved.

Also: expiry is exclusive — sitting exactly on the deadline is too late, one
millisecond earlier is fine; quotes from the future, for another buyer, or for
another request are refused; charging exactly the ceiling is honoured and one
unit over is a broken promise with `exceededBy`; and an unapproved seller is
refused by an ordinary `DESTINATION_ALLOWLIST`, with no rule kind added for it.

In a receipt, `QUOTE_HONOURED` catches an overcharge (*"over by 2100"*), an
expired quote, a quote addressed to a different buyer, and a payee that is not
where the money went.

**`NOT_APPLICABLE` is tested against `SKIPPED` deliberately.** An unquoted
payment verifies *fully* — nothing to check is not a gap — while a withheld
ledger still downgrades to `PARTIAL`. Collapsing the two would mean a perfectly
good receipt could never read as verified, which is how a verifier teaches
people to ignore it. A v1 receipt is also tested to still verify, because a
contract accepted at v1 is permanent.

### Canonical encoding conforms to RFC 8785 (`jcs.test.ts`)

Nine tests measure the encoder against the JSON Canonicalization Scheme rather
than against our own description of it. The worked example from RFC 8785 §3.2.3
must match byte for byte; keys sort by UTF-16 code unit, not codepoint (the
surrogate-pair case, where `U+10000` sorts *before* `U+FFFF`); numbers use the
ECMAScript `Number::toString` forms the RFC mandates (`1e+30`, `1e-7`,
`333333333.3333333`), and `-0` encodes as `0`; `NaN`, `Infinity` and `undefined`
are refused rather than silently encoded.

This file exists because conformance had been *documented as a known gap* for
several revisions, on the assumption it did not conform. Nobody had checked.
It did. The tests are what makes that a fact rather than a second assumption,
and what stops a future change from quietly breaking interop.

### Signing (`signing.test.ts`)

The test that carries this file is the authorised-key one, because it is the
failure real systems ship: a signature that is **cryptographically perfect**,
made by a key with no right to the name on the payload. It reports
`KEY_NOT_AUTHORIZED`, and a separate test proves that is a different outcome
from `BAD_SIGNATURE` — the compiler will not even let the two be compared,
which is the point. A key that speaks for nobody attributes nothing.

Keys over time: rotating a key does **not** invalidate what it already signed
(validity is judged against `signedAt`); a signature made after the key left
service is `KEY_EXPIRED`; before it came into service, `KEY_NOT_YET_VALID`; and
a revoked key fails whenever it signed, reported as `KEY_REVOKED` rather than a
forgery.

Malformed input never crashes the decision: unknown key id, empty signature,
base64 that is not a signature, and no signatures at all each return a reason
instead of throwing.

Multiple signers: both parties can vouch for one payload and each is verified
against its own identity; one bad signature does not sink a good one.

Custody: the signer does not carry its private key on the object (checked by
serialising it), and signing is deterministic over canonical bytes.

**Dispositions.** Eleven tests pin the five-way taxonomy, and the pair that
earns them is the unknown key against the unreachable directory: the first is
`signer_authority_failed`, the second `signer_resolution_failed`, and nothing in
the bytes distinguishes them — only what the directory said. The rest cover each
disposition at its source (authorised key, remit, revocation, tampering), the
ranking across several signatures (a definite "no" outranks "could not tell"),
an unsigned payload taking the most serious disposition rather than the
gentlest, a sound signature with no identity claimed reaching `binding_only`
and stopping there, and `explainAttribution` printing the disposition rather
than just a verdict.

### Transport (`transport.test.ts`)

Held to a different standard, because it reads bytes a stranger wrote.

**Canonical amounts.** Hex (`"0x10"`, which `BigInt` would read as sixteen),
exponent form (`"1e999"`, which `BigInt` would throw on), leading zeros
(`"007"` — normalising it re-encodes as `"7"` and **breaks the signature over
the original bytes**), signs, whitespace, separators, decimals, absurd lengths,
and non-strings are each refused individually.

**Hostile input never throws.** Ten shapes — absent, empty, a number, invalid
base64, base64 of a non-object, of an array, of `null`, truncated JSON, missing
signatures, empty signatures — each return a reason from both decoders. A
200KB header is refused as `TOO_LARGE`, and an unknown signature algorithm is
refused at the boundary rather than passed inward.

**An outage is not an accusation.** A correctly signed authorisation presented
to a seller whose key directory is unreachable is refused as
`ATTRIBUTION_INDETERMINATE`, never `NOT_ATTRIBUTED`. The buyer did nothing
wrong, and the seller should retry rather than blame them.

**Round trips preserve the signature.** A challenge is signed, encoded,
decoded, and re-signed — the two signatures must match byte for byte. If the
encoder altered any part of the canonical form, this test fails.

**Idempotency is about the request, not the id.** A reused id carrying a
different amount, destination, asset or requester is refused as `MISMATCH`, and
the operation does not run. Conversely, the fields an honest retry is *expected*
to differ on — a later timestamp, approvals collected since, a changed memo —
remain ordinary duplicates.

**Deadlines mark, they do not settle.** The test that carries this:
**an expired reservation still holds its budget** — it stays `PENDING`, and the
next spend is still refused. A reservation only stops holding when it is
`REVERSED`, which requires evidence rather than a timer. Grace is tested from
both sides: still inside grace is not yet expired, and a settlement arriving
during grace is not a late arrival. A per-request `ttlMs` overrides the
guard's default, and with no TTL configured nothing expires after a year.

**Extending** buys time measured from now, and is refused once grace is gone
(`EXPIRED`, with a message pointing at reconciliation), for a finished
reservation (`NOT_PENDING`), for an unknown id, and for a non-positive or
non-finite interval.

**`releaseExpired`** reverses and returns the budget — and never touches a
reservation still inside its deadline. Across a restart: a deadline and an
extension both survive, and an expired reservation is still expired *and still
holding* after a reload, because a restart is not a release.

**A duplicate returns the answer given the first time.** The sharpest case:
between two attempts the budget fills, so a fresh evaluation would *deny* — the
test proves the ledger really has moved on, then checks the retry still gets
the original `ALLOW`. Another changes the policy between attempts and checks
the returned decision names the version in force at the time. An entry from
before decisions were recorded returns `null` rather than a re-derived answer.
A restart-and-reload test proves the decision, including every rule it
evaluated, is persisted rather than held in memory.

The sharpest one: **the fingerprint survives settlement.** `settle` overwrites
`amount` with what was really spent, so a request for 1,000 settled at 400 must
still match 1,000 and now mismatch 400. That is precisely where the bug would
return if anyone later derived the fingerprint from the stored amount. A
fingerprint-less legacy entry falls back to duplicate detection, and a
restart-and-reload test proves the fingerprint is persisted rather than held in
memory.

**The admission check.** The one that matters presents a correctly signed,
internally coherent authorisation for a *cheaper quote the buyer invented*; it
is refused as `WRONG_QUOTE`, because the seller compares against its own quote
and not the buyer's copy. Also covered: a stranger's signature, an expired
quote, a mismatched asset, and an authorisation for less than the ceiling.

### Commitments (`commitment.test.ts`)

Two tests are about attacks rather than behaviour. **An internal node cannot be
presented as a leaf** — without the `0x00`/`0x01` domain separation that is a
second-preimage attack producing an inclusion proof for something never
inserted. And **two ledgers of different length never collide**: the common
shortcut of padding an odd level by duplicating the last leaf makes `[a,b,b]`
and `[a,b]` share a root, which is exactly what a commitment must never do.

Every leaf proves at sizes 1, 2, 3, 4, 5, 8, 9, 16 and 33 — the odd ones are
where a hand-rolled tree breaks. Proofs do not transfer to another value or
another root. Malformed proofs (bad indices, non-hex paths, a 100-deep path)
return `false` rather than throwing.

### Bucketed totals and the circuit relation (`circuit.test.ts`)

**The inverted test.** The previous version ended with a bundle that omitted an
in-window entry and satisfied every constraint, kept passing on purpose with a
note that closing the gap should make it fail. It now asserts the opposite:
dropping the bucket holding the 9,000 fails **C6 completeness** — *"window
covers 25 bucket(s), witness supplies 24"*. Note that C7, the budget
constraint, *passes* in that case, because the sum really is smaller.
Completeness is doing the work.

Also caught: a bucket supplied twice to pad the count, and a commitment whose
range does not cover the window.

**Soundness**: each of the seven constraints is forged in turn — swapped
policy, swapped request, shifted time, an edited leaf total, a leaf lifted from
a commitment with a different bucket size, a payment that does not fit, a rule
that is not a window budget, and a commitment in a different asset from the
rule.

**Agreement with the engine, erring only toward refusing**: allows what
`evaluate` allows and refuses what it refuses on bucket-aligned spend; reversed
entries and other assets never enter a bucket at all. The over-count test has
to construct a genuinely off-boundary window, because at a bucket-aligned
instant there is no partial edge — the engine allows a payment the relation
refuses, which is the safe direction and never the reverse.

**The residual assumption is checkable**: a commitment rebuilt from its ledger
matches; a doctored one does not.

**Honesty**: `IS_ZERO_KNOWLEDGE` is `false`; the limit and the individual
amounts appear nowhere in the public half; completeness is now a constraint and
no longer an assumption; and what remains assumed is named.

## What is *not* covered, and why

- **Approval authenticity.** The engine counts approvals; it does not verify
  them. That belongs to the shell and will be tested where the signature check
  lives.
- **Settlement, confirmation, reversal detection.** Not in this package. The
  ledger is an input; producing it is the settlement layer's job.
- **Rail behaviour, custody, key handling.** None of it is here.
- **Two processes over one journal file.** Covered for two devices with their
  own lanes, which is the supported shape. A single journal file with
  concurrent writers needs the journal store itself to be safe for that, and
  would need its own tests there.
- **Real observers.** `ScriptedObserver` drives the reconciler; a vendor
  adapter is tested where the adapter lives.
- **Key distribution.** Tests use `MemoryKeyDirectory`. Learning which key
  speaks for whom — a registry, DNS, a certificate chain — is the hard part of
  any PKI and is not solved or tested here.
- **Algorithms other than Ed25519.** None are implemented.
- **x402 schema mapping.** Header names align; payload schemas do not, and no
  test claims they do.
- **Actual HTTP.** The module encodes and decodes header values; wiring them to
  a server belongs where a server lives.
- **Faithful totalling at commit time.** The relation cannot check it; the
  tests cover the external check (`commitmentMatchesLedger`) instead.
- **An actual zero-knowledge proof.** None exists here, and the tests assert
  that rather than obscuring it. Writing the circuit needs a proving toolchain
  and a field-native hash.
- **Transport.** `PaymentRequired` is the 402 payload as data; carrying it over
  HTTP, and the rails in `accepts`, belong to an adapter.
- **Performance under a large ledger.** `spentWithin` is linear by design
  (`DESIGN.md` → Known limits). No benchmark is asserted because no threshold
  has been agreed; asserting an arbitrary one would be theatre.
