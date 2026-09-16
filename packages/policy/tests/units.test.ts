/**
 * Denominations.
 *
 * The showpiece is the typo test. An opaque asset identifier has no wrong
 * values, so `"USDC "` with a trailing space is simply a different asset —
 * every rule for the correct spelling ignores it, and the spend accrues in an
 * envelope nobody declared. The test demonstrates that happening, then
 * demonstrates declaring units turning it into a refusal.
 */
import { ok, strictEqual, throws } from "node:assert/strict";
import { describe, it } from "node:test";

import type { AssetUnit, SpendPolicy } from "../src/index.js";
import {
  ANY_REQUESTER,

  evaluate,
  formatAmount,
  policyDigest,
  validatePolicy,
} from "../src/index.js";
import { ACCOUNT, T0, USDC, anywhere, entry, policy, request, usdc } from "./helpers.js";

const usdcUnit: AssetUnit = {
  asset: USDC,
  decimals: 6,
  symbol: "USDC",
  maxAmount: usdc(1_000_000),
};

const budget = (units?: readonly AssetUnit[]): SpendPolicy => ({
  account: ACCOUNT,
  version: 1,
  rules: [
    {
      id: "daily",
      kind: "WINDOW_BUDGET",
      scope: anywhere,
      asset: USDC,
      windowMs: 86_400_000,
      maxTotal: usdc(100),
    },
  ],
  ...(units === undefined ? {} : { units }),
});

describe("the typo that makes a second budget", () => {
  it("without declared units, a misspelt asset escapes the budget entirely", () => {
    const spent = [entry({ amount: usdc(100) })];
    // The budget is full, so the correct spelling is refused.
    strictEqual(evaluate(request({ amount: usdc(50) }), budget(), spent).outcome, "DENY");

    // One trailing space, and the same spend sails through. The rule simply
    // does not apply to it, and nothing objects.
    const misspelt = request({ asset: `${USDC} `, amount: usdc(50) });
    strictEqual(evaluate(misspelt, budget(), spent).outcome, "ALLOW");
  });

  it("declaring units turns that into a refusal", () => {
    const spent = [entry({ amount: usdc(100) })];
    const misspelt = request({ asset: `${USDC} `, amount: usdc(50) });

    const decision = evaluate(misspelt, budget([usdcUnit]), spent);
    strictEqual(decision.outcome, "DENY");
    if (decision.outcome !== "DENY") return;
    strictEqual(decision.reason, "UNIT_NOT_DECLARED");
  });
});

describe("scale mistakes", () => {
  it("refuses an amount beyond anything sane for the asset", () => {
    // Six decimals confused for eighteen: the number is enormous rather than
    // merely wrong, which is exactly what a ceiling on nonsense catches.
    const wrongScale = request({ amount: 5n * 10n ** 18n });
    const decision = evaluate(wrongScale, budget([usdcUnit]), []);
    strictEqual(decision.outcome, "DENY");
    if (decision.outcome !== "DENY") return;
    strictEqual(decision.reason, "AMOUNT_OUT_OF_RANGE");
    ok(decision.detail.includes("check the scale"));
  });

  it("accepts exactly the declared ceiling", () => {
    const atCeiling = request({ amount: usdc(1_000_000) });
    // The rules still apply; it is the unit check that must not object.
    const decision = evaluate(atCeiling, budget([usdcUnit]), []);
    strictEqual(decision.outcome, "DENY");
    if (decision.outcome !== "DENY") return;
    strictEqual(decision.reason, "BUDGET_EXHAUSTED");
  });

  it("checks denomination before any rule", () => {
    // A rule judging an amount in the wrong unit gives a confident answer to
    // the wrong question, so the unit check has to come first.
    const both = request({ asset: "UNKNOWN", amount: usdc(10_000_000) });
    const decision = evaluate(both, budget([usdcUnit]), []);
    strictEqual(decision.outcome, "DENY");
    if (decision.outcome !== "DENY") return;
    strictEqual(decision.reason, "UNIT_NOT_DECLARED");
  });
});

describe("a policy that declares nothing keeps its old behaviour", () => {
  it("allows any asset", () => {
    strictEqual(evaluate(request({ asset: "anything-at-all" }), policy([
      { id: "rate", kind: "WINDOW_VELOCITY", scope: anywhere, windowMs: 3_600_000, maxCount: 5 },
    ]), []).outcome, "ALLOW");
  });

  it("hashes exactly as it did before units existed", () => {
    const withoutField = { account: ACCOUNT, version: 1, rules: budget().rules };
    strictEqual(policyDigest(budget()), policyDigest(withoutField));
  });

  it("but declaring units changes the digest, so a receipt proves them", () => {
    ok(policyDigest(budget()) !== policyDigest(budget([usdcUnit])));
    const finer = { ...usdcUnit, decimals: 18 };
    ok(policyDigest(budget([usdcUnit])) !== policyDigest(budget([finer])));
  });
});

describe("validation catches declarations that cannot work", () => {
  it("accepts a coherent policy", () => {
    validatePolicy(budget([usdcUnit]));
  });

  it("rejects a rule naming an asset the policy does not declare", () => {
    // Fails open otherwise: the rule never applies and the spend is simply not
    // covered, which is the silent hole this whole feature closes.
    const other: SpendPolicy = {
      ...budget([usdcUnit]),
      rules: [
        ...budget().rules,
        { id: "eth", kind: "PER_TRANSACTION_LIMIT", scope: ANY_REQUESTER, asset: "ETH", maxAmount: 1n },
      ],
    };
    throws(() => validatePolicy(other), /names undeclared asset "ETH"/);
  });

  it("rejects an allowlist naming an undeclared asset", () => {
    const listed: SpendPolicy = {
      ...budget([usdcUnit]),
      rules: [
        ...budget().rules,
        { id: "assets", kind: "ASSET_ALLOWLIST", scope: ANY_REQUESTER, assets: [USDC, "DAI"] },
      ],
    };
    throws(() => validatePolicy(listed), /DAI/);
  });

  it("rejects duplicate, unnamed and unscaled declarations", () => {
    const bad: readonly (readonly [AssetUnit[], RegExp])[] = [
      [[usdcUnit, usdcUnit], /declared twice/],
      [[{ ...usdcUnit, asset: "" }], /declares no asset/],
      [[{ ...usdcUnit, symbol: "" }], /has no symbol/],
      [[{ ...usdcUnit, decimals: -1 }], /decimals must be/],
      [[{ ...usdcUnit, decimals: 1.5 }], /decimals must be/],
      [[{ ...usdcUnit, decimals: 37 }], /decimals must be/],
      [[{ ...usdcUnit, maxAmount: 0n }], /maxAmount must be positive/],
    ];
    for (const [units, message] of bad) {
      throws(() => validatePolicy(budget(units)), message);
    }
  });

  it("a policy declaring no units places no demands on its rules", () => {
    validatePolicy(budget());
  });
});

describe("formatting, for people only", () => {
  it("renders base units at the declared scale", () => {
    strictEqual(formatAmount(usdc(5), usdcUnit), "5.000000 USDC");
    strictEqual(formatAmount(5_000_005n, usdcUnit), "5.000005 USDC");
    strictEqual(formatAmount(0n, usdcUnit), "0.000000 USDC");
  });

  it("pads the fraction, because trailing zeros carry the scale", () => {
    // "5.5" and "5.000005" differ only in zeros a naive conversion drops.
    strictEqual(formatAmount(5_500_000n, usdcUnit), "5.500000 USDC");
  });

  it("omits the point entirely for a counted asset", () => {
    const tokens: AssetUnit = {
      asset: "anthropic:tokens",
      decimals: 0,
      symbol: "tokens",
      maxAmount: 10n ** 12n,
    };
    strictEqual(formatAmount(4_231n, tokens), "4231 tokens");
  });

  it("handles a very large scale without losing a digit", () => {
    const wei: AssetUnit = { asset: "ETH", decimals: 18, symbol: "ETH", maxAmount: 10n ** 30n };
    strictEqual(formatAmount(10n ** 18n + 1n, wei), "1.000000000000000001 ETH");
  });
});

describe("unchanged behaviour", () => {
  it("time still comes from the request, not a clock", () => {
    strictEqual(evaluate(request({ requestedAt: T0 }), budget([usdcUnit]), []).evaluatedAt, T0);
  });
});
