/**
 * The network boundary.
 *
 * Everything else in this package is fed by its own caller. This module is the
 * first thing that reads bytes a stranger wrote, so it works to a different
 * standard: **nothing here throws, and nothing is believed.** A decode reports
 * why it refused; it never crashes in the middle of deciding whether to pay
 * somebody, and it never returns a value that only looks well-formed.
 *
 * ## Why parsing has to be strict, not just careful
 *
 * Amounts cross the wire as decimal strings, and a relaxed reader is a
 * correctness bug rather than a style complaint:
 *
 * - `BigInt("0x10")` is `16n`. A hostile quote priced `"0x10"` reads as
 *   sixteen to a naive parser and as something else to a careful one.
 * - `BigInt("1e999")` throws, from inside whatever was holding the decision.
 * - `"007"` parses to `7n`, re-encodes as `"7"`, and **the signature over the
 *   original bytes no longer verifies** — a valid payment refused for reasons
 *   nobody can see.
 *
 * That last one is the important one. Signatures are made over canonical
 * bytes, so a decoder that silently normalises input has broken the signature
 * scheme. Amounts must therefore arrive already canonical, and anything else
 * is rejected rather than repaired.
 *
 * ## Header names
 *
 * Aligned with x402 v2 — `PAYMENT-REQUIRED` on the 402, `PAYMENT-SIGNATURE` on
 * the retry, `PAYMENT-RESPONSE` on settlement — so an adapter that speaks that
 * dialect has somewhere obvious to map onto. The *payloads* here are this
 * package's own; matching x402's `PaymentRequirement` schema field for field
 * is a mapping layer, and claiming compatibility without having implemented
 * that mapping would be a lie in a place people would rely on.
 */
import type { Amount, AssetId } from "./model.js";
import type { Quote, PaymentRequired } from "./quote.js";
import { quoteDigest } from "./quote.js";
import type { SpendReceipt } from "./receipt.js";
import type { KeyDirectory, Signature, Signed } from "./signing.js";
import { verifySignatures } from "./signing.js";
import { canonicalText, toWire } from "./wire.js";

export const PAYMENT_REQUIRED_HEADER = "payment-required";
export const PAYMENT_SIGNATURE_HEADER = "payment-signature";
export const PAYMENT_RESPONSE_HEADER = "payment-response";

/** A hostile peer must not be able to make us allocate without bound. */
export const DEFAULT_MAX_HEADER_BYTES = 64 * 1024;

/**
 * What a buyer presents after a 402.
 *
 * It binds to the exact quote by digest and to the exact decision by policy
 * digest, so an authorisation cannot be replayed against a different offer or
 * waved at a policy that never approved it.
 */
export interface PaymentAuthorization {
  readonly quoteDigest: string;
  readonly requestId: string;
  readonly account: string;
  readonly asset: AssetId;
  /** What the buyer committed to: the quoted ceiling. */
  readonly amount: Amount;
  readonly authorizedAt: number;
  readonly policyDigest: string;
}

export type DecodeRejection =
  | "MISSING"
  | "TOO_LARGE"
  | "NOT_BASE64"
  | "NOT_JSON"
  | "MALFORMED";

export type DecodeResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly reason: DecodeRejection; readonly detail: string };

const no = <T>(reason: DecodeRejection, detail: string): DecodeResult<T> => ({
  ok: false,
  reason,
  detail,
});

/* -- Strict readers -------------------------------------------------------- */

/**
 * A canonical non-negative decimal integer, and nothing else.
 *
 * No hex, no exponent, no sign, no leading zeros, no whitespace. See the note
 * above on why normalising instead of rejecting would break signatures.
 */
const CANONICAL_DECIMAL = /^(0|[1-9][0-9]*)$/;
const MAX_AMOUNT_DIGITS = 40;

export function readAmount(value: unknown): Amount | null {
  if (typeof value !== "string") return null;
  if (value.length === 0 || value.length > MAX_AMOUNT_DIGITS) return null;
  if (!CANONICAL_DECIMAL.test(value)) return null;
  return BigInt(value);
}

const readString = (value: unknown, max = 4096): string | null =>
  typeof value === "string" && value.length <= max ? value : null;

const readNullableString = (value: unknown): string | null | undefined =>
  value === null ? null : readString(value) ?? undefined;

/** Finite, integral, and inside the range a timestamp can actually occupy. */
const readTimestamp = (value: unknown): number | null =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;

const readStringArray = (value: unknown, max = 64): readonly string[] | null => {
  if (!Array.isArray(value) || value.length > max) return null;
  const out: string[] = [];
  for (const item of value) {
    const s = readString(item);
    if (s === null) return null;
    out.push(s);
  }
  return out;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function readQuote(value: unknown): Quote | null {
  if (!isRecord(value)) return null;
  const subject = value["subject"];
  if (!isRecord(subject)) return null;

  const quoteId = readString(value["quoteId"]);
  const issuer = readString(value["issuer"]);
  const kind = readString(subject["kind"]);
  const digest = readString(subject["digest"], 128);
  const asset = readString(value["asset"]);
  const maxAmount = readAmount(value["maxAmount"]);
  const payTo = readString(value["payTo"]);
  const issuedAt = readTimestamp(value["issuedAt"]);
  const expiresAt = readTimestamp(value["expiresAt"]);
  const audience = readNullableString(value["audience"]);
  const requestId = readNullableString(value["requestId"]);

  if (
    quoteId === null || issuer === null || kind === null || digest === null ||
    asset === null || maxAmount === null || payTo === null ||
    issuedAt === null || expiresAt === null ||
    audience === undefined || requestId === undefined
  ) {
    return null;
  }

  return {
    quoteId, issuer,
    subject: { kind, digest },
    asset, maxAmount, payTo, issuedAt, expiresAt, audience, requestId,
  };
}

function readAuthorization(value: unknown): PaymentAuthorization | null {
  if (!isRecord(value)) return null;

  const quoteDigestValue = readString(value["quoteDigest"], 128);
  const requestId = readString(value["requestId"]);
  const account = readString(value["account"]);
  const asset = readString(value["asset"]);
  const amount = readAmount(value["amount"]);
  const authorizedAt = readTimestamp(value["authorizedAt"]);
  const policyDigest = readString(value["policyDigest"], 128);

  if (
    quoteDigestValue === null || requestId === null || account === null ||
    asset === null || amount === null || authorizedAt === null || policyDigest === null
  ) {
    return null;
  }

  return {
    quoteDigest: quoteDigestValue,
    requestId, account, asset, amount, authorizedAt, policyDigest,
  };
}

function readSignatures(value: unknown): readonly Signature[] | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > 16) return null;
  const out: Signature[] = [];
  for (const item of value) {
    if (!isRecord(item)) return null;
    const keyId = readString(item["keyId"], 256);
    const algorithm = readString(item["algorithm"], 32);
    const sigValue = readString(item["value"], 4096);
    const signedAt = readTimestamp(item["signedAt"]);
    if (keyId === null || sigValue === null || signedAt === null) return null;
    // Only one algorithm exists; an unknown one is refused here rather than
    // reaching the verifier as an unhandled string.
    if (algorithm !== "ed25519") return null;
    out.push({ keyId, algorithm, value: sigValue, signedAt });
  }
  return out;
}

/* -- Envelope -------------------------------------------------------------- */

function encode(value: unknown): string {
  return Buffer.from(canonicalText(value), "utf8").toString("base64");
}

function decodeEnvelope(
  header: unknown,
  maxBytes: number,
): DecodeResult<Record<string, unknown>> {
  if (typeof header !== "string" || header.length === 0) {
    return no("MISSING", "header is absent or empty");
  }
  if (header.length > maxBytes) {
    return no("TOO_LARGE", `header is ${header.length} bytes, limit is ${maxBytes}`);
  }

  let text: string;
  try {
    const bytes = Buffer.from(header, "base64");
    // Buffer.from is lenient and silently drops junk, so a round trip is the
    // only honest way to tell whether the input really was base64.
    if (bytes.toString("base64").replace(/=+$/, "") !== header.replace(/=+$/, "")) {
      return no("NOT_BASE64", "header is not canonical base64");
    }
    text = bytes.toString("utf8");
  } catch {
    return no("NOT_BASE64", "header could not be decoded");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return no("NOT_JSON", `payload is not JSON: ${(error as Error).message}`);
  }

  if (!isRecord(parsed)) return no("MALFORMED", "payload is not an object");
  return { ok: true, value: parsed };
}

/* -- The three messages ---------------------------------------------------- */

/** The 402 body. `accepts` stays opaque: naming rails here would put a vendor in the contract. */
export function encodeChallenge(challenge: Signed<PaymentRequired>): string {
  return encode(challenge);
}

export function decodeChallenge(
  header: unknown,
  maxBytes = DEFAULT_MAX_HEADER_BYTES,
): DecodeResult<Signed<PaymentRequired>> {
  const envelope = decodeEnvelope(header, maxBytes);
  if (!envelope.ok) return envelope;

  const payload = envelope.value["payload"];
  if (!isRecord(payload)) return no("MALFORMED", "challenge has no payload");

  const quote = readQuote(payload["quote"]);
  if (quote === null) return no("MALFORMED", "challenge carries no well-formed quote");

  const accepts = readStringArray(payload["accepts"]);
  if (accepts === null) return no("MALFORMED", "accepts must be an array of strings");

  const signatures = readSignatures(envelope.value["signatures"]);
  if (signatures === null) return no("MALFORMED", "challenge carries no well-formed signatures");

  return { ok: true, value: { payload: { quote, accepts }, signatures } };
}

export function encodeAuthorization(authorization: Signed<PaymentAuthorization>): string {
  return encode(authorization);
}

export function decodeAuthorization(
  header: unknown,
  maxBytes = DEFAULT_MAX_HEADER_BYTES,
): DecodeResult<Signed<PaymentAuthorization>> {
  const envelope = decodeEnvelope(header, maxBytes);
  if (!envelope.ok) return envelope;

  const payload = readAuthorization(envelope.value["payload"]);
  if (payload === null) return no("MALFORMED", "authorization payload is not well-formed");

  const signatures = readSignatures(envelope.value["signatures"]);
  if (signatures === null) return no("MALFORMED", "authorization carries no well-formed signatures");

  return { ok: true, value: { payload, signatures } };
}

/**
 * The settled receipt, returned on success.
 *
 * Decoding validates the envelope and the amounts; it deliberately does not
 * re-derive the receipt's interior. `verifyReceipt` already recomputes the
 * whole decision and is the real gate — a second, weaker validator would
 * become a second opinion people trusted by mistake. **A decoded settlement is
 * structurally sound and nothing more; run `verifySignedReceipt` and
 * `verifyReceipt` before believing a word of it.**
 */
export function encodeSettlement(settlement: Signed<SpendReceipt>): string {
  return encode(settlement);
}

export function decodeSettlement(
  header: unknown,
  maxBytes = DEFAULT_MAX_HEADER_BYTES,
): DecodeResult<Signed<SpendReceipt>> {
  const envelope = decodeEnvelope(header, maxBytes);
  if (!envelope.ok) return envelope;

  if (!isRecord(envelope.value["payload"])) return no("MALFORMED", "settlement has no payload");
  const signatures = readSignatures(envelope.value["signatures"]);
  if (signatures === null) return no("MALFORMED", "settlement carries no well-formed signatures");

  return {
    ok: true,
    value: {
      payload: envelope.value["payload"] as unknown as SpendReceipt,
      signatures,
    },
  };
}

/* -- The seller's admission check ------------------------------------------ */

export type AdmissionRejection =
  | "NOT_ATTRIBUTED"
  /**
   * The signer could not be resolved, so attribution is unknown rather than
   * refused. A seller that treats this as `NOT_ATTRIBUTED` turns its own
   * directory outage into an accusation against the buyer. Retry; do not
   * blacklist, and do not deliver.
   */
  | "ATTRIBUTION_INDETERMINATE"
  | "WRONG_QUOTE"
  | "QUOTE_EXPIRED"
  | "ASSET_MISMATCH"
  | "AMOUNT_MISMATCH";

export type Admission =
  | { readonly admitted: true; readonly authorization: PaymentAuthorization }
  | { readonly admitted: false; readonly reason: AdmissionRejection; readonly detail: string };

export interface AdmissionInput {
  readonly authorization: Signed<PaymentAuthorization>;
  /** The quote this seller actually issued. Never the one the buyer echoes back. */
  readonly quote: Quote;
  readonly directory: KeyDirectory;
  readonly now: number;
}

/**
 * Decides whether a seller should act on a presented authorisation.
 *
 * Checked against the quote the **seller** holds, never the one the buyer
 * sends back. A protocol that compares a payload to a copy of itself proves
 * only that the peer can echo.
 */
export function admitPayment(input: AdmissionInput): Admission {
  const { authorization, quote, directory, now } = input;
  const payload = authorization.payload;

  const reject = (reason: AdmissionRejection, detail: string): Admission => ({
    admitted: false,
    reason,
    detail,
  });

  const attribution = verifySignatures(authorization, directory, payload.account);
  if (!attribution.attributed) {
    const first = attribution.checks[0];
    const why = `${attribution.disposition}: ${first?.reason ?? "no signatures"}`;
    // "I could not check" is not "this is forged". Kept apart here because
    // this is the point where the distinction costs someone money.
    return attribution.disposition === "signer_resolution_failed"
      ? reject("ATTRIBUTION_INDETERMINATE", `could not resolve the signer of ${payload.account}: ${why}`)
      : reject("NOT_ATTRIBUTED", `not signed by ${payload.account}: ${why}`);
  }

  const expected = quoteDigest(quote);
  if (payload.quoteDigest !== expected) {
    return reject("WRONG_QUOTE", "authorization is for a different quote");
  }
  if (now >= quote.expiresAt) {
    return reject("QUOTE_EXPIRED", `quote expired at ${new Date(quote.expiresAt).toISOString()}`);
  }
  if (payload.asset !== quote.asset) {
    return reject("ASSET_MISMATCH", `authorized ${payload.asset}, quoted ${quote.asset}`);
  }
  // The buyer must commit to the full ceiling. Authorising less would let the
  // seller do the work and then find it may not charge for it.
  if (payload.amount !== quote.maxAmount) {
    return reject(
      "AMOUNT_MISMATCH",
      `authorized ${payload.amount}, ceiling is ${quote.maxAmount}`,
    );
  }

  return { admitted: true, authorization: payload };
}

/** The raw object a non-Node transport can serialise itself. */
export function challengeToWire(challenge: Signed<PaymentRequired>): unknown {
  return toWire(challenge);
}
