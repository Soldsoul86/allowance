/**
 * Policy validation and content hashing.
 *
 * Validation runs at load time, so these tests cover the malformed limits that
 * must fail loudly at configuration rather than silently permit something
 * later. The digest tests guard replay: a decision names the policy that
 * produced it by hash, so the hash must be stable across key ordering and must
 * move whenever a limit does.
 */
import { strictEqual, throws } from "node:assert/strict";
import { describe, it } from "node:test";

import type { Rule } from "../src/index.js";
import { PolicyConfigError, policyDigest, validatePolicy, withinDailyWindow } from "../src/index.js";
import { USDC, anywhere, policy, usdc } from "./helpers.js";

const cap: Rule = {
  id: "cap",
  kind: "PER_TRANSACTION_LIMIT",
  scope: anywhere,
  asset: USDC,
  maxAmount: usdc(100),
};

describe("validatePolicy", () => {
  it("accepts a well-formed policy", () => {
    validatePolicy(policy([cap]));
  });

  it("rejects duplicate rule ids", () => {
    throws(() => validatePolicy(policy([cap, { ...cap }])), PolicyConfigError);
  });

  it("rejects a scope that names nobody", () => {
    throws(
      () => validatePolicy(policy([{ ...cap, scope: { kind: "REQUESTERS", requesters: [] } }])),
      /names no requesters/,
    );
  });

  it("rejects a negative limit", () => {
    throws(() => validatePolicy(policy([{ ...cap, maxAmount: -1n }])), /negative/);
  });

  it("rejects a non-positive window", () => {
    throws(
      () =>
        validatePolicy(
          policy([
            { id: "b", kind: "WINDOW_BUDGET", scope: anywhere, asset: USDC, windowMs: 0, maxTotal: 1n },
          ]),
        ),
      /windowMs must be positive/,
    );
  });

  it("rejects an approval rule that requires zero approvers", () => {
    throws(
      () =>
        validatePolicy(
          policy([
            {
              id: "a",
              kind: "APPROVAL_THRESHOLD",
              scope: anywhere,
              asset: USDC,
              atOrAboveAmount: 1n,
              approvalsRequired: 0,
            },
          ]),
        ),
      /at least 1/,
    );
  });

  it("rejects a minute outside the day", () => {
    throws(
      () =>
        validatePolicy(
          policy([{ id: "t", kind: "TIME_WINDOW", scope: anywhere, fromMinuteUtc: 0, toMinuteUtc: 1440 }]),
        ),
      /must be in \[0, 1440\)/,
    );
  });

  it("rejects an empty time window", () => {
    throws(
      () =>
        validatePolicy(
          policy([{ id: "t", kind: "TIME_WINDOW", scope: anywhere, fromMinuteUtc: 540, toMinuteUtc: 540 }]),
        ),
      /window is empty/,
    );
  });

  it("rejects a version that is not a positive integer", () => {
    throws(() => validatePolicy(policy([cap], 0)), /version must be/);
  });
});

describe("policyDigest", () => {
  it("is stable across key ordering", () => {
    const a = policy([cap]);
    const reordered = {
      rules: [{ scope: anywhere, maxAmount: usdc(100), asset: USDC, kind: "PER_TRANSACTION_LIMIT", id: "cap" }],
      version: 1,
      account: a.account,
    } as const;
    strictEqual(policyDigest(a), policyDigest(reordered));
  });

  it("changes when a limit changes", () => {
    const before = policyDigest(policy([cap]));
    const after = policyDigest(policy([{ ...cap, maxAmount: usdc(101) }]));
    strictEqual(before === after, false);
  });

  it("changes when the version changes", () => {
    strictEqual(policyDigest(policy([cap], 1)) === policyDigest(policy([cap], 2)), false);
  });

  it("survives a bigint that JSON could not encode", () => {
    const huge = policyDigest(policy([{ ...cap, maxAmount: 2n ** 70n }]));
    strictEqual(huge.length, 64);
  });
});

describe("withinDailyWindow", () => {
  it("treats the window as half-open", () => {
    strictEqual(withinDailyWindow(540, 540, 1020), true);
    strictEqual(withinDailyWindow(1020, 540, 1020), false);
  });

  it("wraps when from is after to", () => {
    strictEqual(withinDailyWindow(1_380, 1_320, 360), true);
    strictEqual(withinDailyWindow(60, 1_320, 360), true);
    strictEqual(withinDailyWindow(720, 1_320, 360), false);
  });
});
