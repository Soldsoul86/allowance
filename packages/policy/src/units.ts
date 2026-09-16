/**
 * What an amount actually means.
 *
 * Every amount in this package is a `bigint` in "the asset's smallest
 * indivisible unit", and until now nothing recorded what that unit was. The
 * type system cannot help: `5n` meaning five USDC and `5n` meaning five
 * millionths of a USDC are the same value, and the engine would cheerfully add
 * them together.
 *
 * Two failures follow, and both are silent:
 *
 * **A scale disagreement.** One caller sends `5n` for five USDC while the
 * ledger holds `5_000_000n` for the same, and a budget of fifty USDC is never
 * reached because every spend rounds to nothing against it.
 *
 * **A typo makes a second budget.** `"anthropic:tokens "` with a trailing
 * space is a different asset to every rule that reads it. A `WINDOW_BUDGET`
 * for the correct spelling never constrains it, and the spend accrues in a
 * parallel envelope nobody declared. Nothing rejects it, because an opaque
 * identifier has no wrong values.
 *
 * Declaring units is what turns those from invisible into refusals. A policy
 * that declares none keeps the previous behaviour, which is why this is opt-in
 * — but a policy that declares them gets both checks, and the declarations are
 * covered by the policy digest, so a receipt proves which denominations were
 * in force.
 */
import type { Amount, AssetId } from "./model.js";

/** The denomination of one asset. */
export interface AssetUnit {
  readonly asset: AssetId;
  /**
   * Decimal places between the base unit and the whole unit — 6 for USDC, 18
   * for ETH, 0 for something counted rather than divided, like tokens.
   *
   * Used for presentation and for range checking; the engine still computes
   * only in base units, because a decimal point in arithmetic is how money
   * drifts.
   */
  readonly decimals: number;
  /** The whole unit's name, for people. Never used in a comparison. */
  readonly symbol: string;
  /**
   * The largest single amount that makes sense for this asset.
   *
   * A ceiling on nonsense rather than a policy limit: it catches a scale
   * mistake or a fat finger before the amount reaches a rule that would judge
   * it against the wrong denomination.
   */
  readonly maxAmount: Amount;
}

/** The maximum `decimals` worth supporting; beyond this the value is a typo. */
export const MAX_DECIMALS = 36;

export function unitFor(
  units: readonly AssetUnit[] | undefined,
  asset: AssetId,
): AssetUnit | undefined {
  return units?.find((u) => u.asset === asset);
}

/** Renders a base-unit amount for people. Presentation only, never compared. */
export function formatAmount(amount: Amount, unit: AssetUnit): string {
  if (unit.decimals === 0) return `${amount.toString(10)} ${unit.symbol}`;

  const negative = amount < 0n;
  const magnitude = negative ? -amount : amount;
  const scale = 10n ** BigInt(unit.decimals);
  const whole = magnitude / scale;
  // Padded, because "5.5" and "5.000005" differ only in the zeros a naive
  // conversion drops.
  const fraction = (magnitude % scale).toString(10).padStart(unit.decimals, "0");
  return `${negative ? "-" : ""}${whole.toString(10)}.${fraction} ${unit.symbol}`;
}
