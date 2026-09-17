import { validatePolicy, PolicyConfigError } from "@spendcap/policy";
import { makeGuard, draft, spend, title, agent, ANY, DAY } from "./lib.mjs";
title(8, "Declared units catch a scale mistake and a typo'd asset; an undeclared asset in a rule fails at load");
const policy = { account: "acct", version: 1,
  units: [
    { asset: "usdc", decimals: 6, symbol: "USDC", maxAmount: 1_000_000n * 1_000_000n },
    { asset: "anthropic:tokens", decimals: 0, symbol: "tok", maxAmount: 10_000_000n },
  ],
  rules: [
    { id: "usdc-daily", kind: "WINDOW_BUDGET", scope: ANY, asset: "usdc", windowMs: DAY, maxTotal: 50n * 1_000_000n },
  ]};
const { guard } = makeGuard(policy);
await spend(guard, "5 USDC written correctly as 5,000,000 base units", draft("acct", agent("a"), "usdc", 5_000_000n));
await spend(guard, "5,000,000,000,000 base units (someone multiplied twice)", draft("acct", agent("a"), "usdc", 5_000_000_000_000n));
await spend(guard, "asset 'anthropic:tokens ' with a trailing space", draft("acct", agent("a"), "anthropic:tokens ", 10n));
await spend(guard, "asset 'eth:wei', never declared", draft("acct", agent("a"), "eth:wei", 10n));
try {
  validatePolicy({ ...policy, rules: [...policy.rules, { id: "oops", kind: "PER_TRANSACTION_LIMIT", scope: ANY, asset: "eth:wei", maxAmount: 1n }] });
  console.log("  FAIL    policy naming an undeclared asset was accepted");
} catch (e) {
  console.log(`  REJECT  loading a policy with a rule for an undeclared asset -> ${e instanceof PolicyConfigError ? e.message : e}`);
}
