/**
 * A spend receipt: evidence that does not ask to be trusted.
 *
 * Most audit trails are an assertion. *"Our system authorised this; here is
 * our log."* A reader who does not already trust the issuer learns nothing
 * from it, because the log and the claim have the same author.
 *
 * A receipt here is different, and the difference is the whole point of
 * everything under it being pure and deterministic: it carries the request,
 * the policy, and the ledger the decision was made against — so **a reader
 * can re-run the decision themselves and check it comes out the same.** Not
 * "trust my answer" but "here is the input and the rule; compute it yourself."
 *
 * That property is only available because `evaluate` reads no clock, performs
 * no I/O and consults nothing global. Determinism is usually defended as a
 * testing convenience. This is what it is actually for.
 *
 * ## The redaction trade-off, stated rather than hidden
 *
 * Full recomputation needs the ledger as it stood at decision time, and that
 * ledger contains other transactions. For a self-audit or a regulator that is
 * fine. For a receipt handed to a counterparty it may not be — you would be
 * disclosing your other spending to prove one payment.
 *
 * So both `policy` and `ledgerContext` may be omitted. A redacted receipt
 * still proves a great deal: that the events hash to their own contents, that
 * the outcome matches them, that the decision names a specific policy by
 * digest. It simply cannot prove the decision was *correct*. `verifyReceipt`
 * reports exactly which checks it could and could not perform — a verifier
 * that quietly downgraded would be worse than one that refuses.
 */
import { verifyEvent, type OrbEvent } from "@allowance/journal";

import { canonicalText, digestOf } from "./wire.js";

import type { Amount, SpendRequest } from "./model.js";
import type { SpendPolicy } from "./policy.js";
import { policyDigest } from "./policy.js";
import type { Decision } from "./evaluate.js";
import { evaluate } from "./evaluate.js";
import type { LedgerEntry, LedgerState } from "./ledger.js";
import type { Quote } from "./quote.js";
import { assessQuote, settlementAgainstQuote } from "./quote.js";

/**
 * Current receipt shape.
 *
 * Version 2 adds the quote a payment was made against. Art. X §37 — the kernel
 * evolves through addition, never mutation — so a v1 receipt remains valid
 * forever and simply has no quote to check. The verifier accepts both and says
 * which checks it could run.
 */
export const RECEIPT_VERSION = 2;
export const SUPPORTED_RECEIPT_VERSIONS: readonly number[] = [1, 2];

export interface ReceiptOutcome {
  readonly state: LedgerState;
  /** What was really spent. Zero for a reversal. */
  readonly amount: Amount;
}

export interface SpendReceipt {
  readonly version: number;
  readonly issuedAt: number;
  readonly request: SpendRequest;
  readonly decision: Decision;
  /** The exact policy text. `null` when redacted. */
  readonly policy: SpendPolicy | null;
  /** The ledger as the decision saw it. `null` when redacted. */
  readonly ledgerContext: readonly LedgerEntry[] | null;
  /** The journal events behind this request, each self-verifying. */
  readonly facts: readonly OrbEvent[];
  readonly outcome: ReceiptOutcome;
  /**
   * The seller's commitment this payment was made against. `null` when the
   * payment was not quoted, or on a v1 receipt.
   */
  readonly quote: Quote | null;
}

export interface BuildReceiptInput {
  readonly request: SpendRequest;
  readonly decision: Decision;
  readonly outcome: ReceiptOutcome;
  readonly facts: readonly OrbEvent[];
  readonly issuedAt: number;
  /** Omit to redact. See the note on the trade-off above. */
  readonly policy?: SpendPolicy;
  /** Omit to redact. */
  readonly ledgerContext?: readonly LedgerEntry[];
  /** The quote this payment answered, when there was one. */
  readonly quote?: Quote;
}

export function buildReceipt(input: BuildReceiptInput): SpendReceipt {
  return {
    version: RECEIPT_VERSION,
    issuedAt: input.issuedAt,
    request: input.request,
    decision: input.decision,
    policy: input.policy ?? null,
    ledgerContext: input.ledgerContext ?? null,
    facts: input.facts,
    outcome: input.outcome,
    quote: input.quote ?? null,
  };
}

/* -- Wire form ------------------------------------------------------------ */

/** Canonical bytes for a receipt. See `wire.ts` for why amounts are strings. */
export function encodeReceipt(receipt: SpendReceipt): string {
  return canonicalText(receipt);
}

/** The receipt's content hash. Two receipts with the same facts hash alike. */
export function receiptDigest(receipt: SpendReceipt): string {
  return digestOf(receipt);
}

/* -- Verification --------------------------------------------------------- */

/**
 * Why a check did not pass, distinguished with care.
 *
 * `SKIPPED` and `NOT_APPLICABLE` look alike and mean opposite things.
 * `SKIPPED` says the evidence exists and was withheld — the receipt is
 * weaker than it could be, so the result is only `PARTIAL`.
 * `NOT_APPLICABLE` says there is nothing to check: a refused request has no
 * ledger facts because nothing was reserved, and an unquoted payment has no
 * ceiling to breach. Neither is a gap, and neither should downgrade a
 * receipt that is otherwise complete.
 *
 * Collapsing the two would mean a perfectly good receipt for an unquoted
 * payment could never read as verified — which is how a verifier teaches
 * people to ignore it.
 */
export type CheckStatus = "PASS" | "FAIL" | "SKIPPED" | "NOT_APPLICABLE";

export interface ReceiptCheck {
  readonly name: string;
  readonly status: CheckStatus;
  readonly detail: string;
}

export interface VerificationResult {
  /** True only when every check that ran passed and none was skipped. */
  readonly verified: boolean;
  /** True when everything checkable passed, but something was redacted. */
  readonly partial: boolean;
  readonly checks: readonly ReceiptCheck[];
}

const pass = (name: string, detail: string): ReceiptCheck => ({ name, status: "PASS", detail });
const fail = (name: string, detail: string): ReceiptCheck => ({ name, status: "FAIL", detail });
/** The evidence exists but was withheld. Weakens the receipt. */
const skip = (name: string, detail: string): ReceiptCheck => ({ name, status: "SKIPPED", detail });
/** There is nothing here to check. Does not weaken anything. */
const moot = (name: string, detail: string): ReceiptCheck => ({
  name,
  status: "NOT_APPLICABLE",
  detail,
});

/**
 * Checks a receipt without trusting whoever issued it.
 *
 * Nothing here consults a network or the issuer's storage: everything is
 * recomputed from the receipt's own contents. Each check is reported
 * individually, and a check that could not run says so rather than being
 * silently dropped.
 */
export function verifyReceipt(receipt: SpendReceipt): VerificationResult {
  const checks: ReceiptCheck[] = [];

  /* 1. Is this a shape we understand? A future version may mean anything. */
  checks.push(
    SUPPORTED_RECEIPT_VERSIONS.includes(receipt.version)
      ? pass("VERSION", `receipt version ${receipt.version}`)
      : fail("VERSION", `unsupported receipt version ${receipt.version}`),
  );

  /* 2. Does each journal event still hash to its own contents? */
  const reserved = receipt.decision.outcome === "ALLOW";
  if (receipt.facts.length === 0) {
    checks.push(
      reserved
        ? skip("FACTS_INTACT", "request was allowed but no journal events are attached")
        : moot("FACTS_INTACT", `nothing was reserved: decision was ${receipt.decision.outcome}`),
    );
  } else {
    const broken = receipt.facts.filter((event) => !verifyEvent(event));
    checks.push(
      broken.length === 0
        ? pass("FACTS_INTACT", `${receipt.facts.length} event(s) hash to their contents`)
        : fail("FACTS_INTACT", `${broken.length} event(s) have been altered`),
    );
  }

  /* 3. Do the events actually concern this request? */
  const foreign = receipt.facts.filter(
    (event) =>
      !(
        typeof event.payload === "object" &&
        event.payload !== null &&
        (event.payload as Record<string, unknown>)["requestId"] === receipt.request.requestId
      ),
  );
  checks.push(
    receipt.facts.length === 0
      ? moot("FACTS_MATCH_REQUEST", "no events to match")
      : foreign.length === 0
        ? pass("FACTS_MATCH_REQUEST", `all events name ${receipt.request.requestId}`)
        : fail("FACTS_MATCH_REQUEST", `${foreign.length} event(s) name a different request`),
  );

  /* 4. Was the decision made under the policy that is attached? */
  if (receipt.policy === null) {
    checks.push(skip("POLICY_BINDING", "policy redacted; decision names it only by digest"));
  } else {
    const digest = policyDigest(receipt.policy);
    checks.push(
      digest === receipt.decision.policyDigest
        ? pass("POLICY_BINDING", `policy matches digest ${digest.slice(0, 12)}`)
        : fail("POLICY_BINDING", "attached policy is not the one the decision names"),
    );
  }

  /* 5. The one that matters: re-run the decision and compare. */
  if (receipt.policy === null || receipt.ledgerContext === null) {
    checks.push(
      skip(
        "DECISION_REPRODUCES",
        receipt.policy === null ? "policy redacted" : "ledger context redacted",
      ),
    );
  } else {
    const recomputed = evaluate(receipt.request, receipt.policy, receipt.ledgerContext);
    const same = canonicalText(recomputed) === canonicalText(receipt.decision);
    checks.push(
      same
        ? pass("DECISION_REPRODUCES", `recomputed independently: ${recomputed.outcome}`)
        : fail(
            "DECISION_REPRODUCES",
            `recomputing gives ${recomputed.outcome}, receipt claims ${receipt.decision.outcome}`,
          ),
    );
  }

  /* 6. Does the stated outcome match what the events say happened? */
  checks.push(outcomeCheck(receipt));

  /* 7. Did the seller keep the promise it made? */
  checks.push(quoteCheck(receipt));

  const failed = checks.some((c) => c.status === "FAIL");
  // Only a withheld check weakens the result. A check with nothing to examine
  // is not a gap in the evidence.
  const withheld = checks.some((c) => c.status === "SKIPPED");

  return { verified: !failed && !withheld, partial: !failed && withheld, checks };
}

function reservedOutcome(receipt: SpendReceipt): boolean {
  return receipt.decision.outcome === "ALLOW";
}

function outcomeCheck(receipt: SpendReceipt): ReceiptCheck {
  const last = receipt.facts.at(-1);
  if (last === undefined) {
    return reservedOutcome(receipt)
      ? skip("OUTCOME_CONSISTENT", "request was allowed but no journal events are attached")
      : moot("OUTCOME_CONSISTENT", "no events to compare against");
  }

  const expected: Record<string, LedgerState> = {
    "payment.reserved": "PENDING",
    "payment.settled": "SETTLED",
    "payment.reversed": "REVERSED",
  };
  const impliedState = expected[last.type];
  if (impliedState === undefined) {
    return fail("OUTCOME_CONSISTENT", `final event ${last.type} is not a ledger fact`);
  }
  if (impliedState !== receipt.outcome.state) {
    return fail(
      "OUTCOME_CONSISTENT",
      `events end in ${impliedState}, receipt claims ${receipt.outcome.state}`,
    );
  }

  if (last.type === "payment.settled") {
    const payload = last.payload as Record<string, unknown>;
    const settled = payload["actualAmount"];
    if (typeof settled !== "string" || BigInt(settled) !== receipt.outcome.amount) {
      return fail(
        "OUTCOME_CONSISTENT",
        `settlement event says ${String(settled)}, receipt claims ${receipt.outcome.amount}`,
      );
    }
  }

  return pass("OUTCOME_CONSISTENT", `events and outcome agree on ${impliedState}`);
}

/**
 * Holds the seller to its own ceiling.
 *
 * Unlike an estimate that ran long, an overcharge here is a broken
 * commitment: somebody stated a maximum and then exceeded it. The check also
 * refuses a quote that was already expired when the request was made, or one
 * bound to a different buyer or request — a quote nobody checks the bindings
 * on is just a price tag.
 */
function quoteCheck(receipt: SpendReceipt): ReceiptCheck {
  const quote = receipt.quote;
  if (quote === null) return moot("QUOTE_HONOURED", "payment was not made against a quote");

  const assessment = assessQuote(quote, {
    now: receipt.request.requestedAt,
    audience: receipt.request.account,
    requestId: receipt.request.requestId,
  });
  if (!assessment.usable) {
    return fail("QUOTE_HONOURED", `quote was not usable: ${assessment.reason} — ${assessment.detail}`);
  }

  if (quote.asset !== receipt.request.asset) {
    return fail("QUOTE_HONOURED", `quote prices ${quote.asset}, request moves ${receipt.request.asset}`);
  }
  if (quote.payTo !== receipt.request.destination) {
    return fail("QUOTE_HONOURED", `quote pays ${quote.payTo}, request pays ${receipt.request.destination}`);
  }

  // A reversal charged nothing, so there is no ceiling to breach.
  if (receipt.outcome.state === "REVERSED") {
    return pass("QUOTE_HONOURED", "reversed; nothing was charged");
  }

  const settlement = settlementAgainstQuote(quote, receipt.outcome.amount);
  return settlement.honoured
    ? pass(
        "QUOTE_HONOURED",
        `charged ${settlement.charged} of a ${quote.maxAmount} ceiling ` +
          `(${settlement.headroom} unused)`,
      )
    : fail(
        "QUOTE_HONOURED",
        `charged ${settlement.charged} against a ${quote.maxAmount} ceiling — ` +
          `over by ${settlement.exceededBy}`,
      );
}

/** A short human-readable verification report. */
export function explainVerification(result: VerificationResult): string {
  const header = result.verified
    ? "VERIFIED — every check passed"
    : result.partial
      ? "PARTIAL — everything checkable passed, but some evidence was redacted"
      : "FAILED";
  const mark: Record<CheckStatus, string> = {
    PASS: "ok  ",
    FAIL: "FAIL",
    SKIPPED: "held",
    NOT_APPLICABLE: "  - ",
  };
  const body = result.checks
    .map((c) => `  ${mark[c.status]}  ${c.name}\n        ${c.detail}`)
    .join("\n");
  return `${header}\n${body}`;
}
