import { describe, expect, it } from "vitest";

import {
  bytesEqual,
  bytesToHex,
  decodeBase64Url,
  encodeBase64Url,
  frame,
  hexToBytes,
  utf8Bytes,
} from "../src/core/encoding.js";

describe("frame", () => {
  it("length-prefixes every field with uint32 big-endian", () => {
    const output = frame([utf8Bytes("ab"), utf8Bytes("c"), new Uint8Array(0)]);
    expect(Array.from(output)).toEqual([
      0, 0, 0, 2, 0x61, 0x62,
      0, 0, 0, 1, 0x63,
      0, 0, 0, 0,
    ]);
  });

  it("cannot collide across field boundaries", () => {
    const a = frame([utf8Bytes("ab"), utf8Bytes("c")]);
    const b = frame([utf8Bytes("a"), utf8Bytes("bc")]);
    const c = frame([utf8Bytes("abc")]);
    expect(bytesEqual(a, b)).toBe(false);
    expect(bytesEqual(a, c)).toBe(false);
    expect(bytesEqual(b, c)).toBe(false);
  });
});

describe("hex", () => {
  it("round-trips", () => {
    const bytes = new Uint8Array(256).map((_, i) => i);
    expect(hexToBytes(bytesToHex(bytes))).toEqual(bytes);
  });
});

describe("base64url", () => {
  it("round-trips every byte value and length remainder", () => {
    for (const length of [0, 1, 2, 3, 31, 32, 33]) {
      const bytes = new Uint8Array(length).map((_, i) => (i * 31 + 7) % 256);
      const encoded = encodeBase64Url(bytes);
      expect(encoded).not.toMatch(/[+/=]/);
      expect(decodeBase64Url(encoded)).toEqual(bytes);
    }
  });

  it("rejects malformed input", () => {
    expect(() => decodeBase64Url("ab+c")).toThrow(SyntaxError);
    expect(() => decodeBase64Url("abc=")).toThrow(SyntaxError);
    expect(() => decodeBase64Url("a")).toThrow(SyntaxError);
  });
});

describe("bytesEqual", () => {
  it("compares content, not identity", () => {
    expect(bytesEqual(new Uint8Array([1, 2]), new Uint8Array([1, 2]))).toBe(true);
    expect(bytesEqual(new Uint8Array([1, 2]), new Uint8Array([1, 3]))).toBe(false);
    expect(bytesEqual(new Uint8Array([1]), new Uint8Array([1, 0]))).toBe(false);
  });
});
