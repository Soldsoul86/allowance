/**
 * Attribution: proving *who*, not just *what*.
 *
 * A quote and a receipt are already verifiable — their contents recompute and
 * tampering is caught. Neither is *attributable*: anyone can mint a `Quote`
 * claiming to be `vendor:messages-api`, and nothing in it objects. An
 * unsigned quote crossing a real network is worse than no quote, because it
 * looks like a commitment and binds nobody.
 *
 * ## The check almost everyone forgets
 *
 * A valid signature proves a key signed these bytes. It does **not** prove the
 * signer was entitled to speak for the identity the payload claims. If a quote
 * says `issuer: "vendor:messages-api"`, a correct signature from *some* key is
 * worthless unless that key is authorised for that issuer.
 *
 * So a key in the directory declares what it `speaksFor`, and
 * {@link verifySignatures} refuses a technically perfect signature from a key
 * that is not authorised. `KEY_NOT_AUTHORIZED` is a distinct outcome from
 * `BAD_SIGNATURE` because they mean completely different things: one is a
 * forgery, the other is a real party signing outside its remit.
 *
 * ## Time is the signature's, not the verifier's
 *
 * A key's validity is checked against `signedAt`, not against now. Rotating a
 * key must not invalidate everything it ever signed, or every historical
 * receipt breaks the day you rotate.
 *
 * Compromise is different, and gets its own switch: a `revoked` key fails
 * regardless of when it signed, and reports `KEY_REVOKED` rather than a
 * generic failure — the reader needs to know the difference between "this was
 * forged" and "this was genuine, by a key we no longer trust".
 *
 * ## Keys
 *
 * This package holds none. {@link Signer} is a port; the reference Ed25519
 * implementation takes a private key the caller supplies and keeps it in a
 * closure so it cannot be read back off the object. Generating, storing and
 * destroying key material belongs to whoever owns the identity — not to a
 * library that also decides whether payments are allowed.
 */
import { createPublicKey, sign as cryptoSign, verify as cryptoVerify } from "node:crypto";

import { canonicalBytes } from "./wire.js";
import type { Quote } from "./quote.js";
import type { SpendReceipt } from "./receipt.js";

export type SignatureAlgorithm = "ed25519";

export interface Signature {
  /** Names the key, not the signer. The directory maps it to an identity. */
  readonly keyId: string;
  readonly algorithm: SignatureAlgorithm;
  /** Base64 of the raw signature over the payload's canonical bytes. */
  readonly value: string;
  /** When it was signed. Key validity is judged against this, not against now. */
  readonly signedAt: number;
}

/**
 * A payload with the signatures made over it.
 *
 * Plural, because a countersigned quote and a receipt attested by both parties
 * are both ordinary. A single-signature type would have to be widened later,
 * and widening a signed format is how signatures get skipped.
 */
export interface Signed<T> {
  readonly payload: T;
  readonly signatures: readonly Signature[];
}

/** Holds a private key and will sign bytes with it. Implementations own custody. */
export interface Signer {
  readonly keyId: string;
  readonly algorithm: SignatureAlgorithm;
  /** @param bytes canonical bytes of the payload */
  sign(bytes: Buffer, signedAt: number): string;
}

export interface PublicKeyRecord {
  readonly keyId: string;
  readonly algorithm: SignatureAlgorithm;
  /** SPKI PEM. A format the platform parses, rather than one we invent. */
  readonly publicKeyPem: string;
  /**
   * The identities this key may speak for.
   *
   * Without this a signature proves only that *somebody* signed. Empty means
   * the key speaks for nobody, and every attribution against it fails — which
   * is the right default for a key whose remit was never stated.
   */
  readonly speaksFor: readonly string[];
  readonly notBefore: number;
  /** `null` for no planned end. */
  readonly notAfter: number | null;
  /** Compromised. Fails regardless of when it signed. */
  readonly revoked: boolean;
}

/**
 * What a directory found, or why it did not.
 *
 * "I do not have that key" and "I could not look" are different facts, and
 * collapsing them into `undefined` loses the one a reader needs most. The
 * first says the signer has no authority here; the second says nothing at all
 * about the signer, only about the lookup. A verifier that reports them alike
 * invites someone to treat an outage as a forgery.
 *
 * Borrowed from the Cycles evidence spec, which distinguishes
 * `signer_authority_failed` from `signer_resolution_failed` for exactly this
 * reason and does it better than the boolean this replaces.
 */
export type KeyLookup =
  | { readonly found: true; readonly record: PublicKeyRecord }
  | {
      readonly found: false;
      /** `UNKNOWN`: consulted, no such key. `UNAVAILABLE`: could not consult. */
      readonly reason: "UNKNOWN" | "UNAVAILABLE";
      readonly detail: string;
    };

/**
 * Resolves key ids. Synchronous on purpose.
 *
 * Verification must be replayable — the same receipt must verify the same way
 * a year later — so it cannot depend on a live lookup. A caller with a remote
 * directory resolves first and verifies against the snapshot it resolved, and
 * reports `UNAVAILABLE` if that resolution failed.
 */
export interface KeyDirectory {
  publicKey(keyId: string): KeyLookup;
}

export class MemoryKeyDirectory implements KeyDirectory {
  readonly #keys = new Map<string, PublicKeyRecord>();

  constructor(records: readonly PublicKeyRecord[] = []) {
    for (const record of records) this.add(record);
  }

  add(record: PublicKeyRecord): void {
    this.#keys.set(record.keyId, record);
  }

  publicKey(keyId: string): KeyLookup {
    const record = this.#keys.get(keyId);
    return record === undefined
      ? { found: false, reason: "UNKNOWN", detail: `${keyId} is not in the directory` }
      : { found: true, record };
  }
}

/**
 * An Ed25519 signer over a private key the caller supplies.
 *
 * The key is captured in a closure and never stored on the object, so it
 * cannot be read back, serialised by accident, or printed by a debugger that
 * walks the signer. Custody, rotation and destruction remain the caller's.
 */
export function ed25519Signer(keyId: string, privateKeyPem: string): Signer {
  // Ed25519 takes `null` for the digest: the algorithm hashes internally.
  const signBytes = (bytes: Buffer): Buffer => cryptoSign(null, bytes, privateKeyPem);

  return {
    keyId,
    algorithm: "ed25519",
    sign(bytes: Buffer): string {
      return signBytes(bytes).toString("base64");
    },
  };
}

/** Signs a payload, returning it alongside the signature. */
export function sign<T>(payload: T, signer: Signer, signedAt: number): Signed<T> {
  return {
    payload,
    signatures: [
      {
        keyId: signer.keyId,
        algorithm: signer.algorithm,
        value: signer.sign(canonicalBytes(payload), signedAt),
        signedAt,
      },
    ],
  };
}

/** Adds another signature to something already signed, without disturbing the first. */
export function countersign<T>(signed: Signed<T>, signer: Signer, signedAt: number): Signed<T> {
  return {
    payload: signed.payload,
    signatures: [...signed.signatures, sign(signed.payload, signer, signedAt).signatures[0]!],
  };
}

export type SignatureRejection =
  | "UNKNOWN_KEY"
  /** The directory could not be consulted. Not a statement about the signer. */
  | "DIRECTORY_UNAVAILABLE"
  | "ALGORITHM_MISMATCH"
  | "KEY_NOT_AUTHORIZED"
  | "KEY_NOT_YET_VALID"
  | "KEY_EXPIRED"
  | "KEY_REVOKED"
  | "BAD_SIGNATURE"
  | "MALFORMED";

/**
 * How far verification got, rather than whether it passed.
 *
 * A boolean answers "may I rely on this?" and nothing else. These five say
 * *why not*, and the difference changes what a reader should do: retry a
 * resolution failure, investigate an authority failure, and treat an invalid
 * signature as tampering.
 */
export type Disposition =
  /** Signature valid and the key is authorised for the claimed identity. */
  | "authentic"
  /** Signature valid, but no identity was claimed, so authorship is unestablished. */
  | "binding_only"
  /** The directory answered, and this key may not speak for that identity. */
  | "signer_authority_failed"
  /** The directory could not be consulted. Says nothing about the signer. */
  | "signer_resolution_failed"
  /** The bytes do not verify. Tampering, or the wrong key. */
  | "signature_invalid";

/** Best first. Used to pick the strongest outcome across several signatures. */
const DISPOSITION_ORDER: readonly Disposition[] = [
  "authentic",
  "binding_only",
  // A definite "no" is more useful to a reader than "could not tell", and
  // tampering is the most serious thing to surface, so it wins a tie last.
  "signer_authority_failed",
  "signer_resolution_failed",
  "signature_invalid",
];

export interface SignatureCheck {
  readonly keyId: string;
  readonly disposition: Disposition;
  readonly valid: boolean;
  readonly reason: SignatureRejection | null;
  readonly detail: string;
}

export interface SignatureVerification {
  /** The identity the payload claims, or `null` when none was claimed. */
  readonly identity: string | null;
  /** The strongest disposition across all signatures. */
  readonly disposition: Disposition;
  /** Convenience for `disposition === "authentic"`. */
  readonly attributed: boolean;
  readonly checks: readonly SignatureCheck[];
}

/**
 * Where each failure lands.
 *
 * The mapping is the whole point of the taxonomy, so it is stated once, in a
 * table, rather than scattered across the branches that produce it.
 *
 * - Authority failures are things the directory *told* us: no such key, a
 *   revoked key, a key outside its remit or its validity window. Somebody
 *   should look at the key.
 * - A resolution failure is the directory itself being unreachable. It says
 *   nothing about the signer, and the right response is to retry.
 * - An invalid signature is bytes that do not check out: tampering, the wrong
 *   key, or a signature that cannot be parsed at all. An algorithm mismatch
 *   belongs here — the registered key could not have produced these bytes.
 */
const DISPOSITION_OF: Readonly<Record<SignatureRejection, Disposition>> = {
  UNKNOWN_KEY: "signer_authority_failed",
  KEY_NOT_AUTHORIZED: "signer_authority_failed",
  KEY_NOT_YET_VALID: "signer_authority_failed",
  KEY_EXPIRED: "signer_authority_failed",
  KEY_REVOKED: "signer_authority_failed",
  DIRECTORY_UNAVAILABLE: "signer_resolution_failed",
  ALGORITHM_MISMATCH: "signature_invalid",
  BAD_SIGNATURE: "signature_invalid",
  MALFORMED: "signature_invalid",
};

function checkOne(
  payload: unknown,
  signature: Signature,
  directory: KeyDirectory,
  identity: string | null,
): SignatureCheck {
  const no = (reason: SignatureRejection, detail: string): SignatureCheck => ({
    keyId: signature.keyId,
    disposition: DISPOSITION_OF[reason],
    valid: false,
    reason,
    detail,
  });

  if (signature.value.length === 0) return no("MALFORMED", "signature is empty");

  const lookup = directory.publicKey(signature.keyId);
  if (!lookup.found) {
    return lookup.reason === "UNAVAILABLE"
      ? no("DIRECTORY_UNAVAILABLE", lookup.detail)
      : no("UNKNOWN_KEY", lookup.detail);
  }
  const record = lookup.record;

  if (record.algorithm !== signature.algorithm) {
    return no(
      "ALGORITHM_MISMATCH",
      `key is ${record.algorithm}, signature claims ${signature.algorithm}`,
    );
  }
  if (record.revoked) {
    // Distinct from a forgery on purpose: this was genuine, by a key we no
    // longer trust. A reader needs to be able to tell those apart.
    return no("KEY_REVOKED", `${signature.keyId} has been revoked`);
  }
  // Only checked when an identity is claimed. With no claim there is nothing
  // to be authorised *for*, and the best this signature can reach is a binding.
  if (identity !== null && !record.speaksFor.includes(identity)) {
    return no(
      "KEY_NOT_AUTHORIZED",
      `${signature.keyId} may speak for [${record.speaksFor.join(", ")}], not ${identity}`,
    );
  }
  // Judged against when it signed, so rotating a key does not invalidate
  // everything it ever signed.
  if (signature.signedAt < record.notBefore) {
    return no("KEY_NOT_YET_VALID", `signed before the key came into service`);
  }
  if (record.notAfter !== null && signature.signedAt > record.notAfter) {
    return no("KEY_EXPIRED", `signed after the key left service`);
  }

  let ok: boolean;
  try {
    ok = cryptoVerify(
      null,
      canonicalBytes(payload),
      createPublicKey(record.publicKeyPem),
      Buffer.from(signature.value, "base64"),
    );
  } catch (error) {
    // A malformed key or signature must read as "not verified", never as a
    // crash in the middle of deciding whether to trust a payment.
    return no("MALFORMED", `could not be checked: ${(error as Error).message}`);
  }

  if (!ok) return no("BAD_SIGNATURE", "signature does not match the payload");

  return {
    keyId: signature.keyId,
    disposition: identity === null ? "binding_only" : "authentic",
    valid: true,
    reason: null,
    detail: identity === null ? "signature binds the payload, no identity claimed" : `speaks for ${identity}`,
  };
}

/** The strongest disposition present, by {@link DISPOSITION_ORDER}. */
function bestDisposition(checks: readonly SignatureCheck[]): Disposition {
  const best = DISPOSITION_ORDER.find((d) => checks.some((c) => c.disposition === d));
  // Unreachable: every check carries one of the five, and `checks` is non-empty.
  return best ?? "signature_invalid";
}

/**
 * Verifies every signature and reports how far attribution got.
 *
 * `attributed` requires a signature that is both cryptographically sound and
 * made by a key entitled to the claimed identity. A correct signature from an
 * unauthorised key leaves `attributed` false while still being reported as
 * what it is — and `disposition` says which of the four ways it fell short.
 *
 * Omitting `identity` asks a narrower question: do these bytes carry a sound
 * signature at all? That can reach `binding_only` and no further, because
 * there is no claim to check the signer against. It is the right call when
 * inspecting a payload whose claimed identity you have not yet decided to
 * trust — and the wrong one when deciding whether to act on it.
 */
export function verifySignatures<T>(
  signed: Signed<T>,
  directory: KeyDirectory,
  identity?: string | null,
): SignatureVerification {
  const claimed = identity ?? null;

  if (signed.signatures.length === 0) {
    // An unsigned payload must never read better than a badly signed one, so
    // absence takes the most serious disposition rather than a gentler one.
    return {
      identity: claimed,
      disposition: "signature_invalid",
      attributed: false,
      checks: [
        {
          keyId: "",
          disposition: "signature_invalid",
          valid: false,
          reason: "MALFORMED",
          detail: "payload carries no signatures",
        },
      ],
    };
  }

  const checks = signed.signatures.map((s) => checkOne(signed.payload, s, directory, claimed));
  const disposition = bestDisposition(checks);
  return { identity: claimed, disposition, attributed: disposition === "authentic", checks };
}

/** A short human-readable report. */
export function explainAttribution(result: SignatureVerification): string {
  const subject = result.identity === null ? "(no identity claimed)" : result.identity;
  const header =
    result.disposition === "authentic"
      ? `ATTRIBUTED to ${subject}`
      : `NOT ATTRIBUTED to ${subject}  [${result.disposition}]`;
  const body = result.checks
    .map(
      (c) =>
        `  ${c.valid ? "ok  " : "FAIL"}  ${c.keyId || "(no key)"}  ${c.disposition}` +
        `${c.reason === null ? "" : `  [${c.reason}]`}\n        ${c.detail}`,
    )
    .join("\n");
  return `${header}\n${body}`;
}

/* -- Bound to the two things that travel ---------------------------------- */

/**
 * Signing a quote turns a claim into a commitment.
 *
 * The identity checked on the way back is `quote.issuer` — the field the quote
 * uses to say who is promising. Verifying against anything else would let a
 * key sign a quote in someone else's name and still pass.
 */
export function signQuote(quote: Quote, signer: Signer, signedAt: number): Signed<Quote> {
  return sign(quote, signer, signedAt);
}

export function verifySignedQuote(
  signed: Signed<Quote>,
  directory: KeyDirectory,
): SignatureVerification {
  return verifySignatures(signed, directory, signed.payload.issuer);
}

/**
 * Signing a receipt says who is vouching for it.
 *
 * By default that is the account the spend was made from — the party whose
 * policy produced the decision. A counterparty who countersigns is verified
 * against their own identity, which is why `identity` can be given explicitly.
 */
export function signReceipt(
  receipt: SpendReceipt,
  signer: Signer,
  signedAt: number,
): Signed<SpendReceipt> {
  return sign(receipt, signer, signedAt);
}

export function verifySignedReceipt(
  signed: Signed<SpendReceipt>,
  directory: KeyDirectory,
  identity?: string,
): SignatureVerification {
  return verifySignatures(signed, directory, identity ?? signed.payload.request.account);
}
