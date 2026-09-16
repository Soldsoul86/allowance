/**
 * RFC 8785 (JSON Canonicalization Scheme) conformance.
 *
 * Signatures are made over canonical bytes, so the encoding is part of the
 * signature scheme: two implementations that disagree by one byte reject each
 * other's perfectly valid signatures, and the failure looks like tampering.
 *
 * Protocols in this space mandate JCS by name -- Cycles does -- so whether
 * this encoding conforms is an interoperability question, not a stylistic
 * one. It was recorded as a known gap for several revisions on the assumption
 * that it did not conform. Nobody had measured it. These tests measure it.
 */
import { deepStrictEqual, strictEqual, throws } from "node:assert/strict";
import { describe, it } from "node:test";

import { canonicalText } from "../src/index.js";

describe("the RFC's own worked example", () => {
  it("matches byte for byte", () => {
    // RFC 8785 section 3.2.3.
    const input = {
      "\u20ac": "Euro Sign",
      "\r": "Carriage Return",
      "\u000a": "Newline",
      "1": "One",
      "\u0080": "Control\u007f",
      "\u00f6": "Latin Small Letter O With Diaeresis",
      "\ufb33": "Hebrew Letter Dalet With Dagesh",
      "</script>": "Browser Challenge",
    };
    const expected =
      '{"\\n":"Newline","\\r":"Carriage Return","1":"One",' +
      '"</script>":"Browser Challenge","\u0080":"Control\u007f",' +
      '"\u00f6":"Latin Small Letter O With Diaeresis","\u20ac":"Euro Sign",' +
      '"\ufb33":"Hebrew Letter Dalet With Dagesh"}';
    strictEqual(canonicalText(input), expected);
  });
});

describe("keys sort by UTF-16 code unit, not codepoint", () => {
  it("places a surrogate pair before U+FFFF", () => {
    // The discriminating case. U+10000 is the pair D800 DC00: by code units it
    // sorts BEFORE U+FFFF, by codepoint it would sort after. JCS mandates code
    // units, and getting this backwards is the classic JCS bug.
    const encoded = canonicalText({ "\u{10000}": 1, "\uffff": 2, a: 3 });
    deepStrictEqual(Object.keys(JSON.parse(encoded)), ["a", "\u{10000}", "\uffff"]);
  });

  it("sorts nested objects too", () => {
    strictEqual(canonicalText({ b: { z: 1, a: 2 }, a: null }), '{"a":null,"b":{"a":2,"z":1}}');
  });

  it("leaves array order alone", () => {
    // Arrays are sequences; sorting them would change the value.
    strictEqual(canonicalText([3, 1, 2]), "[3,1,2]");
  });
});

describe("numbers follow ECMAScript Number::toString", () => {
  it("renders the forms JCS specifies", () => {
    const cases: readonly (readonly [number, string])[] = [
      [0, "0"],
      [-0, "0"], // negative zero canonicalises to "0"
      [1, "1"],
      [1.5, "1.5"],
      [100, "100"],
      [1e30, "1e+30"],
      [1e-7, "1e-7"],
      [333333333.33333329, "333333333.3333333"],
    ];
    for (const [value, expected] of cases) {
      strictEqual(canonicalText(value), expected, String(value));
    }
  });
});

describe("refuses what JCS cannot represent", () => {
  it("non-finite numbers and undefined", () => {
    for (const value of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      throws(() => canonicalText(value), /non-finite/);
    }
    throws(() => canonicalText(undefined), /undefined/);
  });

  it("drops undefined members rather than emitting null in their place", () => {
    // Emitting null would change the value; dropping matches JSON.stringify
    // and keeps the encoding total.
    strictEqual(canonicalText({ a: 1, b: undefined }), '{"a":1}');
  });
});

describe("empties and literals", () => {
  it("encode without surprises", () => {
    strictEqual(canonicalText({}), "{}");
    strictEqual(canonicalText([]), "[]");
    strictEqual(canonicalText(null), "null");
    strictEqual(canonicalText(true), "true");
    strictEqual(canonicalText(""), '""');
  });
});

describe("amounts still leave as decimal strings", () => {
  it("because JCS has no encoding for a bigint either", () => {
    strictEqual(canonicalText({ amount: 2n ** 70n }), '{"amount":"1180591620717411303424"}');
  });
});
