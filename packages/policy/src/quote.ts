/**
 * The seller's half: a priced, expiring, bound commitment.
 *
 * A quote is usually described as "telling the buyer the price". That
 * undersells it. A quote is the seller **committing to a ceiling**, and that
 * commitment is what fixes a hole the buyer cannot close alone.
 *
 * ## The overage, finally solved
 *
 * The guard authorises against whatever the caller estimated, and cannot
 * interrupt a call already in flight — so an operation budgeted at 5,000 that
 * really consumes 40,000 completes, and the guard can only record the damage
 * (`scripts/agent-budget.mjs`, iteration 9). No amount of cleverness on the
 * buyer's side fixes that, because the buyer does not know the cost until the
 * seller decides it.
 *
 * A quote moves the unknown to the party that actually knows it. The seller
 * states a maximum; the buyer authorises *that maximum*, not a guess; and the
 * seller charging above it is no longer an accident to be absorbed but a
 * broken promise, visible in the receipt. The authorisation becomes exact
 * because the counterparty is bound, not because the estimate got better.
 *
 * ## Three bindings, each closing a specific hole
 *
 * - **Expiry.** A price with no expiry is not a price. Without it an agent
 *   authorises against a quote issued last month.
 * - **Subject.** The quote names *what* is being bought by digest, so a cheap
 *   quote cannot be presented for an expensive delivery. The description
 *   itself never has to travel.
 * - **Audience and request.** A quote may be bound to one buyer and one
 *   request, so it cannot be replayed by, or for, somebody else.
 *
 * ## What is deliberately absent
 *
 * A quote carries an `issuer` string and hashes to a digest — but it is not
 * signed here, so it proves *what* was promised and not *who* promised it.
 * Attribution needs a key, and this package holds no keys on purpose. The same
 * boundary applies to receipts, and it is drawn in the same place for the same
 * reason.
 */
import type { Amount, AssetId, Requester } from "./model.js";
import { digestOf } from "./wire.js";
import type { SpendDraft } from "./guard.js";

/** What is being bought, named by hash so the description stays private. */
export interface QuoteSubject {
  /** A coarse kind, e.g. `"api.call"` or `"goods.shipment"`. Opaque here. */
  readonly kind: string;
  /** Digest of the full description. The description never has to travel. */
  readonly digest: string;
}

export interface Quote {
  readonly quoteId: string;
  /** Who is promising. An identifier; nothing here proves it. */
  readonly issuer: string;
  readonly subject: QuoteSubject;
  readonly asset: AssetId;
  /**
   * The ceiling. The seller may charge less and never more.
   *
   * This is the field that matters: the buyer authorises against it, so the
   * authorisation is exact rather than an estimate.
   */
  readonly maxAmount: Amount;
  /** Where payment goes. Becomes the request's destination, so policy sees it. */
  readonly payTo: string;
  readonly issuedAt: number;
  /** Exclusive: at exactly this instant the quote is already expired. */
  readonly expiresAt: number;
  /** Bound to one buyer, or `null` for bearer. */
  readonly audience: string | null;
  /** Bound to one request, or `null` for any. */
  readonly requestId: string | null;
}

/** What a service hands back instead of the thing, until it is paid for. */
export interface PaymentRequired {
  readonly quote: Quote;
  /**
   * How payment may be presented. Opaque strings — a rail adapter interprets
   * them. Naming rails here would put a vendor in the contract.
   */
  readonly accepts: readonly string[];
}

export type QuoteRejection =
  | "MALFORMED"
  | "NOT_YET_VALID"
  | "EXPIRED"
  | "WRONG_AUDIENCE"
  | "WRONG_REQUEST";

export type QuoteAssessment =
  | { readonly usable: true; readonly quote: Quote }
  | { readonly usable: false; readonly reason: QuoteRejection; readonly detail: string };

export interface QuoteContext {
  /** The instant being judged at. Supplied, never read from a clock. */
  readonly now: number;
  /** Who is presenting the quote. */
  readonly audience: string;
  /** The request it is being used for. */
  readonly requestId: string;
}

/** A quote's content hash. Two quotes promising the same thing hash alike. */
export function quoteDigest(quote: Quote): string {
  return digestOf(quote);
}

/**
 * Is this quote usable, here, now, by me, for this?
 *
 * Pure: the instant arrives in the context. A buyer that read its own clock
 * here could not replay the decision later, and the whole point of the
 * receipt is that it can.
 */
export function assessQuote(quote: Quote, context: QuoteContext): QuoteAssessment {
  const no = (reason: QuoteRejection, detail: string): QuoteAssessment => ({
    usable: false,
    reason,
    detail,
  });

  if (quote.maxAmount <= 0n) {
    return no("MALFORMED", `ceiling must be positive, got ${quote.maxAmount.toString(10)}`);
  }
  if (quote.expiresAt <= quote.issuedAt) {
    return no("MALFORMED", "quote expires at or before it was issued");
  }
  if (quote.payTo.length === 0) return no("MALFORMED", "quote names no payee");

  if (context.now < quote.issuedAt) {
    return no("NOT_YET_VALID", `issued at ${new Date(quote.issuedAt).toISOString()}`);
  }
  // Exclusive, deliberately. A deadline you can sit exactly on is not one.
  if (context.now >= quote.expiresAt) {
    return no("EXPIRED", `expired at ${new Date(quote.expiresAt).toISOString()}`);
  }

  if (quote.audience !== null && quote.audience !== context.audience) {
    return no("WRONG_AUDIENCE", `quote is for ${quote.audience}, presented by ${context.audience}`);
  }
  if (quote.requestId !== null && quote.requestId !== context.requestId) {
    return no("WRONG_REQUEST", `quote is for ${quote.requestId}, presented for ${context.requestId}`);
  }

  return { usable: true, quote };
}

export interface QuotedDraftInput {
  readonly requestId: string;
  readonly account: string;
  readonly requester: Requester;
  readonly requestedAt: number;
  readonly memo?: string;
}

/**
 * Turns an accepted quote into something the policy can judge.
 *
 * Two details carry the design:
 *
 * - **`amount` is the quoted ceiling**, never an estimate. The buyer commits
 *   to the worst case the seller has agreed to, so a policy that allows it is
 *   allowing everything that can actually happen.
 * - **`destination` is the seller's payee**, so an ordinary
 *   `DESTINATION_ALLOWLIST` refuses a quote from a counterparty the buyer has
 *   not approved. No new rule kind was needed for that; it falls out.
 */
export function quotedDraft(quote: Quote, input: QuotedDraftInput): SpendDraft {
  return {
    requestId: input.requestId,
    account: input.account,
    requester: input.requester,
    asset: quote.asset,
    amount: quote.maxAmount,
    destination: quote.payTo,
    requestedAt: input.requestedAt,
    ...(input.memo === undefined ? {} : { memo: input.memo }),
  };
}

export type QuoteSettlement =
  | {
      readonly honoured: true;
      readonly charged: Amount;
      /** Ceiling minus charge. Budget the buyer reserved and gets back. */
      readonly headroom: Amount;
    }
  | {
      readonly honoured: false;
      readonly charged: Amount;
      /** How far past the promise. Evidence, not an accident. */
      readonly exceededBy: Amount;
    };

/**
 * Did the seller keep its promise?
 *
 * Charging under the ceiling is normal and returns the headroom. Charging over
 * it is a broken commitment — recorded rather than absorbed, because unlike an
 * estimate that ran long, somebody promised this would not happen.
 */
export function settlementAgainstQuote(quote: Quote, charged: Amount): QuoteSettlement {
  return charged <= quote.maxAmount
    ? { honoured: true, charged, headroom: quote.maxAmount - charged }
    : { honoured: false, charged, exceededBy: charged - quote.maxAmount };
}
