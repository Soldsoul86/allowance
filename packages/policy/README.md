# @allowance/policy

Programmable spend authority.

> A payment may be requested by anyone — a person, a schedule, an autonomous
> agent. **Spend authority belongs to the policy.**

```bash
npm install @allowance/policy
```

```ts
import { SpendGuard, MemoryLedgerStore, singlePolicy, explain } from "@allowance/policy";

const policy = {
  account: "acct:agent", version: 1,
  rules: [{
    id: "daily", kind: "WINDOW_BUDGET", scope: { kind: "ANY" },
    asset: "anthropic:tokens", windowMs: 86_400_000, maxTotal: 50_000n,
  }],
};

const guard = new SpendGuard({ store: new MemoryLedgerStore(), policyFor: singlePolicy(policy) });

const result = await guard.run(request, async (grant) => {
  const response = await callTheModel();
  grant.report(BigInt(response.usage.total_tokens));   // what it actually cost
  return response;
});

if (result.outcome === "REFUSED") console.log(explain(result.decision));
```

Nothing the requester sends can raise a limit, skip an approval or widen a window.

**Ten rule kinds:** requester allowlist, destination allow/denylist, asset
allowlist, per-transaction limit, window budget, window velocity, approval
threshold, time window, attestation required. Every rule is evaluated and
recorded, not just the first to fail, so a refusal is auditable rather than
merely obstructive.

**Money is `bigint` in base units.** Never a float.

**Authorised, attempted and settled are three different states.** An
authorisation is not a spend, and a request that returned 200 is not a spend.
The reconciler settles on an independent confirmation and nothing else; an
observer that answers `UNKNOWN` resolves nothing in either direction.

**Receipts verify without trusting the issuer** — seven checks, one of which
re-runs the decision from the attached policy and ledger facts and compares.

**Signature verification reports five dispositions, not a boolean:**
`authentic`, `binding_only`, `signer_authority_failed`,
`signer_resolution_failed`, `signature_invalid`. "Could not reach the key
directory" and "this key may not speak for that name" call for opposite
responses.

**Interop:** canonical encoding conforms to RFC 8785 (JCS), x402 v2 header
names, Ed25519 with `speaksFor` authority binding, RFC 6962 Merkle commitments.

**Not** a payment rail, a wallet, an identity system, or a kill switch — it
decides, it does not move money, it holds no keys, and it cannot interrupt a
call already in flight. Approvals are counted, not authenticated; your shell
must verify them first.

Apache-2.0. One dependency (`@allowance/journal`), which has none of its own.
