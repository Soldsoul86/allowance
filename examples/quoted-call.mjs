#!/usr/bin/env node
/**
 * The whole exchange, both sides.
 *
 *   node examples/quoted-call.mjs
 *
 * An agent asks a service for something. The service answers "not until you
 * pay", with a quote: a ceiling, an expiry, and what it is for. The agent
 * checks that ceiling against its own policy *before* committing, pays, and
 * gets a receipt that proves both parties behaved.
 *
 * The point is the third scene. Without a quote, the agent authorises a guess
 * and a call that runs long simply wins. With one, the unknown sits with the
 * party that actually knows it, and a seller that charges past its own
 * ceiling is caught rather than absorbed.
 */
import { Journal, MemoryJournalStore } from "@allowance/journal";
import {
  ANY_REQUESTER,
  JournalLedgerStore,
  SpendGuard,
  assessQuote,
  buildReceipt,
  explainVerification,
  quotedDraft,
  singlePolicy,
  verifyReceipt,
} from "@allowance/policy";

const ACCOUNT = "acct:research-agent";
const TOKENS = "anthropic:tokens";
const now = Date.now();
const say = (s = "") => process.stdout.write(`${s}\n`);

/* --- the buyer's rules -------------------------------------------------- */
const policy = {
  account: ACCOUNT,
  version: 4,
  rules: [
    {
      id: "known-vendors",
      kind: "DESTINATION_ALLOWLIST",
      scope: ANY_REQUESTER,
      destinations: ["vendor:messages-api/pay"],
    },
    {
      id: "per-call",
      kind: "PER_TRANSACTION_LIMIT",
      scope: ANY_REQUESTER,
      asset: TOKENS,
      maxAmount: 6_000n,
    },
  ],
};

/* --- the seller ---------------------------------------------------------- */
function paymentRequired(maxAmount, quoteId) {
  return {
    quote: {
      quoteId,
      issuer: "vendor:messages-api",
      subject: { kind: "api.call", digest: "9f2c".repeat(16) },
      asset: TOKENS,
      maxAmount,
      payTo: "vendor:messages-api/pay",
      issuedAt: now - 1_000,
      expiresAt: now + 120_000,
      audience: ACCOUNT,
      requestId: quoteId,
    },
    accepts: ["ledger:internal"],
  };
}

const journal = await Journal.open({ lane: "a", device: "a", store: new MemoryJournalStore() });
const store = await JournalLedgerStore.open({ journal });
const guard = new SpendGuard({ store, policyFor: singlePolicy(policy) });

/* --- scene 1: a quote the agent can afford ------------------------------- */
say("\n  1. agent asks. service answers 402 with a ceiling of 4,000.\n");

const offered = paymentRequired(4_000n, "call-1");
const assessment = assessQuote(offered.quote, {
  now,
  audience: ACCOUNT,
  requestId: "call-1",
});
say(`     quote usable: ${assessment.usable}`);

const before = await store.entries(ACCOUNT);
const auth = await guard.authorize(
  quotedDraft(offered.quote, {
    requestId: "call-1",
    account: ACCOUNT,
    requester: { kind: "AGENT", agentId: "researcher" },
    requestedAt: now,
  }),
);
say(`     policy says: ${auth.granted ? "ALLOW" : "REFUSE"}  (authorised the 4,000 ceiling, not a guess)`);

// The service does the work and charges under its own ceiling.
await auth.settle(3_100n);
say("     service charges 3,100 — inside what it promised\n");

const receipt = buildReceipt({
  request: auth.request,
  decision: auth.decision,
  outcome: { state: "SETTLED", amount: 3_100n },
  facts: store.factsFor("call-1"),
  issuedAt: now,
  policy,
  ledgerContext: before,
  quote: offered.quote,
});
say(explainVerification(verifyReceipt(receipt)).split("\n").map((l) => `     ${l}`).join("\n"));

/* --- scene 2: a quote the policy will not accept ------------------------- */
say("\n\n  2. same agent, a service quoting 9,000 against a 6,000 per-call limit.\n");

const pricey = paymentRequired(9_000n, "call-2");
const refused = await guard.run(
  quotedDraft(pricey.quote, {
    requestId: "call-2",
    account: ACCOUNT,
    requester: { kind: "AGENT", agentId: "researcher" },
    requestedAt: now,
  }),
  async () => "never runs",
);
say(`     ${refused.outcome} — refused before anything was spent, because the`);
say("     ceiling was knowable in advance rather than discovered afterwards\n");

/* --- scene 3: a seller that breaks its own promise ----------------------- */
say("\n  3. a service that quotes 4,000 and then charges 7,400.\n");

const forged = { ...receipt, outcome: { state: "SETTLED", amount: 7_400n } };
say(explainVerification(verifyReceipt(forged)).split("\n").map((l) => `     ${l}`).join("\n"));
say("\n     An estimate that ran long is nobody's fault. This is a broken promise,");
say("     and the receipt names it.\n");
