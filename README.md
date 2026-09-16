# allowance

Programmable spend authority for AI agents.

> A payment may be requested by anyone. **Spend authority belongs to the policy.**

| Package | |
| --- | --- |
| [`@allowance/policy`](packages/policy) | Rules, guard, ledger, receipts, quotes, signing, x402 transport |
| [`@allowance/journal`](packages/journal) | Append-only, hash-chained history. Zero dependencies |
| [`@allowance/circuit`](packages/circuit) | Prove a spend stayed inside a budget without revealing the budget |

```bash
npm install @allowance/policy
```

```bash
npm install && npm run build
npm run check      # exercises every claim above against the built output
```

There is no test suite. [`check.mjs`](check.mjs) is one file that states each
property the packages claim, runs it, and exits non-zero if it does not hold.
Read it before believing the READMEs.

Apache-2.0. `@allowance/circuit` pulls a GPL-3.0 proving toolchain — see [`NOTICE`](NOTICE).
