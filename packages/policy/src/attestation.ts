/**
 * Claims about the world, made by named parties.
 *
 * An approval says *"I permit this."* An attestation says *"I observed this."*
 * The difference matters: an approver exercises authority, an attester reports
 * a fact. A shipment was dispatched, customs cleared it, the goods arrived,
 * a counterparty was verified. Those are observations, and Constitution
 * Art. XI §43 is explicit that an observation owns confidence, not truth.
 *
 * Two rules keep this safe to build on:
 *
 * 1. **The evidence never travels — only its digest does.** A bill of lading,
 *    a customs declaration, a passport scan: the engine records the hash and
 *    never the document. Whoever needs the original gets it from the party who
 *    holds it, out of band. A system that never holds the evidence cannot leak
 *    it, and cannot become the place everyone's documents live.
 * 2. **The engine does not decide who is a legitimate attester.** A policy
 *    names attesters; verifying that an attester is who they claim, and that
 *    they are entitled to make the claim, happens in the shell under whoever's
 *    compliance obligation it actually is. Deciding who may participate is
 *    what makes someone an operator rather than a tool.
 */

/** A signed claim that something happened. Signature verification is the shell's job. */
export interface Attestation {
  /** What is being claimed, e.g. `"goods.dispatched"`. Opaque to the engine. */
  readonly claimId: string;
  /** Who claims it. An identifier, never a person's details. */
  readonly attester: string;
  /** When the claim was made. */
  readonly assertedAt: number;
  /** Hash of the supporting document. The document itself is never held here. */
  readonly evidenceDigest: string;
}

/** Is this attestation usable at `asOf`, given the constraints a rule imposes? */
export function attestationIsCurrent(
  attestation: Attestation,
  asOf: number,
  maxAgeMs: number | null,
): boolean {
  // An attestation dated after the moment being evaluated is not evidence, it
  // is a clock problem or a forgery. Either way it must not release money.
  if (attestation.assertedAt > asOf) return false;
  if (maxAgeMs === null) return true;
  return asOf - attestation.assertedAt <= maxAgeMs;
}

/** Attestations that satisfy a claim: right claim, permitted attester, still current. */
export function satisfying(
  attestations: readonly Attestation[],
  claimId: string,
  attesters: readonly string[],
  asOf: number,
  maxAgeMs: number | null,
): readonly Attestation[] {
  return attestations.filter(
    (a) =>
      a.claimId === claimId &&
      // An empty attester list means "any attester the shell accepted".
      (attesters.length === 0 || attesters.includes(a.attester)) &&
      attestationIsCurrent(a, asOf, maxAgeMs),
  );
}
