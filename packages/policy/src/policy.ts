/**
 * What a policy is.
 *
 * A policy is **data**, not code: a versioned list of rules that can be
 * serialized, hashed, journalled and replayed. Rules are a discriminated union
 * rather than an interface with implementations, so adding a rule kind is an
 * addition to a type — the compiler then names every place that must handle it
 * (evolve through addition, never mutation).
 *
 * Every rule carries a scope. A rule with no scope applies to everyone, which
 * is the only sane default for a limit: forgetting to scope a rule must mean
 * "applies to all", never "applies to none".
 */
import { canonicalJson } from "@spendcap/journal";
import { createHash } from "node:crypto";
import type { Amount, AssetId } from "./model.js";
import type { AssetUnit } from "./units.js";
import { MAX_DECIMALS } from "./units.js";

/** Which requesters a rule constrains. */
export type RuleScope =
  | { readonly kind: "ANY" }
  /** Requester keys, as produced by {@link requesterKey}. */
  | { readonly kind: "REQUESTERS"; readonly requesters: readonly string[] };

export const ANY_REQUESTER: RuleScope = { kind: "ANY" };

interface RuleBase {
  /** Unique within a policy. Appears in every decision, so keep it readable. */
  readonly id: string;
  readonly scope: RuleScope;
}

/**
 * The rule vocabulary.
 *
 * Deliberately small. Each rule answers one question, and a policy composes
 * them; a single rule that took eight optional fields would be one rule nobody
 * could reason about.
 */
export type Rule =
  /** Only these requesters may spend at all. */
  | (RuleBase & { readonly kind: "REQUESTER_ALLOWLIST"; readonly requesters: readonly string[] })
  /** Destination must appear here. An empty list freezes the account. */
  | (RuleBase & { readonly kind: "DESTINATION_ALLOWLIST"; readonly destinations: readonly string[] })
  /** Destination must not appear here. */
  | (RuleBase & { readonly kind: "DESTINATION_DENYLIST"; readonly destinations: readonly string[] })
  /** Only these assets may move. */
  | (RuleBase & { readonly kind: "ASSET_ALLOWLIST"; readonly assets: readonly AssetId[] })
  /** A single transaction may not exceed `maxAmount`. Equal is allowed. */
  | (RuleBase & {
      readonly kind: "PER_TRANSACTION_LIMIT";
      readonly asset: AssetId;
      readonly maxAmount: Amount;
    })
  /** Cumulative spend in a rolling window may not exceed `maxTotal`. */
  | (RuleBase & {
      readonly kind: "WINDOW_BUDGET";
      readonly asset: AssetId;
      readonly windowMs: number;
      readonly maxTotal: Amount;
    })
  /** Transaction count in a rolling window may not exceed `maxCount`. */
  | (RuleBase & {
      readonly kind: "WINDOW_VELOCITY";
      readonly windowMs: number;
      readonly maxCount: number;
    })
  /**
   * At or above `atOrAboveAmount`, the request needs `approvalsRequired`
   * distinct approvers.
   *
   * "At or above", not "above": a threshold you can sit precisely on without
   * consequence is not a threshold.
   */
  | (RuleBase & {
      readonly kind: "APPROVAL_THRESHOLD";
      readonly asset: AssetId;
      readonly atOrAboveAmount: Amount;
      readonly approvalsRequired: number;
    })
  /**
   * A named claim must have been attested before money moves.
   *
   * This is the rule that turns a payment engine into a settlement engine:
   * release on *dispatched*, on *customs cleared*, on *received*, on
   * *counterparty verified* — each asserted by a named party, each carrying a
   * digest of the document that backs it.
   *
   * `attesters` empty means any attester the shell accepted. `maxAgeMs` null
   * means the claim does not go stale; a quality certificate from two years
   * ago should not release this shipment's payment.
   */
  | (RuleBase & {
      readonly kind: "ATTESTATION_REQUIRED";
      readonly claimId: string;
      readonly attesters: readonly string[];
      readonly maxAgeMs: number | null;
    })
  /**
   * Spending is allowed only inside a daily UTC window.
   *
   * Minutes of the day, `[from, to)`. `from > to` wraps midnight, so
   * `1320 -> 360` means 22:00 to 06:00. UTC only — a local timezone is a
   * moving target and would make replay depend on where it ran.
   */
  | (RuleBase & {
      readonly kind: "TIME_WINDOW";
      readonly fromMinuteUtc: number;
      readonly toMinuteUtc: number;
    });

export type RuleKind = Rule["kind"];

export interface SpendPolicy {
  readonly account: string;
  /** Bumped on every change. Recorded in every decision. */
  readonly version: number;
  readonly rules: readonly Rule[];
  /**
   * The denominations this policy governs.
   *
   * Omitted means no unit checking, which is the behaviour every policy had
   * before units existed. Declaring them turns two silent failures into
   * refusals — a scale disagreement and a typo'd asset that would otherwise
   * accrue in a parallel envelope. See `units.ts`.
   *
   * They live on the policy rather than beside it so the policy digest covers
   * them: a receipt then proves which denominations were in force, not merely
   * which limits.
   */
  readonly units?: readonly AssetUnit[];
}

export class PolicyConfigError extends Error {
  readonly ruleId: string | null;
  constructor(message: string, ruleId: string | null = null) {
    super(ruleId === null ? message : `rule ${ruleId}: ${message}`);
    this.name = "PolicyConfigError";
    this.ruleId = ruleId;
  }
}

const MINUTES_PER_DAY = 1440;

/**
 * Rejects a policy that cannot mean what it says.
 *
 * This runs when a policy is loaded, not when it is evaluated: a malformed
 * limit must fail loudly at configuration time rather than silently permit
 * something at 3am. Note that an *empty* allowlist is valid — it is how you
 * freeze an account — but a negative limit is not, because there is no
 * intention it could express.
 */
export function validatePolicy(policy: SpendPolicy): void {
  if (policy.account.length === 0) throw new PolicyConfigError("policy has no account");
  if (!Number.isInteger(policy.version) || policy.version < 1) {
    throw new PolicyConfigError(`version must be a positive integer, got ${policy.version}`);
  }

  const declared = validateUnits(policy);

  const seen = new Set<string>();
  for (const rule of policy.rules) {
    if (rule.id.length === 0) throw new PolicyConfigError("rule has no id");
    if (seen.has(rule.id)) throw new PolicyConfigError("duplicate rule id", rule.id);
    seen.add(rule.id);

    if (rule.scope.kind === "REQUESTERS" && rule.scope.requesters.length === 0) {
      // A scope naming nobody makes the rule unreachable. That is always a
      // mistake: the author meant ANY, or meant to name someone.
      throw new PolicyConfigError("scope names no requesters; use ANY_REQUESTER", rule.id);
    }

    // A rule naming an asset the policy does not declare can never do its
    // job, and fails open: the spend simply is not covered by it. That is
    // exactly the silent hole declaring units is meant to close, so it is
    // caught at load time rather than never.
    if (declared !== null) {
      for (const asset of assetsOf(rule)) {
        if (!declared.has(asset)) {
          throw new PolicyConfigError(`names undeclared asset ${JSON.stringify(asset)}`, rule.id);
        }
      }
    }

    switch (rule.kind) {
      case "PER_TRANSACTION_LIMIT":
        if (rule.maxAmount < 0n) throw new PolicyConfigError("maxAmount is negative", rule.id);
        break;
      case "WINDOW_BUDGET":
        if (rule.maxTotal < 0n) throw new PolicyConfigError("maxTotal is negative", rule.id);
        if (!Number.isFinite(rule.windowMs) || rule.windowMs <= 0) {
          throw new PolicyConfigError("windowMs must be positive", rule.id);
        }
        break;
      case "WINDOW_VELOCITY":
        if (!Number.isInteger(rule.maxCount) || rule.maxCount < 0) {
          throw new PolicyConfigError("maxCount must be a non-negative integer", rule.id);
        }
        if (!Number.isFinite(rule.windowMs) || rule.windowMs <= 0) {
          throw new PolicyConfigError("windowMs must be positive", rule.id);
        }
        break;
      case "APPROVAL_THRESHOLD":
        if (rule.atOrAboveAmount < 0n) {
          throw new PolicyConfigError("atOrAboveAmount is negative", rule.id);
        }
        if (!Number.isInteger(rule.approvalsRequired) || rule.approvalsRequired < 1) {
          throw new PolicyConfigError("approvalsRequired must be at least 1", rule.id);
        }
        break;
      case "TIME_WINDOW":
        for (const [name, minute] of [
          ["fromMinuteUtc", rule.fromMinuteUtc],
          ["toMinuteUtc", rule.toMinuteUtc],
        ] as const) {
          if (!Number.isInteger(minute) || minute < 0 || minute >= MINUTES_PER_DAY) {
            throw new PolicyConfigError(`${name} must be in [0, ${MINUTES_PER_DAY})`, rule.id);
          }
        }
        if (rule.fromMinuteUtc === rule.toMinuteUtc) {
          throw new PolicyConfigError("window is empty; from equals to", rule.id);
        }
        break;
      case "ATTESTATION_REQUIRED":
        if (rule.claimId.length === 0) throw new PolicyConfigError("claimId is empty", rule.id);
        if (rule.maxAgeMs !== null && (!Number.isFinite(rule.maxAgeMs) || rule.maxAgeMs <= 0)) {
          throw new PolicyConfigError("maxAgeMs must be positive or null", rule.id);
        }
        break;
      case "REQUESTER_ALLOWLIST":
      case "DESTINATION_ALLOWLIST":
      case "DESTINATION_DENYLIST":
      case "ASSET_ALLOWLIST":
        break;
    }
  }
}

/** Assets a rule constrains. Rules that constrain no particular asset yield none. */
function assetsOf(rule: Rule): readonly AssetId[] {
  switch (rule.kind) {
    case "ASSET_ALLOWLIST":
      return rule.assets;
    case "PER_TRANSACTION_LIMIT":
    case "WINDOW_BUDGET":
    case "APPROVAL_THRESHOLD":
      return [rule.asset];
    default:
      return [];
  }
}

/**
 * Checks the declarations themselves, returning the declared assets.
 *
 * `null` when a policy declares no units at all — not an empty set, which
 * would mean "declares that nothing is allowed" and would reject every rule.
 */
function validateUnits(policy: SpendPolicy): Set<AssetId> | null {
  if (policy.units === undefined) return null;

  const declared = new Set<AssetId>();
  for (const unit of policy.units) {
    if (unit.asset.length === 0) throw new PolicyConfigError("a unit declares no asset");
    if (declared.has(unit.asset)) {
      throw new PolicyConfigError(`asset ${JSON.stringify(unit.asset)} is declared twice`);
    }
    if (unit.symbol.length === 0) {
      throw new PolicyConfigError(`asset ${JSON.stringify(unit.asset)} has no symbol`);
    }
    if (!Number.isInteger(unit.decimals) || unit.decimals < 0 || unit.decimals > MAX_DECIMALS) {
      throw new PolicyConfigError(
        `asset ${JSON.stringify(unit.asset)}: decimals must be an integer in [0, ${MAX_DECIMALS}]`,
      );
    }
    if (unit.maxAmount <= 0n) {
      throw new PolicyConfigError(`asset ${JSON.stringify(unit.asset)}: maxAmount must be positive`);
    }
    declared.add(unit.asset);
  }
  return declared;
}

/**
 * A policy's content hash.
 *
 * Recorded on every decision so a replay can prove *which* policy text
 * produced it. A decision that names only a version number is unfalsifiable;
 * versions get edited in place, hashes do not.
 *
 * Amounts are rendered as decimal strings because `canonicalJson` refuses
 * `bigint` — which is the correct refusal, since the journal has no
 * unambiguous JSON encoding for one.
 */
export function policyDigest(policy: SpendPolicy): string {
  const serializable = {
    account: policy.account,
    version: policy.version,
    // Included so a receipt proves which denominations were in force. Omitted
    // rather than sent as null when absent, so a policy that declares no units
    // hashes exactly as it did before units existed.
    ...(policy.units === undefined
      ? {}
      : {
          units: policy.units.map((u) => ({
            asset: u.asset,
            decimals: u.decimals,
            symbol: u.symbol,
            maxAmount: u.maxAmount.toString(10),
          })),
        }),
    rules: policy.rules.map((rule) =>
      Object.fromEntries(
        Object.entries(rule).map(([k, v]) => [k, typeof v === "bigint" ? v.toString(10) : v]),
      ),
    ),
  };
  return createHash("sha256").update(canonicalJson(serializable), "utf8").digest("hex");
}

/** Does this rule constrain this requester? */
export function scopeCovers(scope: RuleScope, key: string): boolean {
  return scope.kind === "ANY" || scope.requesters.includes(key);
}

/** UTC minute-of-day for an instant. */
export function minuteOfDayUtc(epochMs: number): number {
  const date = new Date(epochMs);
  return date.getUTCHours() * 60 + date.getUTCMinutes();
}

/** Is `minute` inside `[from, to)`, with wrap-around when `from > to`? */
export function withinDailyWindow(minute: number, from: number, to: number): boolean {
  return from < to ? minute >= from && minute < to : minute >= from || minute < to;
}
