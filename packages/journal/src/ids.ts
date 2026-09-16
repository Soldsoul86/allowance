/**
 * Event identifiers.
 *
 * Constitution Art. I: every event carries a globally unique identity that is
 * never reused. Identifiers are ULID-class — lexicographically sortable by
 * creation time, with cryptographic randomness in the low bits.
 */
import { randomBytes } from "node:crypto";

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

function encodeBase32(value: bigint, length: number): string {
  let out = "";
  let remaining = value;
  for (let i = 0; i < length; i++) {
    out = CROCKFORD[Number(remaining & 31n)] + out;
    remaining >>= 5n;
  }
  return out;
}

/**
 * Generates a ULID for the given millisecond timestamp.
 *
 * 48 bits of time (10 chars) followed by 80 bits of randomness (16 chars).
 */
export function newEventId(timestampMs: number): string {
  const time = encodeBase32(BigInt(Math.floor(timestampMs)) & ((1n << 48n) - 1n), 10);
  let random = 0n;
  for (const byte of randomBytes(10)) random = (random << 8n) | BigInt(byte);
  return time + encodeBase32(random, 16);
}

/** True when `value` has the shape of an identifier produced by {@link newEventId}. */
export function isEventId(value: string): boolean {
  return value.length === 26 && [...value].every((c) => CROCKFORD.includes(c));
}
