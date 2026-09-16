/**
 * The engine.
 *
 * Pure: no I/O, no clock, no randomness, no mutation of its inputs. The same
 * request, policy and ledger always produce a byte-identical decision, which
 * is what lets a decision be journalled once and re-derived forever
 * (Constitution Art. I §4, Art. II §9).
 *
 * Three properties are load-bearing, and each exists because the alternative
 * fails in a way that costs money:
 *
 * - **Deny by default.** No policy, no matching rule, an unrecognised account:
 *   all deny. An authorization system whose failure mode is "allow" is not an
 *   authorization system.
 * - **Every rule is evaluated, not just the first to fail.** Art. II §10
 *   requires that a decision be explainable; a decision that names one
 *   tripped limit while hiding the four it passed cannot be audited, and
 *   cannot tell an operator how close the others came.
 * - **Evaluation is idempotent.** The request under evaluation is excluded
 *   from its own ledger, so re-running a decision for an in-flight request
 *   returns the same answer instead of counting the request against itself.
 */
import type { SpendRequest } from "./model.js";
import { distinctApprovers, requestIntent, requesterKey } from "./model.js";
import type { Rule, RuleKind, SpendPolicy } from "./policy.js";
import {
  minuteOfDayUtc,
  policyDigest,
  scopeCovers,
  withinDailyWindow,
} from "./policy.js";
import type { LedgerEntry, WindowQuery } from "./ledger.js";
import { countWithin, spentWithin } from "./ledger.js";
import { unitFor } from "./units.js";
import { satisfying } from "./attestation.js";

export type Verdict = "ALLOW" | "DENY" | "REQUIRES_APPROVAL" | "NOT_APPLICABLE";

/** Why a request was refused, independent of which rule refused it. */
export type DenialReason =
  | "NO_POLICY"
  | "WRONG_ACCOUNT"
  | "INVALID_AMOUNT"
  | "REQUESTER_NOT_PERMITTED"
  | "DESTINATION_NOT_ALLOWED"
  | "DESTINATION_DENIED"
  | "ASSET_NOT_ALLOWED"
  | "TRANSACTION_TOO_LARGE"
  | "BUDGET_EXHAUSTED"
  | "TOO_MANY_TRANSACTIONS"
  | "OUTSIDE_TIME_WINDOW"
  | "ATTESTATION_MISSING"
  /** The policy declares its denominations and this asset is not one of them. */
  | "UNIT_NOT_DECLARED"
  /** The amount is beyond anything sane for this asset — usually a scale mistake. */
  | "AMOUNT_OUT_OF_RANGE";

/**
 * One rule's reading of one request.
 *
 * `observed` and `limit` are decimal strings rather than numbers: they may hold
 * `bigint` amounts, and a record that has to survive JSON has no business
 * carrying a value JSON cannot represent.
 */
export interface RuleEvaluation {
  readonly ruleId: string;
  readonly kind: RuleKind;
  readonly verdict: Verdict;
  /** What this rule measured, or `null` when it measures nothing. */
  readonly observed: string | null;
  /** What it was measured against. */
  readonly limit: string | null;
  readonly detail: string;
}

interface DecisionBase {
  readonly requestId: string;
  readonly account: string;
  readonly policyVersion: number;
  readonly policyDigest: string;
  readonly evaluatedAt: number;
  readonly evaluations: readonly RuleEvaluation[];
}

export type Decision =
  | (DecisionBase & { readonly outcome: "ALLOW" })
  | (DecisionBase & {
      readonly outcome: "DENY";
      readonly reason: DenialReason;
      readonly ruleId: string | null;
      readonly detail: string;
    })
  | (DecisionBase & {
      readonly outcome: "REQUIRES_APPROVAL";
      readonly ruleId: string;
      readonly approvalsRequired: number;
      readonly approvalsHeld: number;
      readonly detail: string;
    });

/** A rule's result before precedence is applied. */
interface RuleOutcome {
  readonly evaluation: RuleEvaluation;
  readonly reason: DenialReason | null;
  readonly approvalsRequired: number;
  readonly approvalsHeld: number;
}

const skip = (rule: Rule, detail: string): RuleOutcome => ({
  evaluation: {
    ruleId: rule.id,
    kind: rule.kind,
    verdict: "NOT_APPLICABLE",
    observed: null,
    limit: null,
    detail,
  },
  reason: null,
  approvalsRequired: 0,
  approvalsHeld: 0,
});

const settle = (
  rule: Rule,
  verdict: Exclude<Verdict, "NOT_APPLICABLE">,
  observed: string | null,
  limit: string | null,
  detail: string,
  reason: DenialReason | null = null,
  approvalsRequired = 0,
  approvalsHeld = 0,
): RuleOutcome => ({
  evaluation: { ruleId: rule.id, kind: rule.kind, verdict, observed, limit, detail },
  reason,
  approvalsRequired,
  approvalsHeld,
});

function evaluateRule(
  rule: Rule,
  request: SpendRequest,
  ledger: readonly LedgerEntry[],
): RuleOutcome {
  const key = requesterKey(request.requester);
  if (!scopeCovers(rule.scope, key)) return skip(rule, `${key} is out of scope`);

  const baseQuery = (windowMs: number): WindowQuery => ({
    from: request.requestedAt - windowMs,
    to: request.requestedAt,
    requesters: rule.scope.kind === "ANY" ? null : rule.scope.requesters,
    excludeRequestId: request.requestId,
  });

  switch (rule.kind) {
    case "REQUESTER_ALLOWLIST":
      return rule.requesters.includes(key)
        ? settle(rule, "ALLOW", key, null, `${key} is permitted`)
        : settle(rule, "DENY", key, null, `${key} is not on the requester allowlist`, "REQUESTER_NOT_PERMITTED");

    case "DESTINATION_ALLOWLIST":
      return rule.destinations.includes(request.destination)
        ? settle(rule, "ALLOW", request.destination, null, "destination is allowlisted")
        : settle(
            rule,
            "DENY",
            request.destination,
            null,
            `destination is not on the allowlist (${rule.destinations.length} entries)`,
            "DESTINATION_NOT_ALLOWED",
          );

    case "DESTINATION_DENYLIST":
      return rule.destinations.includes(request.destination)
        ? settle(rule, "DENY", request.destination, null, "destination is denylisted", "DESTINATION_DENIED")
        : settle(rule, "ALLOW", request.destination, null, "destination is not denylisted");

    case "ASSET_ALLOWLIST":
      return rule.assets.includes(request.asset)
        ? settle(rule, "ALLOW", request.asset, null, "asset is allowlisted")
        : settle(rule, "DENY", request.asset, null, `${request.asset} may not move`, "ASSET_NOT_ALLOWED");

    case "PER_TRANSACTION_LIMIT": {
      if (rule.asset !== request.asset) return skip(rule, `limit is for ${rule.asset}`);
      const observed = request.amount.toString(10);
      const limit = rule.maxAmount.toString(10);
      return request.amount <= rule.maxAmount
        ? settle(rule, "ALLOW", observed, limit, "within the per-transaction limit")
        : settle(rule, "DENY", observed, limit, "exceeds the per-transaction limit", "TRANSACTION_TOO_LARGE");
    }

    case "WINDOW_BUDGET": {
      if (rule.asset !== request.asset) return skip(rule, `budget is for ${rule.asset}`);
      const already = spentWithin(ledger, rule.asset, baseQuery(rule.windowMs));
      const projected = already + request.amount;
      const observed = projected.toString(10);
      const limit = rule.maxTotal.toString(10);
      return projected <= rule.maxTotal
        ? settle(rule, "ALLOW", observed, limit, `${already} already committed in the window`)
        : settle(
            rule,
            "DENY",
            observed,
            limit,
            `${already} already committed in the window; this would reach ${projected}`,
            "BUDGET_EXHAUSTED",
          );
    }

    case "WINDOW_VELOCITY": {
      const already = countWithin(ledger, baseQuery(rule.windowMs));
      const projected = already + 1;
      const observed = String(projected);
      const limit = String(rule.maxCount);
      return projected <= rule.maxCount
        ? settle(rule, "ALLOW", observed, limit, `${already} already in the window`)
        : settle(
            rule,
            "DENY",
            observed,
            limit,
            `${already} already in the window; this would be number ${projected}`,
            "TOO_MANY_TRANSACTIONS",
          );
    }

    case "APPROVAL_THRESHOLD": {
      if (rule.asset !== request.asset) return skip(rule, `threshold is for ${rule.asset}`);
      if (request.amount < rule.atOrAboveAmount) {
        return settle(
          rule,
          "ALLOW",
          request.amount.toString(10),
          rule.atOrAboveAmount.toString(10),
          "below the approval threshold",
        );
      }
      const held = distinctApprovers(request).length;
      return held >= rule.approvalsRequired
        ? settle(
            rule,
            "ALLOW",
            String(held),
            String(rule.approvalsRequired),
            "approval threshold satisfied",
            null,
            rule.approvalsRequired,
            held,
          )
        : settle(
            rule,
            "REQUIRES_APPROVAL",
            String(held),
            String(rule.approvalsRequired),
            `needs ${rule.approvalsRequired} distinct approvers, holds ${held}`,
            null,
            rule.approvalsRequired,
            held,
          );
    }

    case "ATTESTATION_REQUIRED": {
      const matches = satisfying(
        request.attestations,
        rule.claimId,
        rule.attesters,
        request.requestedAt,
        rule.maxAgeMs,
      );
      const who = rule.attesters.length === 0 ? "any attester" : rule.attesters.join(", ");
      const first = matches[0];
      return first !== undefined
        ? settle(
            rule,
            "ALLOW",
            rule.claimId,
            who,
            `attested by ${first.attester} (evidence ${first.evidenceDigest.slice(0, 12)})`,
          )
        : settle(
            rule,
            "DENY",
            rule.claimId,
            who,
            `no current attestation for ${rule.claimId} from ${who}`,
            "ATTESTATION_MISSING",
          );
    }

    case "TIME_WINDOW": {
      const minute = minuteOfDayUtc(request.requestedAt);
      const render = (m: number) =>
        `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
      const window = `${render(rule.fromMinuteUtc)}-${render(rule.toMinuteUtc)} UTC`;
      return withinDailyWindow(minute, rule.fromMinuteUtc, rule.toMinuteUtc)
        ? settle(rule, "ALLOW", render(minute), window, "inside the permitted window")
        : settle(rule, "DENY", render(minute), window, "outside the permitted window", "OUTSIDE_TIME_WINDOW");
    }
  }
}

/**
 * Decides whether a request may proceed.
 *
 * Precedence is DENY, then REQUIRES_APPROVAL, then ALLOW, and within a tier the
 * first rule in policy order wins — so the reason recorded is the most serious
 * one that applies, and rule order is a deliberate authoring decision rather
 * than an accident of iteration.
 */
export function evaluate(
  request: SpendRequest,
  policy: SpendPolicy,
  ledger: readonly LedgerEntry[] = [],
): Decision {
  const digest = policyDigest(policy);
  const base: DecisionBase = {
    requestId: request.requestId,
    account: policy.account,
    policyVersion: policy.version,
    policyDigest: digest,
    evaluatedAt: request.requestedAt,
    evaluations: [],
  };

  const refuse = (reason: DenialReason, detail: string): Decision => ({
    ...base,
    outcome: "DENY",
    reason,
    ruleId: null,
    detail,
  });

  // Structural checks run before any rule. A request that is malformed, or
  // aimed at another account, must never be measured against limits that were
  // written for a different subject.
  if (request.account !== policy.account) {
    return refuse("WRONG_ACCOUNT", `request targets ${request.account}, policy governs ${policy.account}`);
  }
  if (request.amount <= 0n) {
    return refuse("INVALID_AMOUNT", `amount must be positive, got ${request.amount.toString(10)}`);
  }
  if (policy.rules.length === 0) {
    return refuse("NO_POLICY", "policy has no rules; nothing may move");
  }

  // Denomination is checked before any rule, because a rule that judges an
  // amount in the wrong unit gives a confident answer to the wrong question.
  // A policy declaring no units skips this entirely (see `units.ts`).
  if (policy.units !== undefined) {
    const unit = unitFor(policy.units, request.asset);
    if (unit === undefined) {
      return refuse(
        "UNIT_NOT_DECLARED",
        `${request.asset} is not a denomination this policy declares`,
      );
    }
    if (request.amount > unit.maxAmount) {
      return refuse(
        "AMOUNT_OUT_OF_RANGE",
        `${request.amount.toString(10)} exceeds the largest sane ${unit.symbol} amount ` +
          `(${unit.maxAmount.toString(10)}); check the scale`,
      );
    }
  }

  // A ledger entry for another account is another account's history.
  const own = ledger.filter((entry) => entry.account === policy.account);
  const outcomes = policy.rules.map((rule) => evaluateRule(rule, request, own));
  const evaluations = outcomes.map((o) => o.evaluation);

  const denied = outcomes.find((o) => o.evaluation.verdict === "DENY");
  if (denied !== undefined && denied.reason !== null) {
    return {
      ...base,
      evaluations,
      outcome: "DENY",
      reason: denied.reason,
      ruleId: denied.evaluation.ruleId,
      detail: denied.evaluation.detail,
    };
  }

  const pending = outcomes.find((o) => o.evaluation.verdict === "REQUIRES_APPROVAL");
  if (pending !== undefined) {
    return {
      ...base,
      evaluations,
      outcome: "REQUIRES_APPROVAL",
      ruleId: pending.evaluation.ruleId,
      approvalsRequired: pending.approvalsRequired,
      approvalsHeld: pending.approvalsHeld,
      detail: pending.evaluation.detail,
    };
  }

  // Every rule was either satisfied or out of scope. Note that "every rule out
  // of scope" still allows: the policy author chose the scopes, and a policy
  // that names no rule for this requester has already been caught by the
  // empty-policy check or should carry a REQUESTER_ALLOWLIST.
  return { ...base, evaluations, outcome: "ALLOW" };
}

/**
 * The ledger entry a decision authorizes. Only ever built from an ALLOW.
 *
 * `expiresAt` is supplied rather than computed: a deadline is the shell's
 * business, and the engine reads no clock.
 */
export function authorizedEntry(
  request: SpendRequest,
  decision: Decision,
  expiresAt: number | null = null,
): LedgerEntry {
  if (decision.outcome !== "ALLOW") {
    throw new Error(`cannot authorize a ${decision.outcome} decision for ${request.requestId}`);
  }
  return {
    requestId: request.requestId,
    account: request.account,
    asset: request.asset,
    amount: request.amount,
    destination: request.destination,
    requester: request.requester,
    at: request.requestedAt,
    state: "PENDING",
    intent: requestIntent(request),
    decision,
    expiresAt,
  };
}

