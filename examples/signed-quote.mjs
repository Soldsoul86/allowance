#!/usr/bin/env node
/**
 * Who promised this?
 *
 *   node examples/signed-quote.mjs
 *
 * A quote already proves *what* was promised — its contents hash, and editing
 * them is caught. It does not prove *who* promised it: anyone can mint a quote
 * claiming to be your vendor, and nothing in the quote objects.
 *
 * Signing closes that. But the interesting scene is the third one, because it
 * is the failure real systems ship: a signature that is cryptographically
 * perfect, made by a key with no right to the name on the payload.
 */
import { generateKeyPairSync } from "node:crypto";
import {
  MemoryKeyDirectory,
  ed25519Signer,
  explainAttribution,
  signQuote,
  verifySignedQuote,
} from "@allowance/policy";

const now = Date.now();
const VENDOR = "vendor:messages-api";
const say = (s = "") => process.stdout.write(`${s}\n`);

function identity(keyId, speaksFor, overrides = {}) {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519", {
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
  return {
    record: {
      keyId,
      algorithm: "ed25519",
      publicKeyPem: publicKey,
      speaksFor,
      notBefore: now - 86_400_000,
      notAfter: null,
      revoked: false,
      ...overrides,
    },
    signer: ed25519Signer(keyId, privateKey),
  };
}

const quote = {
  quoteId: "q-1",
  issuer: VENDOR,
  subject: { kind: "api.call", digest: "9f2c".repeat(16) },
  asset: "anthropic:tokens",
  maxAmount: 4_000n,
  payTo: "vendor:messages-api/pay",
  issuedAt: now - 1_000,
  expiresAt: now + 120_000,
  audience: null,
  requestId: null,
};

const vendor = identity("vendor-key-1", [VENDOR]);
const impostor = identity("impostor-key", ["vendor:someone-else"]);
const burned = identity("burned-key", [VENDOR], { revoked: true });

const directory = new MemoryKeyDirectory([vendor.record, impostor.record, burned.record]);

say("\n  1. the vendor signs its own quote\n");
say(explainAttribution(verifySignedQuote(signQuote(quote, vendor.signer, now), directory))
  .split("\n").map((l) => `     ${l}`).join("\n"));

say("\n\n  2. somebody edits the ceiling from 4,000 to 400,000\n");
const signed = signQuote(quote, vendor.signer, now);
const tampered = { ...signed, payload: { ...quote, maxAmount: 400_000n } };
say(explainAttribution(verifySignedQuote(tampered, directory))
  .split("\n").map((l) => `     ${l}`).join("\n"));

say("\n\n  3. a real key, a real signature — for a name it does not own\n");
const impersonated = signQuote(quote, impostor.signer, now);
say(explainAttribution(verifySignedQuote(impersonated, directory))
  .split("\n").map((l) => `     ${l}`).join("\n"));
say("\n     The maths is flawless. The signer is simply not this vendor.");
say("     A verifier that only checked the signature would accept this.\n");

say("\n  4. a genuine signature from a key that has since been compromised\n");
say(explainAttribution(verifySignedQuote(signQuote(quote, burned.signer, now), directory))
  .split("\n").map((l) => `     ${l}`).join("\n"));
say("\n     Reported as KEY_REVOKED, not BAD_SIGNATURE — this was genuine, by a");
say("     key nobody should trust any more. A reader needs to tell those apart.\n");
