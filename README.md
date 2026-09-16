# allowance

**Programmable spend authority for AI agents.**

> A payment may be requested by anyone — a person, a schedule, an autonomous
> agent. **Spend authority belongs to the policy.**

Give an agent a payment method and you have given it your money. The usual
answers are a hard cap that is either too low to be useful or too high to be
safe, and a log you read afterwards. This is the other answer: the agent asks,
a policy decides, and every decision is explainable, replayable and provable
after the fact.

```bash
npm install @allowance/policy
```

```ts
import { SpendGuard, MemoryLedgerStore, singlePolicy } from "@allowance/policy";

const guard = new SpendGuard({ store: new MemoryLedgerStore(), policyFor: singlePolicy(policy) });

const result = await guard.run(request, async (grant) => {
  const response = await callTheModel();
  grant.report(BigInt(response.usage.total_tokens));   // what it actually cost
  return response;
});
```

Nothing the requester sends can raise a limit, skip an approval or widen a
window.

## See it before you install it

```bash
git clone https://github.com/Soldsoul86/allowance && cd allowance
npm install && npm run build && npm run demo
```

An agent spends until the policy stops it:

```
  call  8  ok        5096 tokens   running  36932  (over by 96)
  call  9  ok       40000 tokens   running  76932  (over by 35000)
  call 10  DENY call-10 reason=BUDGET_EXHAUSTED rule=daily-envelope

    DENY  call-10  (BUDGET_EXHAUSTED)
      76932 already committed in the window; this would reach 81932
      policy v7 bd8d63471fdc  account acct:research-agent
      ok    assets (ASSET_ALLOWLIST)          asset is allowlisted
      ok    per-call (PER_TRANSACTION_LIMIT)  [5000 of 5000]
      DENY  daily-envelope (WINDOW_BUDGET)    [81932 of 50000]
      -     after-hours (TIME_WINDOW)         AGENT:researcher is out of scope
```

Two things in that output are the whole point.

**The rules that passed are in the record too.** A refusal that only says "no"
is obstructive. One that shows every rule it consulted is auditable.

**Call 9 cost eight times its estimate and completed anyway.** No library can
interrupt a call already in flight. What it can do is charge the *true* figure
and refuse the next one — which is exactly what happened at call 10. That
limitation is documented rather than hidden, and
[the quote layer](packages/policy/README.md#quotes) is how a seller closes it.

More: `examples/receipt.mjs`, `examples/quoted-call.mjs`,
`examples/signed-quote.mjs`, `examples/budget-proof.mjs`.

## Packages

| Package | Install | What it is |
| --- | --- | --- |
| [`@allowance/policy`](packages/policy) | `npm i @allowance/policy` | The engine: rules, guard, ledger, receipts, quotes, signing, x402 transport |
| [`@allowance/journal`](packages/journal) | `npm i @allowance/journal` | Append-only, hash-chained, HLC-ordered history. Zero dependencies |
| [`@allowance/circuit`](packages/circuit) | `npm i @allowance/circuit` | Prove a spend stayed inside a budget **without revealing the budget** |

`@allowance/policy` pulls in the journal (its only dependency, and that one has
none of its own) but does not make you use it: `MemoryLedgerStore` works on its
own. Back it with the journal instead and the ledger becomes a projection you
can delete and rebuild — which is what makes a receipt checkable by someone who
does not trust whoever issued it.

## What it actually does

**Ten rule kinds**, evaluated in full every time: requester allowlist,
destination allow/denylist, asset allowlist, per-transaction limit, window
budget, window velocity, approval threshold, time window, attestation
required. Precedence is `DENY` > `REQUIRES_APPROVAL` > `ALLOW`, and every rule
is recorded whether it fired or not.

**Money is `bigint` in base units.** Never a float. A `Number` silently rounds
a large payment into a lie.

**Authorised, attempted, settled are three different states.** An
authorisation is not a spend. A request that returned 200 is not a spend. The
reconciler settles on an independent confirmation and nothing else, and an
observer that answers `UNKNOWN` resolves nothing — settling would record money
that may not have moved, reversing would free money that may be gone. See
[`PRINCIPLES.md`](PRINCIPLES.md) §42, which most payment bugs worth having are
a violation of.

**Receipts verify without trusting the issuer.** Seven checks, including one
that re-runs the decision from the attached policy and ledger facts and
compares. A receipt whose decision does not reproduce is rejected.

**Verification reports five dispositions, not a boolean** — `authentic`,
`binding_only`, `signer_authority_failed`, `signer_resolution_failed`,
`signature_invalid`. "I could not reach the key directory" and "this key has
no right to that name" call for opposite responses, and a verifier that
reports them alike hands its own outage to the reader as an accusation.
Taxonomy adopted from the [Cycles evidence spec](https://github.com/runcycles/cycles-protocol).

## Interop

- **Canonical encoding conforms to RFC 8785 (JCS)** — measured against the
  RFC's own worked example, UTF-16 code-unit key ordering and number forms,
  not asserted. `packages/policy/tests/jcs.test.ts`.
- **x402 v2 header names** — `PAYMENT-REQUIRED`, `PAYMENT-SIGNATURE`,
  `PAYMENT-RESPONSE`.
- **Ed25519 signing** with `speaksFor` authority binding: a valid signature
  from a key that may not speak for the claimed identity is reported as
  exactly that, never as a forgery.
- **RFC 6962 Merkle commitments** over the ledger, and a Groth16 circuit for
  the private case.

## What it is not

- **Not a payment rail.** It decides; it does not move money. Bring your own
  settlement and tell it what happened.
- **Not a wallet.** It holds no keys. `Signer` is a port; custody is yours.
- **Not an identity system.** It checks that a key may speak for a name you
  supply. Where that name comes from is your problem.
- **Not a kill switch.** It is an authorization boundary. It cannot interrupt
  an operation already in flight — see call 9 above.
- **Approvals are counted, not authenticated.** Your shell must verify them
  before handing them over.

## Development

```bash
npm install
npm run build        # tsc -b across every package
npm run typecheck    # also proves each package compiles independently
npm run lint         # the invariants in PRINCIPLES.md
npm test             # 344 tests, Node's built-in runner, no framework
npm run verify       # all of the above
```

TypeScript strict mode throughout, with `exactOptionalPropertyTypes`,
`noUncheckedIndexedAccess` and `verbatimModuleSyntax`.

Every package carries `README.md`, `DESIGN.md`, `API.md` and `TESTS.md`.
`DESIGN.md` states the trade-offs and the known limits; if something here
seems too good, that file is where it is qualified.

## Origin

These packages were written inside [Orb](https://github.com/Soldsoul86/orb), a
personal runtime, and extracted once it was clear they stood on their own.
[`PRINCIPLES.md`](PRINCIPLES.md) carries the rules the code cites, with their
original numbering, so a comment saying `Art. XI §42` lands somewhere real.

## License

[Apache-2.0](LICENSE). Chosen for the explicit patent grant: this repository
implements payment authorization and a zero-knowledge circuit, and an
adopter should not have to wonder.
