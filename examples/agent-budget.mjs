#!/usr/bin/env node
/**
 * Four lines around an agent's API call, and it cannot run up a bill.
 *
 *   node examples/agent-budget.mjs
 *
 * The agent here is a stand-in: it loops, each iteration costs tokens, and one
 * iteration goes badly wrong. Nothing about the guard is specific to tokens,
 * or to money — `asset` is an opaque string and `amount` is an integer in
 * whatever base unit you choose.
 *
 * What you are meant to look at is the refusal. Most of this space is busy
 * making payments work; almost nobody makes a refusal legible.
 */
import {
  ANY_REQUESTER,
  MemoryLedgerStore,
  SpendGuard,
  explain,
  singlePolicy,
  summarize,
} from "@allowance/policy";

const ACCOUNT = "acct:research-agent";
const TOKENS = "anthropic:tokens";

const policy = {
  account: ACCOUNT,
  version: 7,
  rules: [
    { id: "assets", kind: "ASSET_ALLOWLIST", scope: ANY_REQUESTER, assets: [TOKENS] },
    {
      id: "per-call",
      kind: "PER_TRANSACTION_LIMIT",
      scope: ANY_REQUESTER,
      asset: TOKENS,
      maxAmount: 5_000n,
    },
    {
      id: "daily-envelope",
      kind: "WINDOW_BUDGET",
      scope: { kind: "REQUESTERS", requesters: ["AGENT:researcher"] },
      asset: TOKENS,
      windowMs: 86_400_000,
      maxTotal: 50_000n,
    },
    {
      id: "after-hours",
      kind: "TIME_WINDOW",
      scope: { kind: "REQUESTERS", requesters: ["AGENT:nightly"] },
      fromMinuteUtc: 1_320,
      toMinuteUtc: 360,
    },
  ],
};

const guard = new SpendGuard({
  store: new MemoryLedgerStore(),
  policyFor: singlePolicy(policy),
});

/** Stands in for a real call. Iteration 9 is the one that goes wrong. */
async function callTheModel(iteration, grant) {
  const actual = iteration === 9 ? 40_000n : 4_000n + BigInt(iteration * 137);
  grant.report(actual);            // tell the truth about what it cost
  return { iteration, tokens: actual };
}

const say = (s = "") => process.stdout.write(`${s}\n`);
say("\n  an agent with a 50,000 token daily envelope, looping\n");

let spent = 0n;
for (let i = 1; i <= 14; i++) {
  const result = await guard.run(
    {
      requestId: `call-${i}`,
      account: ACCOUNT,
      requester: { kind: "AGENT", agentId: "researcher" },
      asset: TOKENS,
      amount: 5_000n,                       // the estimate
      destination: "vendor:messages-api",
    },
    (grant) => callTheModel(i, grant),
  );

  if (result.outcome === "COMPLETED") {
    spent += result.actual;
    const flag = result.overage > 0n ? `  (over by ${result.overage})` : "";
    say(`  call ${String(i).padStart(2)}  ok      ${String(result.actual).padStart(6)} tokens   ` +
        `running ${String(spent).padStart(6)}${flag}`);
    continue;
  }

  if (result.outcome === "REFUSED") {
    say(`  call ${String(i).padStart(2)}  ${summarize(result.decision)}`);
    say("");
    say(explain(result.decision).split("\n").map((l) => `    ${l}`).join("\n"));
    say("");
    say("  The agent is stopped. Note the rules that PASSED are in the record too --");
    say("  that is what makes this auditable rather than merely obstructive.\n");
    break;
  }

  say(`  call ${String(i).padStart(2)}  ${result.outcome}`);
}
