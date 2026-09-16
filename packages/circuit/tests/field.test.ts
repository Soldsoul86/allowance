/**
 * The encoding.
 *
 * The circuit's soundness is only as good as the map from real data into the
 * field, so it gets its own tests: the range the circuit enforces must be
 * enforced here too, and identifiers must land deterministically inside the
 * field rather than near its edge.
 */
import { ok, strictEqual, throws } from "node:assert/strict";
import { describe, it } from "node:test";

import {
  FIELD_MODULUS,
  FieldEncodingError,
  MAX_AMOUNT,
  amountToField,
  fieldFor,
  timeToField,
} from "../src/index.js";

describe("identifiers", () => {
  it("are deterministic", () => {
    strictEqual(fieldFor("vendor:messages-api"), fieldFor("vendor:messages-api"));
  });

  it("separate different identifiers", () => {
    ok(fieldFor("acct:a") !== fieldFor("acct:b"));
    ok(fieldFor("") !== fieldFor(" "));
  });

  it("always land inside the field", () => {
    // Truncating to 31 bytes keeps every result below the modulus without the
    // bias a naive `mod` introduces at the top of the range.
    for (const text of ["", "a", "🙂", "x".repeat(5_000), "acct:research-agent"]) {
      const value = fieldFor(text);
      ok(value >= 0n && value < FIELD_MODULUS, text.slice(0, 12));
    }
  });
});

describe("amounts", () => {
  it("accept the whole 64-bit range", () => {
    strictEqual(amountToField(0n), 0n);
    strictEqual(amountToField(MAX_AMOUNT), MAX_AMOUNT);
  });

  it("refuse anything the circuit's range check would reject", () => {
    // Without this, a caller could hand in a value that wraps the field and
    // reads as small inside the constraint system.
    throws(() => amountToField(MAX_AMOUNT + 1n), FieldEncodingError);
    throws(() => amountToField(FIELD_MODULUS - 1n), FieldEncodingError);
  });

  it("refuse negatives", () => {
    throws(() => amountToField(-1n), /negative/);
  });
});

describe("timestamps", () => {
  it("convert", () => {
    strictEqual(timeToField(1_789_538_400_000), 1_789_538_400_000n);
  });

  it("refuse anything that is not a non-negative safe integer", () => {
    for (const bad of [-1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 2]) {
      throws(() => timeToField(bad), FieldEncodingError);
    }
  });
});
