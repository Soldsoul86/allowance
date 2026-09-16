/**
 * The network boundary.
 *
 * Held to a different standard from the rest of the package, because it is the
 * first thing that reads bytes a stranger wrote. Two groups carry the file:
 * the hostile-input group, where nothing may throw and nothing may be
 * believed; and the canonical-amount group, where a decoder that helpfully
 * normalises input would silently break every signature made over the
 * original bytes.
 */
import { ok, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import { generateKeyPairSync } from "node:crypto";

import type { PaymentAuthorization, PublicKeyRecord, Quote, Signed } from "../src/index.js";
import {
  MemoryKeyDirectory,
  admitPayment,
  decodeAuthorization,
  decodeChallenge,
  ed25519Signer,
  encodeAuthorization,
  encodeChallenge,
  canonicalText,
  quoteDigest,
  readAmount,
  sign,
} from "../src/index.js";

const T0 = Date.UTC(2026, 8, 16, 4, 0, 0);
const VENDOR = "vendor:messages-api";
const BUYER = "acct:research-agent";

function identity(keyId: string, speaksFor: readonly string[]) {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519", {
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
  const record: PublicKeyRecord = {
    keyId,
    algorithm: "ed25519",
    publicKeyPem: publicKey,
    speaksFor,
    notBefore: T0 - 86_400_000,
    notAfter: null,
    revoked: false,
  };
  return { record, signer: ed25519Signer(keyId, privateKey) };
}

const quote: Quote = {
  quoteId: "q-1",
  issuer: VENDOR,
  subject: { kind: "api.call", digest: "a".repeat(64) },
  asset: "anthropic:tokens",
  maxAmount: 4_000n,
  payTo: "vendor:messages-api/pay",
  issuedAt: T0 - 1_000,
  expiresAt: T0 + 60_000,
  audience: BUYER,
  requestId: "call-1",
};

const authorization = (overrides: Partial<PaymentAuthorization> = {}): PaymentAuthorization => ({
  quoteDigest: quoteDigest(quote),
  requestId: "call-1",
  account: BUYER,
  asset: quote.asset,
  amount: quote.maxAmount,
  authorizedAt: T0,
  policyDigest: "b".repeat(64),
  ...overrides,
});

describe("round trips", () => {
  it("a signed challenge survives the wire intact", () => {
    const vendor = identity("vendor-key", [VENDOR]);
    const header = encodeChallenge(
      sign({ quote, accepts: ["ledger:internal"] }, vendor.signer, T0),
    );
    const decoded = decodeChallenge(header);

    ok(decoded.ok);
    strictEqual(decoded.value.payload.quote.maxAmount, 4_000n);
    strictEqual(decoded.value.payload.quote.audience, BUYER);
    strictEqual(decoded.value.payload.accepts[0], "ledger:internal");
  });

  it("a decoded challenge still verifies against the signature it arrived with", () => {
    // The real test of the encoder: if it altered a single byte of the
    // canonical form, the signature made over the original would fail here.
    const vendor = identity("vendor-key", [VENDOR]);
    const signed = sign({ quote, accepts: [] }, vendor.signer, T0);
    const decoded = decodeChallenge(encodeChallenge(signed));
    ok(decoded.ok);

    const reSigned = sign(decoded.value.payload, vendor.signer, T0);
    strictEqual(reSigned.signatures[0]?.value, signed.signatures[0]?.value);
  });

  it("an authorization survives the wire intact", () => {
    const buyer = identity("buyer-key", [BUYER]);
    const decoded = decodeAuthorization(
      encodeAuthorization(sign(authorization(), buyer.signer, T0)),
    );
    ok(decoded.ok);
    strictEqual(decoded.value.payload.amount, 4_000n);
    strictEqual(decoded.value.payload.account, BUYER);
  });
});

describe("amounts must arrive canonical", () => {
  it("accepts a plain decimal integer", () => {
    strictEqual(readAmount("0"), 0n);
    strictEqual(readAmount("4000"), 4_000n);
    strictEqual(readAmount("1208925819614629174706176"), 2n ** 80n);
  });

  it("refuses hex, which BigInt would otherwise happily accept", () => {
    // BigInt("0x10") is 16n. A relaxed reader prices this at sixteen.
    strictEqual(readAmount("0x10"), null);
  });

  it("refuses exponent form, which BigInt would throw on", () => {
    strictEqual(readAmount("1e999"), null);
  });

  it("refuses leading zeros, because normalising them breaks signatures", () => {
    // "007" -> 7n -> re-encodes as "7". The signature was over "007".
    strictEqual(readAmount("007"), null);
  });

  it("refuses signs, whitespace, separators and absurd lengths", () => {
    for (const bad of ["-5", "+5", " 5", "5 ", "5_000", "5.0", "", "1".repeat(41), "NaN"]) {
      strictEqual(readAmount(bad), null, bad);
    }
  });

  it("refuses anything that is not a string", () => {
    for (const bad of [5, 5n, null, undefined, {}, []]) {
      strictEqual(readAmount(bad), null);
    }
  });
});

describe("hostile input never throws", () => {
  const cases: readonly [string, unknown][] = [
    ["absent", undefined],
    ["empty", ""],
    ["not a string", 42],
    ["not base64", "!!!!not base64!!!!"],
    ["base64 of nothing useful", Buffer.from("hello").toString("base64")],
    ["base64 of an array", Buffer.from("[1,2,3]").toString("base64")],
    ["base64 of null", Buffer.from("null").toString("base64")],
    ["truncated json", Buffer.from('{"payload":').toString("base64")],
    ["no signatures", Buffer.from('{"payload":{"quote":{},"accepts":[]}}').toString("base64")],
    ["empty signatures", Buffer.from('{"payload":{},"signatures":[]}').toString("base64")],
  ];

  for (const [name, input] of cases) {
    it(`refuses ${name} with a reason, not an exception`, () => {
      const challenge = decodeChallenge(input);
      strictEqual(challenge.ok, false);
      const auth = decodeAuthorization(input);
      strictEqual(auth.ok, false);
    });
  }

  it("caps the size a peer can make us read", () => {
    const huge = Buffer.from(`{"payload":{"x":"${"a".repeat(200_000)}"}}`).toString("base64");
    const result = decodeChallenge(huge);
    strictEqual(result.ok, false);
    if (result.ok) return;
    strictEqual(result.reason, "TOO_LARGE");
  });

  it("refuses an unknown signature algorithm rather than passing it on", () => {
    // canonicalText, not JSON.stringify: the payload holds a bigint, which is
    // the whole reason the wire encoder exists.
    const body = canonicalText({
      payload: authorization(),
      signatures: [{ keyId: "k", algorithm: "rsa-md5", value: "aaaa", signedAt: T0 }],
    });
    const result = decodeAuthorization(Buffer.from(body).toString("base64"));
    strictEqual(result.ok, false);
  });

  it("refuses a quote missing a required field", () => {
    const { payTo: _dropped, ...incomplete } = quote;
    const body = canonicalText({
      payload: { quote: { ...incomplete, maxAmount: 4_000n }, accepts: [] },
      signatures: [{ keyId: "k", algorithm: "ed25519", value: "aaaa", signedAt: T0 }],
    });
    const result = decodeChallenge(Buffer.from(body).toString("base64"));
    strictEqual(result.ok, false);
    if (result.ok) return;
    strictEqual(result.reason, "MALFORMED");
  });
});

describe("the seller's admission check", () => {
  const buyer = identity("buyer-key", [BUYER]);
  const directory = new MemoryKeyDirectory([buyer.record]);

  const present = (payload: PaymentAuthorization): Signed<PaymentAuthorization> =>
    sign(payload, buyer.signer, T0);

  it("admits a properly signed authorization for the quote it issued", () => {
    const result = admitPayment({
      authorization: present(authorization()),
      quote,
      directory,
      now: T0,
    });
    strictEqual(result.admitted, true);
  });

  it("does not turn its own directory outage into an accusation", () => {
    // The buyer did everything right; the seller could not look the key up.
    // Refusing this as NOT_ATTRIBUTED would blame the buyer for the seller's
    // outage — and a retry, not an investigation, is the correct response.
    const result = admitPayment({
      authorization: present(authorization()),
      quote,
      directory: {
        publicKey: () => ({ found: false, reason: "UNAVAILABLE", detail: "directory timed out" }),
      },
      now: T0,
    });
    strictEqual(result.admitted, false);
    if (result.admitted) return;
    strictEqual(result.reason, "ATTRIBUTION_INDETERMINATE");
  });

  it("refuses an authorization signed by somebody else", () => {
    const stranger = identity("stranger-key", ["acct:not-this-buyer"]);
    const result = admitPayment({
      authorization: sign(authorization(), stranger.signer, T0),
      quote,
      directory: new MemoryKeyDirectory([buyer.record, stranger.record]),
      now: T0,
    });
    strictEqual(result.admitted, false);
    if (result.admitted) return;
    strictEqual(result.reason, "NOT_ATTRIBUTED");
  });

  it("refuses an authorization for a different quote", () => {
    const result = admitPayment({
      authorization: present(authorization({ quoteDigest: "c".repeat(64) })),
      quote,
      directory,
      now: T0,
    });
    strictEqual(result.admitted, false);
    if (result.admitted) return;
    strictEqual(result.reason, "WRONG_QUOTE");
  });

  it("compares against the seller's own quote, not the buyer's copy", () => {
    // The buyer signs a perfectly coherent authorization for a cheaper quote
    // it invented. Echoing a payload back proves nothing.
    const invented: Quote = { ...quote, maxAmount: 1n };
    const result = admitPayment({
      authorization: present(authorization({ quoteDigest: quoteDigest(invented), amount: 1n })),
      quote,
      directory,
      now: T0,
    });
    strictEqual(result.admitted, false);
    if (result.admitted) return;
    strictEqual(result.reason, "WRONG_QUOTE");
  });

  it("refuses once the quote has expired", () => {
    const result = admitPayment({
      authorization: present(authorization()),
      quote,
      directory,
      now: quote.expiresAt,
    });
    strictEqual(result.admitted, false);
    if (result.admitted) return;
    strictEqual(result.reason, "QUOTE_EXPIRED");
  });

  it("refuses an authorization for less than the ceiling", () => {
    // Otherwise the seller does the work and then finds it may not charge.
    const result = admitPayment({
      authorization: present(authorization({ amount: 100n })),
      quote,
      directory,
      now: T0,
    });
    strictEqual(result.admitted, false);
    if (result.admitted) return;
    strictEqual(result.reason, "AMOUNT_MISMATCH");
  });

  it("refuses an authorization in the wrong asset", () => {
    const result = admitPayment({
      authorization: present(authorization({ asset: "USDC" })),
      quote,
      directory,
      now: T0,
    });
    strictEqual(result.admitted, false);
    if (result.admitted) return;
    strictEqual(result.reason, "ASSET_MISMATCH");
  });
});
