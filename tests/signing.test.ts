import { describe, expect, it } from "vitest";

import {
  createEcdsaP256Signer,
  createEd25519Signer,
  exportVerificationKey,
  importVerificationKey,
} from "../src/signing/webcrypto.js";
import { signaturePayloadBytes } from "../src/signing/signer.js";
import { decodeBase64Url, hexToBytes } from "../src/core/encoding.js";
import { buildFullRun } from "./fixtures.js";

// RFC 8032 §7.1 TEST 1 — the house fixture key.
const ED25519_PKCS8_HEX =
  "302e020100300506032b6570042204209d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60";
const ED25519_PUBLIC_HEX =
  "d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a";

describe("signature payload bytes", () => {
  it("are deterministic and cover the tuple", () => {
    const input = {
      receiptId: `rcpt_1_${"ab".repeat(16)}`,
      root: {
        algorithm: "sha-256",
        structure: "clinical-receipt-merkle@1",
        digest: "AAAA",
      },
      algorithm: "ed25519",
      keyId: `key_1_${"cd".repeat(16)}`,
      signedAt: "2026-07-07T10:16:00.000Z",
    };
    const a = signaturePayloadBytes(input);
    const b = signaturePayloadBytes(input);
    expect(a).toEqual(b);
    const c = signaturePayloadBytes({ ...input, signedAt: "2026-07-07T10:16:00.001Z" });
    expect(c).not.toEqual(a);
    const d = signaturePayloadBytes({ ...input, algorithm: "ecdsa-p256-sha256" });
    expect(d).not.toEqual(a); // algorithm confusion is unrepresentable
  });
});

describe("webcrypto signers", () => {
  it("ed25519: sign → verify round-trips; tampering fails (verify-direction only)", async () => {
    const signer = await createEd25519Signer({
      pkcs8: hexToBytes(ED25519_PKCS8_HEX),
      publicKeyRaw: hexToBytes(ED25519_PUBLIC_HEX),
    });
    expect(signer.algorithm).toBe("ed25519");
    expect(signer.keyId).toMatch(/^key_1_[0-9a-f]{32}$/);

    const receipt = await (await buildFullRun()).finalize({ signer });
    expect(receipt.signatures).toHaveLength(1);
    const record = receipt.signatures[0];
    if (!record) {
      expect.fail("missing signature record");
    }

    const key = await importVerificationKey(exportVerificationKey(signer));
    expect(key.keyId).toBe(signer.keyId);
    const payload = signaturePayloadBytes({
      receiptId: receipt.receipt.id,
      root: receipt.commitments.root,
      algorithm: record.algorithm,
      keyId: record.keyId,
      signedAt: record.signedAt,
    });
    expect(await key.verify(payload, decodeBase64Url(record.signature))).toBe(true);

    const tampered = new Uint8Array(payload);
    tampered[tampered.length - 1] = (tampered[tampered.length - 1] ?? 0) ^ 0xff;
    expect(await key.verify(tampered, decodeBase64Url(record.signature))).toBe(false);
  });

  it("ecdsa-p256: generated key round-trips with P1363 signatures", async () => {
    const signer = await createEcdsaP256Signer({ generate: true });
    const receipt = await (await buildFullRun()).finalize({ signer });
    const record = receipt.signatures[0];
    if (!record) {
      expect.fail("missing signature record");
    }
    // P1363: exactly 64 bytes, never DER.
    expect(decodeBase64Url(record.signature)).toHaveLength(64);

    const key = await importVerificationKey(exportVerificationKey(signer));
    const payload = signaturePayloadBytes({
      receiptId: receipt.receipt.id,
      root: receipt.commitments.root,
      algorithm: record.algorithm,
      keyId: record.keyId,
      signedAt: record.signedAt,
    });
    expect(await key.verify(payload, decodeBase64Url(record.signature))).toBe(true);
  });

  it("a signature over one root never verifies another", async () => {
    const signer = await createEd25519Signer({
      pkcs8: hexToBytes(ED25519_PKCS8_HEX),
      publicKeyRaw: hexToBytes(ED25519_PUBLIC_HEX),
    });
    const receipt = await (await buildFullRun()).finalize({ signer });
    const record = receipt.signatures[0];
    if (!record) {
      expect.fail("missing signature record");
    }
    const key = await importVerificationKey(exportVerificationKey(signer));
    const foreign = signaturePayloadBytes({
      receiptId: receipt.receipt.id,
      root: { ...receipt.commitments.root, digest: "BBBB" },
      algorithm: record.algorithm,
      keyId: record.keyId,
      signedAt: record.signedAt,
    });
    expect(await key.verify(foreign, decodeBase64Url(record.signature))).toBe(false);
  });
});
