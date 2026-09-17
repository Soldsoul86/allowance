# Examples

Twelve situations, each with the exact policy that handles it. Every example is a
standalone script that prints what was allowed, what was refused, and which
rule said so.

```bash
npm install && npm run build
npm run examples                      # all twelve, in order
node examples/05-two-person-approval.mjs   # just one
```

| | Situation | Rule kinds used |
| --- | --- | --- |
| 01 | Different daily token budgets per agent | `WINDOW_BUDGET` scoped to named requesters |
| 02 | A per-call cap on top of a daily budget; real cost recorded | `PER_TRANSACTION_LIMIT`, `WINDOW_BUDGET` |
| 03 | At most three paid calls a minute | `WINDOW_VELOCITY` |
| 04 | Approved vendors only, one explicitly blocked | `DESTINATION_ALLOWLIST`, `DESTINATION_DENYLIST`, `ASSET_ALLOWLIST` |
| 05 | Payments at or above a threshold need two distinct approvers | `APPROVAL_THRESHOLD` |
| 06 | Business hours only; an overnight window that wraps midnight | `TIME_WINDOW` |
| 07 | Release payment when a named carrier attests delivery | `ATTESTATION_REQUIRED` |
| 08 | Declared units catch a scale mistake and a typo'd asset | `units` on the policy |
| 09 | Independent budgets per asset; owner and agents differ | several `WINDOW_BUDGET` rules |
| 10 | Ledger on disk survives a restart; ambiguous failure reconciled; receipt verifies | `JournalLedgerStore`, `reconcile`, `verifyReceipt` |
| 11 | The Anthropic SDK behind the guard, with a model allowlist and a token budget | `@spendcap/anthropic`, `DESTINATION_ALLOWLIST`, `WINDOW_BUDGET` |
| 12 | x402: a retry after a lost response pays once, not twice; the reference client pays twice | `@spendcap/x402`, `PER_TRANSACTION_LIMIT`, `DESTINATION_ALLOWLIST`, `reconcile` |

Every limit in these files is a field you can change: the asset name, the
number, the window, and who the rule applies to. Nothing is hard-coded in the
packages.
