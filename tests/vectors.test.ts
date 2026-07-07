import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { jcsSerialize } from "../src/core/jcs.js";
import { canonicalize } from "../src/core/canonicalize.js";
import { commitPayload } from "../src/core/commitment.js";
import { sha256 } from "../src/core/hash.js";
import {
  bytesToHex,
  decodeBase64Url,
  encodeBase64Url,
  hexToBytes,
} from "../src/core/encoding.js";
import {
  merkleRoot,
  proveInclusion,
  verifyInclusionProof,
  type InclusionProof,
} from "../src/core/merkle.js";
import { buildHeader, headerLeafBytes, type ReceiptHeader } from "../src/core/header.js";
import { importVerificationKey } from "../src/signing/webcrypto.js";
import { verifyReceipt } from "../src/verify/receipt.js";
import { verifyDisclosure } from "../src/verify/disclosure.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const VECTORS = path.resolve(__dirname, "..", "spec", "1.0", "vectors");

function load<T>(name: string): T {
  return JSON.parse(readFileSync(path.join(VECTORS, name), "utf8")) as T;
}

describe("spec vectors — pins", () => {
  it("jcs recomputes byte-exact", () => {
    const v = load<{ input: unknown; bytesUtf8: string; bytesHex: string }>(
      "jcs.json",
    );
    const bytes = jcsSerialize(v.input);
    expect(bytes).toBe(v.bytesUtf8);
    expect(bytesToHex(new TextEncoder().encode(bytes) as Uint8Array<ArrayBuffer>)).toBe(
      v.bytesHex,
    );
  });

  it("commitment recomputes byte-exact", async () => {
    const v = load<{
      input: unknown;
      canonicalization: string;
      saltHex: string;
      commitment: { algorithm: string; canonicalization: string; digest: string };
    }>("commitment.json");
    const bytes = canonicalize(v.canonicalization, v.input);
    const recomputed = await commitPayload(bytes, {
      canonicalization: v.canonicalization,
      salt: hexToBytes(v.saltHex),
      hash: sha256,
      operation: "commit",
    });
    expect(recomputed).toEqual(v.commitment);
  });

  it("merkle tree recomputes root and every inclusion proof", async () => {
    const v = load<{
      receiptId: string;
      leafCount: number;
      rootBytes: string;
      proofs: Array<{
        leafIndex: number;
        leafBytesHex: string;
        proof: InclusionProof;
      }>;
    }>("tree.json");
    const leaves = v.proofs.map(
      (p) => hexToBytes(p.leafBytesHex) as Uint8Array<ArrayBuffer>,
    );
    const root = await merkleRoot(leaves, v.receiptId, sha256, "verifyReceipt");
    expect(encodeBase64Url(root)).toBe(v.rootBytes);

    for (const entry of v.proofs) {
      // The pinned proof structure must recompute.
      const rebuilt = await proveInclusion(
        leaves,
        entry.leafIndex,
        v.receiptId,
        sha256,
      );
      expect(rebuilt).toEqual(entry.proof);
      // And it must verify.
      const ok = await verifyInclusionProof(
        hexToBytes(entry.leafBytesHex) as Uint8Array<ArrayBuffer>,
        entry.proof,
        root,
        v.receiptId,
        sha256,
      );
      expect(ok).toBe(true);
    }
  });

  it("header leaf recomputes byte-exact", () => {
    const v = load<{
      header: ReceiptHeader;
      bytesBase64Url: string;
      bytesHex: string;
    }>("header.json");
    const rebuilt = buildHeader(v.header);
    // Round-tripping through buildHeader normalises the object; the
    // leaf bytes are what actually get committed.
    const leaf = headerLeafBytes(rebuilt);
    expect(encodeBase64Url(leaf)).toBe(v.bytesBase64Url);
    expect(bytesToHex(leaf)).toBe(v.bytesHex);
  });

  it("receipt-minimal verifies", async () => {
    const receipt = load<import("../src/recorder/receipt.js").ClinicalReceipt>(
      "receipt-minimal.json",
    );
    const report = await verifyReceipt(receipt);
    expect(report.integrity.root).toBe("verified");
    expect(report.integrity.events.failed).toHaveLength(0);
  });

  it("signature-ed25519 verifies against its pinned public JWK", async () => {
    const v = load<{
      publicKeyJwk: JsonWebKey;
      payloadBase64Url: string;
      signatureBase64Url: string;
    }>("signature-ed25519.json");
    const key = await importVerificationKey(v.publicKeyJwk);
    const payload = decodeBase64Url(v.payloadBase64Url);
    const signature = decodeBase64Url(v.signatureBase64Url);
    const ok = await key.verify(payload, signature);
    expect(ok).toBe(true);
  });

  it("disclosure-basic verifies", async () => {
    const pkg = load<import("../src/disclosure/disclose.js").DisclosurePackage>(
      "disclosure-basic.json",
    );
    const report = await verifyDisclosure(pkg);
    expect(report.ok).toBe(true);
    expect(report.disclosures.cryptographicallyConsistent).toBe(true);
  });
});
