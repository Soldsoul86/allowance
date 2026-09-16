# Design — @allowance/policy

## The rule the package exists to enforce

The trade executor is governed by one sentence: *entry may come from the signal
provider, exit authority belongs to the executor*. Once a position is open, no
external party can talk the executor out of its stop.

Rewrite that for money and you get this package:

> A payment may be requested by anyone. **Spend authority belongs to the policy.**

The structural expression of that rule is what `SpendRequest` *does not* carry.
There is no limit field, no threshold, no override flag, no priority, no
"urgent". A request carries facts about itself — who, how much, which asset,
where to, when — and nothing the engine will read as permission. An attacker
who fully controls the request cannot widen their own authority, because there
is no field through which to do it.

## Functional core, imperative shell

`evaluate` is pure and total. No I/O, no clock, no randomness, no mutation of
inputs. Everything that touches the world — fetching the policy, verifying
approval signatures, submitting to a rail, watching for confirmations — lives
outside this package.

This is not stylistic. Constitution Art. I §4 requires that every feature be
replayable from events, and Art. II §9 that interpretation be recomputable. A
decision that consulted a clock or a network could not be re-derived a year
later from the journal; it would have to be *trusted*, which is exactly what
the journal exists to avoid.

Concretely: the instant of evaluation arrives on the request as `requestedAt`,
and every window is measured relative to it. Replaying a decision replays its
time.

## Why amounts are `bigint`

Money is never a `number`. `2000 * 1.005` is `2009.9999999999998`, and a budget
that drifts by a unit per transaction is a budget that leaks. Every amount is
an integer in the asset's base unit — wei, satoshi, paise, cents — and the
engine never converts between assets, because conversion needs a rate, a rate
needs an oracle, and an oracle is a dependency that can be wrong at the worst
possible moment. A budget denominated in one asset constrains that asset alone.

## Why pending money holds its budget

This is the single most important correctness property here, and it is the
direct analogue of the executor's `claimExit`.

If only *settled* spend counted against a limit, ten requests issued in the
same millisecond would each observe an empty budget, each pass, and a daily cap
of $100 would release $1,000. The decision would have been made against state
that another in-flight decision had already changed.

So a `PENDING` entry — signed, broadcast, in a mempool, awaiting confirmations
— consumes exactly as much budget as a `SETTLED` one. Only `REVERSED`, a
payment that provably did not happen, gives its budget back.

`PENDING` exists as a state at all because of Constitution Art. XI §42: an
issued action never updates reality until a sensor confirms it. In a personal
runtime that is an epistemic stance. In payments it is settlement finality, and
getting it wrong is how money gets spent twice.

## Why every rule is evaluated

`evaluate` runs all rules and records all results, then applies precedence —
rather than returning at the first failure. Art. II §10 requires that a decision
be explainable, and a record naming one tripped limit while hiding the four
that passed cannot be audited. It also cannot answer the question an operator
asks immediately after a refusal: *how close were the others?*

Precedence is DENY, then REQUIRES_APPROVAL, then ALLOW; within a tier the first
rule in policy order wins. Rule order is therefore an authoring decision, not
an accident of iteration.

## Why evaluation is idempotent

A request is excluded from its own ledger by `requestId`. Re-evaluating an
in-flight request — after a crash, during reconciliation, on replay — returns
the same answer instead of counting the request against itself. This mirrors
the executor's deterministic client order IDs: the same intent, submitted
twice, must not become two effects.

## Why the policy is hashed

Every decision carries `policyDigest`, a SHA-256 over a canonical serialization
of the policy. A decision that names only a version number is unfalsifiable,
because versions get edited in place. A digest cannot be.

The canonical encoder is `canonicalJson` from `@allowance/journal` — reused, not
reimplemented (Art. IX §33). It refuses `bigint`, which is the correct refusal,
so amounts are rendered as decimal strings before hashing.

## Rules are data, not code

`Rule` is a discriminated union rather than an interface with implementations.
A policy is therefore serializable, hashable, journallable and replayable, and
adding a rule kind is an addition to a type — after which the compiler names
every place that must handle it. Art. X §37: the kernel evolves through
addition, never mutation.

The vocabulary is deliberately small. Each rule answers one question; one rule
with eight optional fields would be one rule nobody could reason about.

## Scope defaults to everyone

A rule with `ANY_REQUESTER` constrains all requesters. This is the only sane
default for a limit: forgetting to scope a rule must mean *applies to all*,
never *applies to none*. A scope naming zero requesters is rejected at
configuration time, because an unreachable rule is always a mistake.

Note that a scoped `WINDOW_BUDGET` measures only the scoped requesters' spend —
so an agent's daily envelope is not consumed by the owner's transfers. That is
what makes per-agent envelopes meaningful.

## Attestations: why the evidence never travels

An approval says *"I permit this."* An attestation says *"I observed this."*
One exercises authority, the other reports a fact — and Art. XI §43 is explicit
that an observation owns confidence, not truth.

`ATTESTATION_REQUIRED` is what turns a payment engine into a settlement engine:
release on *dispatched*, on *customs cleared*, on *quality accepted*. Two
constraints make it safe to build a business on:

**The engine records a digest, never a document.** A bill of lading, a customs
declaration, a verification result: the hash is stored, the original stays with
whoever holds it. A system that never holds the evidence cannot leak it, and
cannot quietly become the place everyone's documents live.

**The engine does not decide who is a legitimate attester.** A policy names
attesters; establishing that an attester is who they claim, and is entitled to
the claim, happens in the shell under whoever's compliance obligation it
actually is. This is not squeamishness — deciding who may participate is
precisely what makes someone an operator rather than a tool, and the whole
point of this shape is that each licensed participant carries its own
obligation rather than inheriting one from us.

A future-dated attestation is never current. A clock problem and a forgery look
identical from here, and neither should release money.

## What was considered and rejected

**Cross-asset limits.** Requires a price oracle. Rejected: it introduces a
dependency that can be stale or manipulated, and it makes the engine impure.
Denominate budgets per asset and let a higher layer reason about totals.

**Rules as plugins/classes.** Rejected: unhashable, unserializable, and it lets
arbitrary code into the authorization path. Composition over inheritance, and
data over code, are both project rules and both point the same way here.

**Returning at the first failure.** Rejected on explainability grounds, above.

**Reading the clock inside `evaluate`.** Rejected: breaks replay.

**A `force` or `override` field on the request.** Rejected: it is precisely the
field that destroys the property the package exists to provide. An override, if
ever wanted, is a *policy amendment* — a new version, a new digest, a new
journal entry — not a flag on a request.

**Local timezones in `TIME_WINDOW`.** Rejected: a decision must not depend on
where it was evaluated. UTC minutes only.

## The critical section, and a correction

An earlier version of this package made `authorize` and the whole
`LedgerStore` synchronous, and argued that synchrony was what kept the
critical section safe. That was half right, and the missing half mattered.

Synchrony is *sufficient* for atomicity on a single-threaded runtime. It is
not *necessary* — and it buys atomicity at the cost of durability, because a
durable append cannot be synchronous. The invariant was never "the critical
section is synchronous". It is:

> **Read, decide and reserve must not interleave with another caller doing the
> same, and the reservation must be durable before the operation runs.**

A lock delivers both. Synchrony delivers only the first. So `SpendGuard`
serialises every ledger mutation through a promise chain — the same mechanism
the Journal uses to keep its own hash chain intact — and awaits the append
before returning.

Settlements go through the same lock, not just reservations: a settle landing
between another caller's read and its reservation would let that caller decide
against a ledger that no longer exists.

Note that losing a reservation is *not* like losing an audit line. The
executor's audit sink deliberately does not await the journal, because a
dropped record is recovered by reconciling against the exchange. A dropped
reservation silently returns budget that may already have been spent, and
nothing outside the ledger knows it existed.

## The guard: why a failed operation is not reversed

Art. XI §42 again: Orb never assumes an Action changed reality. A thrown error
does not tell you whether the money moved. A connection reset before the
request left and a response lost after the vendor already charged are
indistinguishable from inside the `catch`.

So the default is to **hold**. The reservation stays open, the outcome is
`INDETERMINATE`, and `openReservations` surfaces it for reconciliation against
the vendor. Reversing would release budget for money that may well have been
spent — the expensive direction to be wrong in. An operation that *knows* it
spent nothing says so with `grant.report(0n)`, and one that knows it was
charged reports the figure before throwing.

Note that a zero-cost settled attempt still counts against a velocity limit.
It cost nothing, but it happened.

## The guard: the ledger records truth, not intent

`grant.report(actual)` exists because an estimate is not an outcome. A call
budgeted at 4,000 tokens that really consumed 4,231 must land in the ledger as
4,231, or every later budget decision inherits the error. Overages are
**recorded, not prevented** — the spend has already happened — and the next
decision sees the true, higher figure, so the budget self-corrects.

## The ledger is a projection, not a source of truth

Art. I §3: the journal is the single source of truth, everything else is a
derived projection that may be discarded and rebuilt. Holding the ledger in a
`Map` and calling it authoritative was a violation of this package's own
constitution, and the reason a reservation could not survive a restart.

`JournalLedgerStore` makes the ledger a fold over three immutable facts —
`payment.reserved`, `payment.settled`, `payment.reversed` — and three things
follow for free:

- **A restart resumes**, because the fold is deterministic (Art. II §9).
- **Devices share an envelope.** Replicated lanes carry the same facts and
  `orderEvents` puts them in HLC order, so two devices spending from one
  budget converge rather than double-count (Art. IV §18).
- **Reconciliation is a fold**, not a special case: an open reservation is a
  `reserved` with no matching `settled` or `reversed`.

Reads are served from an in-memory projection so deciding costs no I/O; the
projection is only ever advanced by the journal's own listener, so local
appends and replicated events take the identical path and cannot diverge.

Amounts are written as decimal strings. `canonicalJson` refuses `bigint` —
correctly, since JSON has no unambiguous encoding for one — and a lossy
`Number` in a money ledger is the exact bug this package exists to prevent.

A partially replicated lane can legitimately contain a `settled` whose
`reserved` has not arrived yet. That is a gap in replication, not corruption,
so an orphan is skipped rather than thrown: refusing to open would make a
partially synced device unusable.

## Reconciliation: why UNKNOWN resolves nothing

The guard refusing to guess is correct but incomplete — a system that only
accumulates unresolvable reservations is honestly stuck rather than safe.
Art. XI §42 says how it ends: the loop closes only when a Sensor confirms.
`SpendObserver` is that sensor, and it is the one component here that looks at
the outside world.

The rule that makes it trustworthy is what happens on `UNKNOWN`: **nothing.**
The reservation stays open, keeps consuming budget, and is offered again next
sweep. A reconciler that resolved uncertainty by assumption would be worse
than no reconciler, because it would look authoritative while guessing.

Observation happens outside the lock — a vendor call is slow and must not
block every decision in the process — and only the resulting write is
serialised. One unreachable vendor is recorded and skipped rather than
abandoning the sweep.

## Receipts: why determinism was worth the constraints

Every restriction in the engine — no clock, no I/O, no oracle, time supplied on
the request — was paid for somewhere. This is where it is collected.

Because `evaluate` is a pure function of `(request, policy, ledger)`, a receipt
that carries all three lets a reader **recompute the decision and compare**.
That converts an audit trail from an assertion by the issuer into something a
stranger can check. A conventional log cannot do this at any level of detail,
because the log and the claim have the same author.

The trade-off is disclosure: full recomputation needs the ledger as it stood,
and that ledger holds your other transactions. So `policy` and `ledgerContext`
are optional, and `verifyReceipt` reports each check separately with
`SKIPPED` distinct from `PASS`. A verifier that silently downgraded a skipped
check to a pass would be worse than no verifier, so `verified` requires that
*nothing* was skipped, and a weaker result is labelled `PARTIAL` rather than
quietly counted as success.

## Quotes: moving the unknown to the party that knows it

`examples/agent-budget.mjs` iteration 9 is the honest failure in this package:
a call authorised at an estimate of 5,000 that really consumed 40,000
completes, and the guard can only record the damage. It is listed under Known
limits below as something nothing outside the call can prevent.

That is true of the *buyer*. It is not true of the exchange. The buyer cannot
know the cost in advance because the seller decides it — so a quote asks the
seller to state a ceiling, and the buyer authorises that ceiling rather than a
guess. The authorisation becomes exact not because the estimate improved but
because the counterparty is bound.

The consequences are worth naming:

- **A refusal now happens before the spend, not after.** A ceiling above
  policy is rejected while nothing has been consumed.
- **An overcharge changes category.** An estimate that ran long is nobody's
  fault. Charging past a ceiling you published is a broken promise, and
  `QUOTE_HONOURED` names it with the amount.
- **Counterparty trust needed no new rule.** `quotedDraft` puts the seller's
  payee in `destination`, so `DESTINATION_ALLOWLIST` already answers "do I
  deal with this seller".

Expiry is exclusive, for the same reason the sentinel's breach is `>=`: a
deadline you can sit exactly on is not a deadline.

Like a receipt, a quote is verifiable but not attributable — it proves *what*
was promised, not *who* promised it. Signing belongs in the layer that holds
keys, and this package deliberately holds none.

## Signing: the check almost everyone forgets

A valid signature proves a key signed these bytes. It does **not** prove the
signer was entitled to the identity the payload claims. If a quote says
`issuer: "vendor:messages-api"`, a correct signature from *some* key proves
nothing about that vendor.

So `PublicKeyRecord.speaksFor` names the identities a key may sign for, and
`verifySignatures` refuses a technically perfect signature from a key outside
its remit. `KEY_NOT_AUTHORIZED` is a separate outcome from `BAD_SIGNATURE`
because they are different events: one is a forgery, the other a real party
signing outside what it was entitled to. A verifier that returned "invalid" for
both would hide which of those had happened.

An empty `speaksFor` attributes nothing. That is the right default for a key
whose remit was never stated.

**Time belongs to the signature, not the verifier.** Key validity is checked
against `signedAt`, so rotating a key does not invalidate everything it ever
signed — otherwise every historical receipt breaks on the day you rotate.
Compromise is a separate switch: `revoked` fails regardless of when the key
signed, and reports itself distinctly, because a reader needs to tell "forged"
from "genuine, by a key we no longer trust".

Malformed input never throws out of verification. A bad key or a truncated
signature reads as *not verified*, never as a crash in the middle of deciding
whether to trust a payment.

### A boolean was the wrong answer

For several revisions `verifySignatures` answered with `attributed: boolean`.
That is the same conflation the paragraph above criticises, one level up: it
collapses *four different failures* into one word, and the four call for
opposite responses. "The directory timed out" and "this key has no right to
this name" are not the same event, and a seller that treats the first like the
second bills its own outage to the buyer.

So verification now reports a `disposition` — `authentic`, `binding_only`,
`signer_authority_failed`, `signer_resolution_failed`, `signature_invalid` —
ranked best-first, with `attributed` kept as a convenience for
`disposition === "authentic"`. The taxonomy is adopted from the
[Cycles evidence spec](https://github.com/runcycles/cycles-protocol) rather than
invented here; they drew the line first and drew it correctly.

Three consequences are deliberate:

- **`KeyDirectory` had to change with it.** A lookup returning
  `PublicKeyRecord | undefined` cannot express "I could not look" at all, so the
  disposition could never have been derived honestly downstream. It now returns
  a `KeyLookup` that names `UNKNOWN` or `UNAVAILABLE`.
- **An unsigned payload takes `signature_invalid`,** the most serious
  disposition, not a gentler one. Absence must never read better than a bad
  signature.
- **`admitPayment` gained `ATTRIBUTION_INDETERMINATE`,** because this is where
  the distinction costs someone money: a seller whose directory is down should
  retry, not refuse the buyer and not deliver.

The specific `SignatureRejection` survives alongside the disposition. The
disposition says what kind of failure it was; the rejection says which one.

**This package holds no keys.** `Signer` is a port; the reference Ed25519
implementation captures a caller-supplied private key in a closure so it is not
reachable from the object, cannot be serialised by accident, and is not printed
by a debugger walking the signer. Generating, storing and destroying key
material belongs to whoever owns the identity, not to a library that also
decides whether payments are allowed.

## Transport: a different standard

Everything else in this package is fed by its own caller. `transport.ts` is the
first thing that reads bytes a stranger wrote, so it holds two rules the rest
does not need: **nothing throws, and nothing is believed.**

### Strict parsing is a correctness requirement

Amounts cross the wire as decimal strings, and a relaxed reader is a bug rather
than a style complaint. `BigInt("0x10")` is `16n`. `BigInt("1e999")` throws,
from inside whatever was holding the decision. And `"007"` parses to `7n`,
re-encodes as `"7"`, and **the signature made over the original bytes no longer
verifies** — a valid payment refused for reasons nobody can see.

That last one is why normalising is worse than rejecting: signatures are made
over canonical bytes, so a decoder that helpfully tidies its input has broken
the signature scheme underneath it. Amounts must arrive canonical or not at
all.

The base64 check round-trips rather than trusting `Buffer.from`, which is
lenient and silently drops junk — so "it decoded" does not mean "it was
base64".

### The seller compares against its own quote

`admitPayment` checks the presented authorisation against the quote the
**seller** holds, never the copy the buyer sends back. A protocol that compares
a payload to a copy of itself proves only that the peer can echo. The test for
this presents a perfectly coherent, correctly signed authorisation for a
cheaper quote the buyer invented; it is refused as `WRONG_QUOTE`.

The buyer must also authorise the **full ceiling**, not less — otherwise the
seller does the work and then discovers it may not charge for it.

### One validator, not two

`decodeSettlement` deliberately does not re-derive the receipt's interior.
`verifyReceipt` already recomputes the entire decision and is the real gate; a
second, weaker validator at the boundary would become a second opinion people
trusted by mistake. The decode establishes that the envelope is well-formed and
says so plainly, and the docs push the caller to the verifier.

## The circuit: why the statement comes before the cryptography

The proving system is not the hard part of making a policy decision private,
and it is not the part that has to come first.

A circuit is useless without a **statement**: a precise split of public from
private, and a relation between them expressible as arithmetic. Getting that
wrong yields a proof of the wrong thing, which is worse than no proof, and no
proving system rescues it. A circuit also needs a **test oracle** — the
relation written twice, once in constraints and once in ordinary code, checked
to agree on every input. Ordinary code is the half that can exist today, and
the half a cryptographer needs in order to write the other.

So `circuit.ts` is that statement and that oracle, and `IS_ZERO_KNOWLEDGE` is
exported as `false` so the claim sits somewhere type-checked rather than only
in prose.

The split puts the **limit on the private side**. That is the property worth
having: proving "this was within my budget" without revealing what the budget
is or what else it was spent on. The tests assert the limit appears nowhere in
the public half.

C4 — Merkle inclusion — dominates the cost. SHA-256 is tens of thousands of
constraints per path step, so a real circuit swaps in a field-native hash
(Poseidon, Rescue) and the tree here is rebuilt with it. C1–C3 move for the
same reason. C5 and C6 are integer comparisons and nearly free. That ordering
is the useful output of doing this in plain code first: it says where the
engineering will actually go.

### Completeness: closed by removing the prover's choice

The first version committed to individual ledger entries, and a prover who
omitted an in-window entry produced a smaller sum with every constraint still
passing. That was reported as an assumption rather than a constraint, and a
test omitted an entry and passed on purpose, with a note that if the gap ever
closed the test should start failing. It has, and it does.

**The fix was not cryptography.** A Merkle tree proves membership and will
never prove that nothing else exists, so no proving system bolted on later
could have helped. The fix was to stop letting the prover decide what to
supply.

`BucketCommitment` is a **dense array** of per-bucket totals — one leaf per
bucket index, zero-filled where nothing was spent — so position `p` in the
tree *is* bucket `from + p`, and nothing else can occupy it. The verifier then
computes the covered range **from public values alone** (`requestedAt` and the
rule's own `windowMs`) and demands exactly those leaves at exactly those
positions. Omitting one leaves a hole the verifier was already looking at.
Inventing one lands at the wrong position and fails C5.

Note what C7 does in the cheating case: the sum really does come out smaller,
and the budget constraint really does pass. Completeness is doing the work, not
arithmetic.

### The edges over-count, deliberately

A rolling window rarely lands on a bucket boundary, so the first and last
buckets carry a little time from outside it. The proven bound is therefore
`windowMs + bucketMs` rather than exactly `windowMs` — **stronger** than the
policy requires.

Over-counting can only refuse a payment that should have been allowed. It can
never allow one that should have been refused, and that is the only direction
a budget may be wrong in. The cost is liveness, not safety, and it shrinks with
the bucket. Leaves per proof is `ceil(windowMs / bucketMs) + 1`: a day at
hourly buckets is 25 leaves and over-counts by up to an hour; at one-minute
buckets it is 1,441 leaves, which no circuit wants. That trade is the caller's.

### What remains assumed, and why it is a smaller thing

The committer must have totalled honestly. That is not the old gap dressed up:

- It is a **deterministic function of the ledger**, so anyone holding the
  ledger rebuilds the commitment and compares roots. `commitmentMatchesLedger`
  is that check, not a promise of one.
- A counterparty who cannot see the ledger discharges it the ordinary way: the
  root is signed, published or anchored *before* the fact, so it cannot be
  rewritten afterwards.

The old assumption could be broken silently by anyone, leaving no artefact. This
one requires publishing a false root in advance and then being unable to produce
a ledger that matches it.

`checkBudgetRelation` reports it under `assumptions`, apart from `constraints`,
because a result that folded an unchecked assumption in with seven checked ones
would be a lie told by a data structure.

## Idempotency: an id is not a request

The first version of the guard treated any repeated request id as a duplicate.
That is the wrong check, and it was a bug rather than a missing feature: a
client reusing an id for a different amount was told "already done" about a
spend it had never asked for — the failure the agentic-payments literature
calls an idempotency mismatch, and the one that lets a caller believe a payment
succeeded when nothing was authorised.

An idempotency key promises *the same request, twice, spends once*. That
promise is only worth something if the request is compared, not merely the key.
So a reservation carries `requestIntent`: a fingerprint of what would actually
move — account, requester, asset, amount, destination — and a reused id
carrying anything different is refused as `MISMATCH`.

**What is excluded matters as much as what is included**, because a
fingerprint that is too wide rejects retries that were never wrong:

- `requestedAt` — the shell stamps it from a clock, so a genuine retry carries
  a later instant. Including it would make *every* retry a mismatch.
- `approvals` and `attestations` — a retry may carry more, collected since.
  They change whether a spend is permitted, never what the spend is.
- `memo` — cosmetic.

The fingerprint is stamped at reservation and never touched by settlement.
That is not incidental: `settle` replaces `amount` with what was really spent,
so the entry can never be the record of what was *asked for*. A test settles at
400 against a request for 1,000 and checks that 1,000 still matches and 400 now
mismatches — which is exactly where the bug would return if anyone later
derived the fingerprint from the stored amount.

A ledger entry written before fingerprints existed replays with `intent: ""`,
meaning "cannot be compared". Such a retry falls back to plain duplicate
detection: no worse than the behaviour it replaces, and it never passes a
changed request off as a matching one. `payment.reserved` is schema v2 for the
added field; v1 events still replay (Art. X §37).

## A retry is owed the answer it was given

Detecting a duplicate is only half of an idempotency guarantee. The other half
is what comes back: a caller that lost its first answer — to a timeout, a
crash, a dropped connection — retries precisely because it does not know what
happened, and handing it a *fresh* evaluation answers a different question.

Between two attempts the ledger moves: other spends land, budgets fill,
policies are edited. Re-deciding a retry against that newer world can refuse a
payment that was allowed and may already have been made. So a reservation
records the decision that authorised it, and a duplicate returns that.

**Where the decision lives, and why not in its own event.** It sits on the
reservation rather than in a separate `payment.decided` event, because a
reservation exists *because* a decision allowed it: two events that can never
appear apart are one event pretending to be two. `LedgerEntry` therefore
type-imports `Decision` from `evaluate.ts`, which under
`verbatimModuleSyntax` erases completely — the apparent cycle does not exist
at runtime.

An entry recorded before decisions were kept returns `null` rather than a
re-derived one. Inventing an answer would be the same error as guessing at an
ambiguous settlement: it would look authoritative while being a fresh opinion
about a past event.

## Deadlines: a timer is not evidence

Cycles gives a reservation a TTL, and on expiry *"the action is treated as
never committed"* — budget released, no reconciliation. That is a guess, and it
is the expensive direction: if the provider charged before the client died,
the budget comes back for money that was spent.

Art. XI §42 does not stop applying because a timer fired. A reservation that
outlived its deadline is the **indeterminate** case, not the didn't-happen
case, so here:

- **Expiry is derived, never recorded.** Nothing *happens* when a deadline
  passes — a settlement simply fails to arrive. Writing a `payment.expired`
  event would be journalling the passage of time, which history already knows.
- **Expiry does not release budget.** `consumesBudget` ignores deadlines
  entirely. An expired reservation holds exactly what a live one holds.
- **Expiry directs attention.** `expiredReservations` is a worklist, not a
  cleanup: each entry needs somebody to find out what actually happened, which
  is what `reconcile` and a `SpendObserver` are for.

`graceMs` covers the race where a legitimate settlement is already in flight as
the deadline passes. Without it a commit landing a millisecond late looks
identical to an abandoned reservation.

`extend` exists for the operation that is legitimately still running — a long
generation, a slow provider — and is refused once grace is gone. At that point
the reservation's status is a genuine question, and quietly extending it would
bury the question rather than answer it. It measures from now rather than from
the old deadline, so an extension buys the time it says it buys.

`releaseExpired` is the escape hatch, and it is deliberately unpleasant to
reach for. Holding a budget forever against a provider that will never answer
is its own failure, so an operator who knows their provider is transactional
must be able to say so — but they say it explicitly, it applies only to
reservations past grace, and every reversal is journalled. The guess is
recorded as a decision somebody made, never as something the system quietly
did.

## Denominations: an opaque identifier has no wrong values

Every amount here is a `bigint` in "the asset's smallest indivisible unit", and
nothing recorded what that unit was. The type system cannot help — `5n` meaning
five USDC and `5n` meaning five millionths of one are the same value, and the
engine would add them together.

Two failures follow, and both are silent.

**A scale disagreement.** One caller sends `5n` for five USDC while the ledger
holds `5_000_000n` for the same. A fifty-USDC budget is never reached, because
every spend rounds to nothing against it.

**A typo makes a second budget.** `"USDC "` with a trailing space is a
different asset to every rule that reads it. The `WINDOW_BUDGET` for the
correct spelling never constrains it, and the spend accrues in an envelope
nobody declared. There is a test that demonstrates exactly this happening
before showing the declaration turning it into a refusal — it is the clearest
statement of what the feature is for.

### Why the declarations live on the policy

They could have been a registry passed alongside. Putting them *in* the policy
means the policy digest covers them, so a receipt proves which denominations
were in force rather than only which limits — a limit of 100 means nothing if
the reader cannot tell 100 of what.

It also keeps `evaluate` pure: no new parameter, no new dependency, and the
check is data the policy already carries.

### Why opt-in, and what that costs

Omitting `units` keeps the previous behaviour exactly, **including the digest**
— a policy that declares none hashes as it did before units existed, so no
existing receipt is invalidated. The cost is honest and worth stating: a policy
that declares nothing has no unit safety at all, and neither failure above is
detectable in it.

### Two checks, at two different times

At evaluation, denomination is checked **before any rule**, because a rule
judging an amount in the wrong unit gives a confident answer to the wrong
question.

At load, `validatePolicy` rejects a rule naming an undeclared asset. Such a
rule **fails open** — it never applies, and the spend is simply not covered.
That is precisely the hole being closed, so it is caught at configuration
rather than never.

`maxAmount` is a ceiling on nonsense rather than a policy limit: it catches six
decimals confused for eighteen, where the number is enormous rather than merely
wrong.

## Known limits

- **Window queries are linear in ledger size.** `spentWithin` scans every
  entry. At realistic volumes this is irrelevant, and Art. IX §36 says build
  the simplest correct thing. A caller with a large history may pre-filter to
  the longest window; correctness does not depend on it.
- **A duplicate returns the original decision, not the original operation
  result.** The value an operation returned is the caller's data — arbitrary
  and potentially large — and is not stored. Protocols that require replay to
  reproduce the full original response body want more than this.
- ~~**The canonical encoding is not RFC 8785.**~~ It is. This sat in this list
  for several revisions on the strength of an assumption nobody had tested.
  When it was finally measured against the RFC — the §3.2.3 worked example,
  UTF-16 code-unit key ordering across a surrogate pair, the ECMAScript number
  forms — it already conformed on every point. `tests/jcs.test.ts` now holds it
  there. The lesson worth keeping is not about JSON: a limitation recorded
  without being measured is a guess wearing the clothes of a known issue, and
  it cost interop credibility for nothing.
- **Approvals are counted, not verified.** Stated in the README and the code.
  The shell must authenticate them first.
- **No settlement.** This package decides; it does not act, watch, or confirm.
  That is the next package.
- **The guard is an authorization boundary, not a kill switch.** It cannot
  interrupt an operation already in flight. A call authorized at an estimate
  of 5,000 that really consumes 40,000 completes, and the overage is recorded
  rather than prevented — `examples/agent-budget.mjs` shows exactly this on
  iteration 9. The protection is that the *next* call sees the true figure and
  is refused. If you need a per-call ceiling enforced against the actual
  spend, the operation itself has to enforce it; nothing outside the call can.
- **Unit checking is off unless a policy declares `units`.** A policy that
  declares none has no protection against a scale disagreement or a typo'd
  asset, which is the behaviour it had before.
- **`decimals` is presentation and range-checking only.** The engine still
  computes exclusively in base units; a decimal point in arithmetic is how
  money drifts.
- **Nothing expires unless a TTL is configured.** The default is no deadline,
  which is the behaviour every reservation had before deadlines existed.
- **`releaseExpired` is a guess.** It assumes nothing was spent. Prefer
  `reconcile`; reach for this only against a provider you know is
  transactional.
- **`MemoryLedgerStore` is in-process.** A reservation does not survive a
  restart and two processes do not share a budget. Use `JournalLedgerStore`
  for anything that must remember.
- **One journal, one writer.** `JournalLedgerStore` serialises through the
  guard's lock within a process. Two processes over the *same* journal file
  need the journal's own store to be safe for concurrent writers; two devices
  with their own lanes are fine, and that is the supported shape.
- **Reconciliation is only as good as its sensor.** An observer that returns a
  confident wrong number writes it into an immutable ledger. `UNKNOWN` is
  always the safer answer.
- **Key distribution is out of scope.** `KeyDirectory` resolves an id to a
  record; how you learn that record — a registry, a DNS record, a certificate
  chain, a file someone handed you — is the hard part of any PKI and is not
  solved here. The directory is synchronous so verification stays replayable,
  which means a remote directory must be snapshotted before use.
- **x402 wire compatibility is not implemented.** The header names match, the
  payload schemas do not. Mapping onto x402's `PaymentRequirement` is a
  separate adapter, and the honest status is "has somewhere obvious to map
  onto", not "compatible".
- **No HTTP.** This module encodes and decodes header values. Binding them to a
  server or client belongs in an app, not in a package that must compile
  without a network.
- **There is no zero-knowledge proof here.** `circuit.ts` reveals its witness.
  It is the statement and the test oracle, not the proof.
- **Faithful totalling is assumed, not proven by the relation.** Checkable by
  anyone with the ledger (`commitmentMatchesLedger`), or discharged by
  publishing the root in advance.
- **Bucket granularity over-counts the window edges.** Safe direction only;
  see above.
- **One algorithm.** Ed25519 only. `SignatureAlgorithm` is a union so adding
  another is an addition the compiler then enforces everywhere, but nothing
  else is implemented today.
