/**
 * Settlement against attested facts.
 *
 * This is the rule that turns the engine from "may this money move" into "has
 * the world done what it was supposed to do before this money moves". The
 * tests are written around a real shape — an India/Europe chemical shipment —
 * because an abstract claim id hides the questions that matter: who may
 * assert, how stale is too stale, and what happens when a document arrives
 * dated in the future.
 */
import { strictEqual, throws } from "node:assert/strict";
import { describe, it } from "node:test";

import type { Attestation, Rule } from "../src/index.js";
import { attestationIsCurrent, evaluate, satisfying, validatePolicy } from "../src/index.js";
import { T0, USDC, anywhere, policy, request, usdc } from "./helpers.js";

const DISPATCH: Rule = {
  id: "dispatched",
  kind: "ATTESTATION_REQUIRED",
  scope: anywhere,
  claimId: "goods.dispatched",
  attesters: ["carrier:maersk"],
  maxAgeMs: null,
};

const INSPECTION: Rule = {
  id: "inspected",
  kind: "ATTESTATION_REQUIRED",
  scope: anywhere,
  claimId: "goods.quality-accepted",
  attesters: ["lab:sgs", "lab:bureau-veritas"],
  maxAgeMs: 30 * 86_400_000,
};

const attest = (overrides: Partial<Attestation> = {}): Attestation => ({
  claimId: "goods.dispatched",
  attester: "carrier:maersk",
  assertedAt: T0 - 3_600_000,
  evidenceDigest: "b1946ac92492d2347c6235b4d2611184".repeat(2),
  ...overrides,
});

describe("attestation-gated settlement", () => {
  it("holds payment until the claim is attested", () => {
    const decision = evaluate(request({ amount: usdc(50_000) }), policy([DISPATCH]));
    strictEqual(decision.outcome, "DENY");
    if (decision.outcome !== "DENY") return;
    strictEqual(decision.reason, "ATTESTATION_MISSING");
  });

  it("releases once the named attester has asserted", () => {
    const decision = evaluate(
      request({ amount: usdc(50_000), attestations: [attest()] }),
      policy([DISPATCH]),
    );
    strictEqual(decision.outcome, "ALLOW");
  });

  it("refuses an attestation from someone else", () => {
    const decision = evaluate(
      request({ attestations: [attest({ attester: "carrier:unknown" })] }),
      policy([DISPATCH]),
    );
    strictEqual(decision.outcome, "DENY");
  });

  it("refuses an attestation for a different claim", () => {
    const decision = evaluate(
      request({ attestations: [attest({ claimId: "goods.received" })] }),
      policy([DISPATCH]),
    );
    strictEqual(decision.outcome, "DENY");
  });

  it("accepts any of several permitted attesters", () => {
    for (const lab of ["lab:sgs", "lab:bureau-veritas"]) {
      const decision = evaluate(
        request({
          attestations: [attest({ claimId: "goods.quality-accepted", attester: lab })],
        }),
        policy([INSPECTION]),
      );
      strictEqual(decision.outcome, "ALLOW", lab);
    }
  });

  it("an empty attester list accepts whoever the shell vouched for", () => {
    const open: Rule = { ...DISPATCH, attesters: [] };
    strictEqual(
      evaluate(request({ attestations: [attest({ attester: "carrier:anyone" })] }), policy([open]))
        .outcome,
      "ALLOW",
    );
  });

  it("refuses a stale attestation", () => {
    const stale = attest({
      claimId: "goods.quality-accepted",
      attester: "lab:sgs",
      assertedAt: T0 - 31 * 86_400_000,
    });
    strictEqual(evaluate(request({ attestations: [stale] }), policy([INSPECTION])).outcome, "DENY");
  });

  it("accepts an attestation exactly at the age limit", () => {
    const edge = attest({
      claimId: "goods.quality-accepted",
      attester: "lab:sgs",
      assertedAt: T0 - 30 * 86_400_000,
    });
    strictEqual(evaluate(request({ attestations: [edge] }), policy([INSPECTION])).outcome, "ALLOW");
  });

  it("refuses an attestation dated after the request", () => {
    // A document from the future is a clock problem or a forgery. Either way
    // it must not release money.
    const future = attest({ assertedAt: T0 + 1 });
    strictEqual(evaluate(request({ attestations: [future] }), policy([DISPATCH])).outcome, "DENY");
  });

  it("requires every condition, not just one", () => {
    const both = policy([DISPATCH, INSPECTION]);
    const onlyDispatch = request({ attestations: [attest()] });
    strictEqual(evaluate(onlyDispatch, both).outcome, "DENY");

    const complete = request({
      attestations: [
        attest(),
        attest({ claimId: "goods.quality-accepted", attester: "lab:sgs" }),
      ],
    });
    strictEqual(evaluate(complete, both).outcome, "ALLOW");
  });

  it("records the evidence digest in the decision, never the document", () => {
    const decision = evaluate(request({ attestations: [attest()] }), policy([DISPATCH]));
    const line = decision.evaluations.find((e) => e.ruleId === "dispatched");
    strictEqual(line?.detail.includes("carrier:maersk"), true);
    strictEqual(line?.detail.includes("b1946ac92492"), true);
  });

  it("composes with a limit: attested but over the cap still denies", () => {
    const guarded = policy([
      DISPATCH,
      { id: "cap", kind: "PER_TRANSACTION_LIMIT", scope: anywhere, asset: USDC, maxAmount: usdc(100) },
    ]);
    const decision = evaluate(
      request({ amount: usdc(50_000), attestations: [attest()] }),
      guarded,
    );
    strictEqual(decision.outcome, "DENY");
    if (decision.outcome !== "DENY") return;
    strictEqual(decision.reason, "TRANSACTION_TOO_LARGE");
  });
});

describe("attestation validation", () => {
  it("rejects an empty claim id", () => {
    throws(() => validatePolicy(policy([{ ...DISPATCH, claimId: "" }])), /claimId is empty/);
  });

  it("rejects a non-positive max age", () => {
    throws(() => validatePolicy(policy([{ ...DISPATCH, maxAgeMs: 0 }])), /maxAgeMs must be positive/);
  });

  it("accepts a null max age", () => {
    validatePolicy(policy([DISPATCH]));
  });
});

describe("attestation helpers", () => {
  it("attestationIsCurrent honours both bounds", () => {
    strictEqual(attestationIsCurrent(attest(), T0, null), true);
    strictEqual(attestationIsCurrent(attest({ assertedAt: T0 + 1 }), T0, null), false);
    strictEqual(attestationIsCurrent(attest({ assertedAt: T0 - 100 }), T0, 100), true);
    strictEqual(attestationIsCurrent(attest({ assertedAt: T0 - 101 }), T0, 100), false);
  });

  it("satisfying returns every usable attestation", () => {
    const found = satisfying(
      [attest(), attest({ attester: "carrier:other" }), attest({ claimId: "other" })],
      "goods.dispatched",
      [],
      T0,
      null,
    );
    strictEqual(found.length, 2);
  });
});
