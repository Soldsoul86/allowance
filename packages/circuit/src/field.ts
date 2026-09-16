/**
 * Getting real data into a field.
 *
 * A circuit computes over elements of a prime field — here BN254's scalar
 * field, the one Groth16 uses. Strings, JSON and `bigint` amounts do not exist
 * inside it, so every value has to be mapped in, and the map has to be
 * identical on both sides or a proof about your data proves something about
 * different numbers.
 *
 * This is the layer people skip when they say "and then we add a zk proof".
 * The circuit's soundness is only as good as this encoding, so it lives in one
 * file, is deterministic, and is used by the prover and the verifier alike.
 */
import { createHash } from "node:crypto";

/** BN254 scalar field modulus. */
export const FIELD_MODULUS =
  21888242871839275222246405745257275088548364400416034343698204186575808495617n;

/** The circuit range-checks every amount to 64 bits, so the encoder must too. */
export const MAX_AMOUNT = (1n << 64n) - 1n;

export class FieldEncodingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FieldEncodingError";
  }
}

/**
 * Maps an identifier to a field element.
 *
 * SHA-256 reduced modulo the field. Truncating to 31 bytes first keeps the
 * result below the modulus without the bias a naive `mod` would introduce at
 * the top of the range — and more importantly makes the map total, so no
 * identifier ever has to be rejected for landing badly.
 */
export function fieldFor(text: string): bigint {
  const digest = createHash("sha256").update(text, "utf8").digest();
  return BigInt(`0x${digest.subarray(0, 31).toString("hex")}`);
}

/**
 * Checks an amount is representable before it reaches the circuit.
 *
 * Field arithmetic wraps. The circuit decomposes every amount to 64 bits so a
 * wrapped value cannot pass, but a caller who hands in something larger
 * deserves a clear error here rather than an unsatisfiable constraint two
 * layers down.
 */
export function amountToField(amount: bigint): bigint {
  if (amount < 0n) throw new FieldEncodingError(`amount is negative: ${amount}`);
  if (amount > MAX_AMOUNT) {
    throw new FieldEncodingError(`amount exceeds the circuit's 64-bit range: ${amount}`);
  }
  return amount;
}

/** Timestamps are milliseconds; they fit a field element with room to spare. */
export function timeToField(at: number): bigint {
  if (!Number.isSafeInteger(at) || at < 0) {
    throw new FieldEncodingError(`timestamp is not a non-negative safe integer: ${at}`);
  }
  return BigInt(at);
}
