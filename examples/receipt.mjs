#!/usr/bin/env node
/**
 * A receipt you can check without trusting whoever gave it to you.
 *
 *   node examples/receipt.mjs
 *
 * An agent pays for an API call. The issuer hands you a receipt. You do not
 * work for the issuer and you have no access to their systems — all you have
 * is the file. Can you tell whether the payment was actually authorised?
 *
 * With an ordinary audit log: no. The log and the claim have the same author.
 * Here: yes, because the receipt carries the request, the rule and the ledger,
 * and the decision engine is deterministic. You re-run it yourself.
 */
import { Journal, MemoryJournalStore } from "@allowance/journal";
import {
  ANY_REQUESTER,
  JournalLedgerStore,
  SpendGuard,
  buildReceipt,
  explainVerification,
  receiptDigest,
  singlePolicy,
  verifyReceipt,
} from "@allowance/policy";

const ACCOUNT = "acct:research-agent";
const TOKENS = "anthropic:tokens";

const policy = {
  account: ACCOUNT,
  version: 3,
  rules: [
    { id: "assets", kind: "ASSET_ALLOWLIST", scope: ANY_REQUESTER, assets: [TOKENS] },
    {
      id: "daily",
      kind: "WINDOW_BUDGET",
      scope: ANY_REQUESTER,
      asset: TOKENS,
      windowMs: 86_400_000,
      maxTotal: 10_000n,
    },
  ],
};

const say = (s = "") => process.stdout.write(`${s}\n`);

const journal = await Journal.open({
  lane: "device-a",
  device: "device-a",
  store: new MemoryJournalStore(),
});
const store = await JournalLedgerStore.open({ journal });
const guard = new SpendGuard({ store, policyFor: singlePolicy(policy) });

const before = await store.entries(ACCOUNT);
const auth = await guard.authorize({
  requestId: "call-1",
  account: ACCOUNT,
  requester: { kind: "AGENT", agentId: "researcher" },
  asset: TOKENS,
  amount: 4_000n,
  destination: "vendor:messages-api",
});
await auth.settle(3_100n);

const receipt = buildReceipt({
  request: auth.request,
  decision: auth.decision,
  outcome: { state: "SETTLED", amount: 3_100n },
  facts: store.factsFor("call-1"),
  issuedAt: Date.now(),
  policy,
  ledgerContext: before,
});

say(`\n  receipt ${receiptDigest(receipt).slice(0, 16)}  —  3,100 tokens, settled\n`);
say(explainVerification(verifyReceipt(receipt)));

say("\n\n  now somebody edits the amount, hoping nobody looks:\n");
const forged = { ...receipt, request: { ...receipt.request, amount: 400_000n } };
say(explainVerification(verifyReceipt(forged)));

say("\n\n  and a receipt handed to a counterparty, with the ledger held back:\n");
const { ledgerContext: _omitted, ...rest } = receipt;
say(explainVerification(verifyReceipt({ ...rest, ledgerContext: null })));
say("\n  Redaction costs you a check; it does not silently pass one.\n");
