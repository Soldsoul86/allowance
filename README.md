# allowance

You gave an AI agent an API key, a wallet, or a card. This is what stops it
from spending more than you meant, and proves afterwards exactly what it spent
and why.

You write the limits as data: how much per call, how much per day, which
vendors, which hours, who has to approve, what has to be true first. The agent
asks; the policy decides; every decision is written to an append-only ledger
that survives crashes and can be replayed. Anyone you hand a receipt to can
re-run the decision themselves and check it comes out the same.

> A payment may be requested by anyone. **Spend authority belongs to the policy.**

Programmable spend authority for AI agents, published on npm under the
`@soldsoul86` scope.

| Package | |
| --- | --- |
| [`@soldsoul86/policy`](packages/policy) | Rules, guard, ledger, receipts, quotes, signing, x402 transport |
| [`@soldsoul86/journal`](packages/journal) | Append-only, hash-chained history. Zero dependencies |
| [`@soldsoul86/circuit`](packages/circuit) | Prove a spend stayed inside a budget without revealing the budget |

```bash
npm install @soldsoul86/policy
```

```bash
npm install && npm run build
npm run check      # exercises every claim above against the built output
```

[`examples/`](examples) holds ten situations with the exact policy that handles
each; `npm run examples` runs them all.

There is no test suite. [`check.mjs`](check.mjs) is one file that states each
property the packages claim, runs it, and exits non-zero if it does not hold.
Read it before believing the READMEs.

Apache-2.0. `@soldsoul86/circuit` pulls a GPL-3.0 proving toolchain — see [`NOTICE`](NOTICE).
