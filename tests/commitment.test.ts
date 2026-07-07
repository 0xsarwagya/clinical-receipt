import { describe, expect, it } from "vitest";

import { canonicalize } from "../src/core/canonicalize.js";
import { commitPayload } from "../src/core/commitment.js";
import { utf8Bytes } from "../src/core/encoding.js";

describe("commitPayload", () => {
  it("is deterministic for identical inputs", async () => {
    const bytes = canonicalize("jcs@1", { code: "I50.9", system: "ICD-10" });
    const salt = new Uint8Array(16).fill(7);
    const a = await commitPayload(bytes, { canonicalization: "jcs@1", salt });
    const b = await commitPayload(bytes, { canonicalization: "jcs@1", salt });
    expect(a).toEqual(b);
    expect(a.algorithm).toBe("sha-256");
  });

  it("differs under different salts — the hiding property", async () => {
    const bytes = canonicalize("jcs@1", { code: "I50.9" });
    const a = await commitPayload(bytes, {
      canonicalization: "jcs@1",
      salt: new Uint8Array(16).fill(1),
    });
    const b = await commitPayload(bytes, {
      canonicalization: "jcs@1",
      salt: new Uint8Array(16).fill(2),
    });
    expect(a.digest).not.toBe(b.digest);
  });

  it("differs between salted and unsalted", async () => {
    const bytes = utf8Bytes("text");
    const salted = await commitPayload(bytes, {
      canonicalization: "utf8@1",
      salt: new Uint8Array(16),
    });
    const unsalted = await commitPayload(bytes, {
      canonicalization: "utf8@1",
      salt: null,
    });
    expect(salted.digest).not.toBe(unsalted.digest);
  });

  it("binds the canonicalization identifier into the digest", async () => {
    const bytes = utf8Bytes("text");
    const a = await commitPayload(bytes, { canonicalization: "utf8@1", salt: null });
    const b = await commitPayload(bytes, { canonicalization: "utf8-nfc@1", salt: null });
    expect(a.digest).not.toBe(b.digest);
  });

  it("canonicalization profiles disagree exactly where they should", () => {
    const composed = "é"; // U+00E9
    const decomposed = "é";
    expect(canonicalize("utf8@1", composed)).not.toEqual(
      canonicalize("utf8@1", decomposed),
    );
    expect(canonicalize("utf8-nfc@1", composed)).toEqual(
      canonicalize("utf8-nfc@1", decomposed),
    );
  });
});
