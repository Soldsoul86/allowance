# @spendcap/x402

x402 behind a spend guard. The policy decides before anything is signed, the
budget is reserved before the authorization exists, and a retry of the same
purchase presents the same authorization instead of minting a new one and
paying twice.

```bash
npm install @spendcap/x402 @spendcap/policy @x402/core
```

```ts
import { x402Client } from "@x402/core/client";
import { ExactEvmScheme } from "@x402/evm";
import { SpendGuard, MemoryLedgerStore, singlePolicy } from "@spendcap/policy";
import { guardX402, SpendRefusedError } from "@spendcap/x402";

const USDC_BASE = "eip155:8453/0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const policy = {
  account: "acct:agent", version: 1,
  rules: [
    { id: "per-call", kind: "PER_TRANSACTION_LIMIT", scope: { kind: "ANY" }, asset: USDC_BASE, maxAmount: 50_000n },       // $0.05
    { id: "daily",    kind: "WINDOW_BUDGET",         scope: { kind: "ANY" }, asset: USDC_BASE, windowMs: 86_400_000, maxTotal: 5_000_000n }, // $5
    { id: "services", kind: "DESTINATION_ALLOWLIST", scope: { kind: "ANY" }, destinations: ["x402:api.example.com"] },
  ],
};

const guard = new SpendGuard({ store: new MemoryLedgerStore(), policyFor: singlePolicy(policy) });
const client = new x402Client().register("eip155:8453", new ExactEvmScheme(signer));
const paid = guardX402(client, { guard, account: "acct:agent", requester: { kind: "AGENT", agentId: "researcher" } });

const fetchWithPay = paid.fetch(fetch);
try {
  const response = await fetchWithPay("https://api.example.com/quote");
} catch (error) {
  if (error instanceof SpendRefusedError) console.log(error.message); // "DENY  ...  (TRANSACTION_TOO_LARGE)"
  else throw error;
}
```

**The problem this fixes.** The reference x402 client signs a fresh
authorization, with a fresh nonce, every time it sees a 402. A response lost
after the facilitator settled looks, from the client, exactly like a response
lost before the request left, and a client that answers both by signing again
has paid twice for one resource. The maintainers have it on file as
[x402-foundation/x402#3438](https://github.com/x402-foundation/x402/issues/3438).
`examples/12-x402-retry-pays-once.mjs` reproduces it against the real
reference wrapper, then shows the same client paying once behind the guard.

**Two layers.** `guardX402(client, options)` registers hooks on the
`x402Client`. Whatever drives that client afterwards, the reference
`wrapFetchWithPayment`, axios, your own code, the policy runs before every
signature and a second signature for an unresolved purchase is refused. That
alone closes the double-spend. `.fetch(fetch)` is a fetch wrapper that
additionally *reuses* the authorization on retry, so the retry completes the
purchase instead of being refused, and settles the ledger from the server's
`PAYMENT-RESPONSE`.

**What a purchase is.** By default, the account, the requester, the resource
URL and the terms offered. A retry derives the same id and is absorbed. A
server that quotes a different price on the retry produces a different
purchase, judged afresh. Buying the same resource twice on purpose needs a
`purchase` key on the request, or your own `requestId` rule.

**What is recorded.** The asset is `<network>/<asset>`, so a budget names one
token on one chain; the amount is the requirement's amount in atomic units,
parsed strictly; the destination is `x402:<host>` of the resource, so an
ordinary allowlist is a list of services you will pay. Each is an option.

**When the server answers.** Settled: the ledger settles at the amount the
facilitator reports, or the terms if it reports none. Settlement failed, or a
fresh 402 meaning verification failed on the first presentation: nothing
moved, the reservation is reversed. A transport error, or a response with no
payment header: the reservation stays open and the authorization stays held,
because from here that is indistinguishable from money spent.

**When the retry is refused.** A facilitator that already consumed the nonce
refuses the re-presented authorization with the same 402 it uses for a bad
signature, so on a second presentation that 402 proves nothing. The
reservation is held, the authorization is retired, further attempts raise
`SpendDuplicateError`, and `guard.reconcile` against the chain decides. A
server that recognises a repeated authorization and returns its original
result, as the reproduction's does, lets the retry simply complete. Either
way it never pays twice.

**After a restart.** Nothing is held in memory, so a retry of an open
purchase is refused with `SpendDuplicateError` rather than re-signed, and the
reservation is a question for `guard.reconcile` against the chain. This is
the conservative direction on purpose.

`@x402/core` is a peer dependency used at runtime for the client hooks and
the header codecs. Nothing about the wire format is reimplemented here.

Ships without a test suite. `npm run check` at the repository root exercises
the claims above against the built output and the real `@x402/fetch`.

Apache-2.0.
