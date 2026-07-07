import { describe, expect, it } from "vitest";

import { isReceiptError } from "../src/errors.js";
import { jcsSerialize } from "../src/core/jcs.js";

function expectCanonFailure(value: unknown): void {
  try {
    jcsSerialize(value);
  } catch (error) {
    expect(isReceiptError(error)).toBe(true);
    if (isReceiptError(error)) {
      expect(error.code).toBe("CANONICALIZATION_FAILED");
    }
    return;
  }
  expect.fail("expected CANONICALIZATION_FAILED");
}

describe("jcs@1 (RFC 8785)", () => {
  it("sorts object members by UTF-16 code units", () => {
    // RFC 8785 §3.2.3 ordering example (subset).
    const value = {
      "€": "Euro Sign",
      "\r": "Carriage Return",
      "1": "One",
      "": "Control",
      "😀": "Emoji (surrogate pair)",
      A: "Capital A",
      a: "lowercase a",
    };
    expect(jcsSerialize(value)).toBe(
      '{"\\r":"Carriage Return","1":"One","A":"Capital A","a":"lowercase a","":"Control","€":"Euro Sign","😀":"Emoji (surrogate pair)"}',
    );
  });

  it("serializes numbers with shortest round-trip form", () => {
    // Values from the RFC 8785 appendix number-serialization table.
    expect(jcsSerialize(1)).toBe("1");
    expect(jcsSerialize(-0)).toBe("0");
    expect(jcsSerialize(0.1)).toBe("0.1");
    expect(jcsSerialize(1e21)).toBe("1e+21");
    expect(jcsSerialize(9007199254740992)).toBe("9007199254740992");
    expect(jcsSerialize(5e-324)).toBe("5e-324");
    expect(jcsSerialize(1e23)).toBe("1e+23");
    expect(jcsSerialize(333333333.3333333)).toBe("333333333.3333333");
  });

  it("uses minimal string escaping", () => {
    expect(jcsSerialize("")).toBe('"\\b"');
    expect(jcsSerialize("")).toBe('"\\u0019"');
    expect(jcsSerialize("€$\nA'B\"\\\\\"/")).toBe(
      '"€$\\u000f\\nA\'B\\"\\\\\\\\\\"/"',
    );
  });

  it("produces no whitespace and preserves array order", () => {
    expect(jcsSerialize({ b: [2, 1], a: null })).toBe('{"a":null,"b":[2,1]}');
    expect(jcsSerialize([])).toBe("[]");
    expect(jcsSerialize({})).toBe("{}");
  });

  it("is idempotent through parse", () => {
    const value = { z: [1.5, "é", { deep: true }], a: "text" };
    const once = jcsSerialize(value);
    expect(jcsSerialize(JSON.parse(once))).toBe(once);
  });

  it("rejects everything JSON would silently reshape", () => {
    expectCanonFailure(undefined);
    expectCanonFailure(Number.NaN);
    expectCanonFailure(Number.POSITIVE_INFINITY);
    expectCanonFailure(10n as unknown);
    expectCanonFailure({ at: new Date() });
    expectCanonFailure({ m: new Map() });
    expectCanonFailure({ fn: () => 1 });
    expectCanonFailure([undefined]);
    expectCanonFailure("\ud800"); // lone high surrogate
    expectCanonFailure({ "\udfff": 1 }); // lone surrogate in key
    // eslint-disable-next-line no-sparse-arrays
    expectCanonFailure([1, , 3]);
  });

  it("accepts null-prototype objects", () => {
    const bare = Object.create(null) as Record<string, unknown>;
    bare.k = "v";
    expect(jcsSerialize(bare)).toBe('{"k":"v"}');
  });
});
