# @allowance/policy

**Programmable spend authority.**

> A payment may be requested by anyone — a person, a schedule, an autonomous
> agent. **Spend authority belongs to the policy.**

This is the same rule the trade executor is built on (*entry may come from the
signal provider; exit authority belongs to the executor*), one layer down and
pointed at money instead of positions. Nothing a requester sends can raise a
limit, skip an approval, or widen a window.

## Install

```bash
npm install @allowance/policy
```

Node 22.6+. TypeScript types included. One dependency — [`@allowance/journal`](../journal),
which has none of its own. No network calls, no key material, no vendor SDK.

```ts
import { evaluate, explain, SpendGuard, MemoryLedgerStore } from "@allowance/policy";
```

### Run it before you install it

Four demos, no configuration, no keys, no network:

```bash
git clone https://github.com/Soldsoul86/allowance && cd orb && npm install && npm run build

node examples/agent-budget.mjs   # an agent spends until the policy stops it
node examples/receipt.mjs        # a receipt verified without trusting its issuer
node examples/quoted-call.mjs    # a seller's quote bounding a buyer's spend
node examples/signed-quote.mjs   # attribution: proving who, not just what
```

Start with `agent-budget.mjs`. It is the whole idea in one screen.

## What it is

A pure, deterministic, explainable policy engine. Given a request, a policy and
a ledger of what has already moved, it returns a decision — and the complete
reasoning behind it.

```ts
import { evaluate, explain, ANY_REQUESTER } from "@allowance/policy";

const policy = {
  account: "acct:treasury",
  version: 3,
  rules: [
    { id: "assets", kind: "ASSET_ALLOWLIST", scope: ANY_REQUESTER, assets: ["USDC"] },
    {
      id: "agent-envelope",
      kind: "WINDOW_BUDGET",
      scope: { kind: "REQUESTERS", requesters: ["AGENT:researcher"] },
      asset: "USDC",
      windowMs: 86_400_000,
      maxTotal: 50_000_000n,          // 50 USDC a day, in base units
    },
    {
      id: "four-eyes",
      kind: "APPROVAL_THRESHOLD",
      scope: ANY_REQUESTER,
      asset: "USDC",
      atOrAboveAmount: 1_000_000_000n, // 1,000 USDC
      approvalsRequired: 2,
    },
  ],
};

const decision = evaluate(request, policy, ledger);
if (decision.outcome === "ALLOW") submit(request);
console.log(explain(decision));
```

## The guard — four lines around an operation

```ts
import { SpendGuard, MemoryLedgerStore, singlePolicy, explain } from "@allowance/policy";

const guard = new SpendGuard({ store: new MemoryLedgerStore(), policyFor: singlePolicy(policy) });

const result = await guard.run(
  { requestId: "call-10", account, requester: { kind: "AGENT", agentId: "researcher" },
    asset: "anthropic:tokens", amount: 5_000n, destination: "vendor:messages-api" },
  async (grant) => {
    const response = await callTheModel();
    grant.report(BigInt(response.usage.total_tokens));   // tell the truth about the cost
    return response;
  },
);

if (result.outcome === "REFUSED") console.log(explain(result.decision));
```

`node examples/agent-budget.mjs` runs a looping agent against a 50,000-token
envelope and prints the refusal when it runs out.

Outcomes are `COMPLETED`, `REFUSED`, `DUPLICATE`, `MISMATCH`, `FAILED` and
`INDETERMINATE` — the last meaning the operation threw without saying whether
it spent anything, so the reservation is deliberately left open for
reconciliation rather than guessed at.

## It remembers, and it recovers

`JournalLedgerStore` makes the ledger a projection of the Event Journal rather
than a `Map` — so a reservation survives a restart, two devices spending from
one envelope converge instead of double-counting, and the whole budget is
rebuildable by replay.

`guard.reconcile(observer, ageMs)` closes the loop on reservations left open
by an indeterminate failure. A `SpendObserver` is the sensor Art. XI §42
requires: it looks at the vendor, the chain, the statement, and reports
`SETTLED`, `NOT_SPENT` or `UNKNOWN`.

**`UNKNOWN` resolves nothing.** The reservation stays open, keeps consuming
budget, and comes back next sweep. A reconciler that resolved uncertainty by
assumption would be worse than none, because it would look authoritative
while guessing.

## Receipts you can check without trusting the issuer

Most audit trails are an assertion: *"our system authorised this, here is our
log."* The log and the claim have the same author, so a reader who does not
already trust the issuer learns nothing.

A receipt here carries the request, the policy and the ledger the decision was
made against — so a reader **re-runs the decision themselves**. That is only
possible because `evaluate` reads no clock and performs no I/O. Determinism is
usually defended as a testing convenience; this is what it is actually for.

```
node examples/receipt.mjs

VERIFIED — every check passed
  ok    FACTS_INTACT          2 event(s) hash to their contents
  ok    POLICY_BINDING        policy matches digest b6cccd650e6c
  ok    DECISION_REPRODUCES   recomputed independently: ALLOW
  ok    OUTCOME_CONSISTENT    events and outcome agree on SETTLED
```

Edit one number and `DECISION_REPRODUCES` reports *"recomputing gives DENY,
receipt claims ALLOW"*.

Full recomputation needs the ledger as it stood, which contains your other
transactions — fine for an auditor, not always for a counterparty. So `policy`
and `ledgerContext` can be omitted, and verification then reports `PARTIAL`
with the skipped checks named. **Redaction costs you a check; it never
silently passes one.**

## Quotes — the seller's half

A quote is usually described as telling the buyer the price. That undersells
it. A quote is the seller **committing to a ceiling**, and that commitment
fixes a hole the buyer cannot close alone.

The guard authorises whatever the caller estimated and cannot interrupt a call
already in flight, so a call budgeted at 1,000 that really burns 40,000
completes. No cleverness on the buyer's side fixes that — the buyer does not
know the cost until the seller decides it.

A quote moves the unknown to the party that knows it. The seller states a
maximum, the buyer authorises **that maximum**, and a seller charging past it
is no longer an accident to absorb but a broken promise, named in the receipt.

```
node examples/quoted-call.mjs

  ok    QUOTE_HONOURED   charged 3100 of a 4000 ceiling (900 unused)
  FAIL  QUOTE_HONOURED   charged 7400 against a 4000 ceiling — over by 3400
```

Quotes carry an expiry (a price with no expiry is not a price), a subject
digest (so a cheap quote cannot be presented for an expensive delivery), and
optional buyer and request bindings (so it cannot be replayed).

`quotedDraft(quote, …)` puts the seller's payee in the request's
`destination`, so an ordinary `DESTINATION_ALLOWLIST` refuses a quote from an
unapproved counterparty. No new rule kind was needed for "do I trust this
seller" — it falls out.

## Signing — proving *who*, not just *what*

A quote and a receipt already prove what was promised: their contents hash, and
editing them is caught. Neither proves **who** promised it. Anyone can mint a
quote claiming to be your vendor, and nothing in the quote objects.

```
node examples/signed-quote.mjs

  ok    vendor-key-1                        speaks for vendor:messages-api
  FAIL  vendor-key-1  [BAD_SIGNATURE]       signature does not match the payload
  FAIL  impostor-key  [KEY_NOT_AUTHORIZED]  may speak for [vendor:someone-else],
                                            not vendor:messages-api
  FAIL  burned-key    [KEY_REVOKED]         burned-key has been revoked
```

**The third line is the one that matters.** That signature is
cryptographically perfect — the maths checks out completely. The signer is
simply not that vendor. A verifier that only checked the signature would
accept it. So a key in the directory declares what it `speaksFor`, and an
unauthorised signer is a distinct outcome from a forgery, because they mean
completely different things.

Key validity is judged against **when the payload was signed**, not against
now — rotating a key must not invalidate everything it ever signed. Compromise
is separate: a `revoked` key fails whenever it signed, and reports
`KEY_REVOKED` rather than a generic failure, because a reader needs to tell
"this was forged" from "this was genuine, by a key we no longer trust".

The package holds no keys. `Signer` is a port; the reference Ed25519
implementation takes a private key you supply and keeps it in a closure, so it
cannot be read back off the object. Custody stays yours.

## Transport — the network boundary

`PAYMENT-REQUIRED` on the 402, `PAYMENT-SIGNATURE` on the retry,
`PAYMENT-RESPONSE` on settlement — x402 v2's header names, so an adapter that
speaks that dialect has somewhere obvious to map onto. The payloads are this
package's own; matching x402's `PaymentRequirement` schema field for field is a
mapping layer that is **not** implemented here, and claiming otherwise would be
a lie in a place people would rely on.

This module works to a different standard from the rest: **nothing throws, and
nothing is believed.** Every decode returns a reason instead of an exception.

Amounts must arrive as canonical decimal, and rejecting rather than repairing
is a correctness requirement, not fussiness:

| Input | A relaxed reader | Why it matters |
|---|---|---|
| `"0x10"` | `16n` | `BigInt` accepts hex. A quote priced `0x10` reads as sixteen |
| `"1e999"` | throws | ...from inside whatever was holding the decision |
| `"007"` | `7n`, re-encodes `"7"` | **the signature over the original bytes no longer verifies** |

That third row is the important one. Signatures are made over canonical bytes,
so a decoder that silently normalises has broken the signature scheme.

`admitPayment` is the seller's gate, and it compares against **the quote the
seller holds, never the one the buyer echoes back** — a protocol that compares
a payload to a copy of itself proves only that the peer can echo.

## Groundwork for a zero-knowledge proof

> **`IS_ZERO_KNOWLEDGE` is exported as `false`.** A `BudgetProofBundle` carries
> its witness in the clear. It is the statement and the test oracle a circuit
> needs, not the proof.

You prove *"this payment was inside my budget"* while the **limit stays
private** and so does **every individual transaction**.

| | |
|---|---|
| **Public** | policy digest, commitment root and parameters, request digest, time, `ALLOW` |
| **Private** | the policy *including its limits*, the request, the per-bucket totals |

### Completeness — the gap, and how it closed

An earlier version committed to individual ledger entries. A Merkle tree proves
membership and nothing else, so a prover could simply **omit** an in-window
entry: the sum came out smaller and every constraint still passed.

The fix was not more cryptography. It was taking away the prover's choice of
what to supply.

`BucketCommitment` is a **dense array of per-bucket totals** — one leaf per
bucket, zero-filled — so position `p` in the tree *is* bucket `base + p` and
nothing else can sit there. The verifier computes the covered bucket range
**from the public statement alone** and demands exactly those leaves at exactly
those positions.

```
node examples/budget-proof.mjs

  ok    C4  inclusion
  ok    C5  leaf keying
  FAIL  C6  completeness      window covers 25 bucket(s), witness supplies 24
  ok    C7  budget
```

Look at C7: dropping the heavy bucket does make the sum fit. It no longer
helps, because a missing bucket is a hole the verifier was already looking at.

The edges are **over-counted on purpose** — a rolling window rarely lands on a
bucket boundary, so the proven bound is `windowMs + bucketMs` rather than
exactly `windowMs`. That can only refuse a payment that was allowable, never
allow one that was not, which is the only direction a budget may be wrong in.
Bucket size is the dial: a day at hourly buckets is 25 leaves.

### What is still assumed

The committer must have totalled honestly. That is a far smaller thing than the
gap it replaced: it is a deterministic function of the ledger, so anyone
holding the ledger runs `commitmentMatchesLedger` and checks. A counterparty
who cannot see the ledger relies on the root being signed or published
beforehand — so a false root has to be committed to in advance and then
defended.

## What it is not

It does not move money. It holds no keys, signs nothing, talks to no chain and
knows nothing about custody or settlement. It decides; something else acts.
That separation is the point — the deciding half has to be replayable, and
anything that touches a network is not.

It also does not authenticate approvals. It *counts* them. Verifying that an
approver is who they claim to be happens in the shell, before `evaluate` is
called, because a pure function cannot check a signature against a key it has
no way to fetch.

## The three properties that matter

| Property | Why |
|---|---|
| **Deny by default** | No policy, no matching rule, wrong account — all deny. An authorization system whose failure mode is *allow* is not one. |
| **Pending money holds its budget** | Ten requests in the same millisecond must not each see an empty budget. This is the payments equivalent of a double spend. |
| **Every rule is recorded** | A decision that names one tripped limit while hiding the four it passed cannot be audited. |
| **A reused id must be the same request** | Comparing ids alone tells a client "already done" about a spend it never asked for. |

Payments can also be gated on **attested facts** — *dispatched*, *customs
cleared*, *quality accepted* — each asserted by a named party. The engine
records the hash of the supporting document and never the document, and it
never decides who counts as a legitimate attester: that belongs to whoever
carries the compliance obligation.

Amounts are `bigint` in base units, always. Time is supplied on the request,
never read from a clock — so the same inputs produce the same decision forever,
which is what makes a decision replayable (Constitution Art. I §4).

## Documents

- [`DESIGN.md`](./DESIGN.md) — why it is shaped this way, and what was rejected
- [`API.md`](./API.md) — the exported surface
- [`TESTS.md`](./TESTS.md) — what is covered and what is not
