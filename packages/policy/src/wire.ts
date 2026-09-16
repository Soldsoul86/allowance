/**
 * The one encoding everything hashes and signs over.
 *
 * Three modules needed "canonical bytes for this object" and two of them had
 * grown their own copy. Never duplicating a source of truth
 * applies to an encoding as much as to data: two encoders that agree today
 * will disagree after one of them is edited, and then a signature made by one
 * fails under the other for no visible reason.
 *
 * Amounts become decimal strings because `canonicalJson` refuses `bigint`,
 * and it is right to. JSON has no unambiguous encoding for one, and a
 * `Number` would silently round a large payment into a lie.
 *
 * ## RFC 8785 (JCS)
 *
 * This encoding **conforms** to the JSON Canonicalization Scheme, which
 * several payment protocols mandate by name: keys ordered by UTF-16 code unit,
 * numbers in the ECMAScript `Number::toString` forms, no incidental
 * whitespace, and NaN/Infinity refused rather than encoded.
 *
 * That is measured, not asserted — `tests/jcs.test.ts` runs the RFC's own
 * §3.2.3 worked example, the surrogate-pair ordering case, and the number
 * forms the RFC calls out.
 *
 * It is worth saying how that fact was arrived at, because the process was
 * worse than the result. Non-conformance was listed as a known limitation for
 * several revisions, on nothing but an assumption. When somebody finally
 * checked, it already conformed on every point. A limitation recorded without
 * being measured is a guess in the costume of a known issue, and this one cost
 * interop credibility for nothing.
 *
 * The one narrowing is `toWire`: a `bigint` becomes a decimal string *before*
 * canonicalisation. That decides what JSON value is being encoded, which is a
 * question JCS does not answer and does not forbid. A counterparty must be
 * told amounts are strings; they need not be told anything about JCS.
 */
import { canonicalJson } from "@allowance/journal";
import { createHash } from "node:crypto";

/** Replaces every `bigint` with its decimal string, recursively. */
export function toWire(value: unknown): unknown {
  if (typeof value === "bigint") return value.toString(10);
  if (Array.isArray(value)) return value.map(toWire);
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, v]) => v !== undefined)
        .map(([k, v]) => [k, toWire(v)]),
    );
  }
  return value;
}

/** Canonical text: keys sorted, no incidental whitespace, amounts as strings. */
export function canonicalText(value: unknown): string {
  return canonicalJson(toWire(value));
}

/** The bytes a signature is made over. */
export function canonicalBytes(value: unknown): Buffer {
  return Buffer.from(canonicalText(value), "utf8");
}

/** SHA-256 hex over the canonical text. */
export function digestOf(value: unknown): string {
  return createHash("sha256").update(canonicalText(value), "utf8").digest("hex");
}
