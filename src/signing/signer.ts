import { ReceiptError } from "../errors.js";
import {
  HASH_SHA256,
  SIGNATURE_PROFILE,
  SPEC_NAME,
  SPEC_VERSION,
  TAG_KEYID,
  TAG_SIGNATURE,
} from "../core/constants.js";
import {
  bytesToHex,
  encodeBase64Url,
  frame,
  utf8Bytes,
} from "../core/encoding.js";
import { jcsBytes } from "../core/jcs.js";
import { resolveHash } from "../core/hash.js";
import type { ClinicalReceipt } from "../recorder/receipt.js";

export interface ReceiptSigner {
  readonly algorithm: string;
  readonly keyId: string;
  /** Optional embedded verification key — reported as self-attested. */
  readonly publicKeyJwk?: JsonWebKey;
  sign(payload: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>>;
}

export interface SignatureRecord {
  payloadProfile: string;
  algorithm: string;
  keyId: string;
  publicKeyJwk?: JsonWebKey;
  signedAt: string;
  signature: string;
  /** Reserved for future RFC 3161 / transparency-log countersignatures. */
  timestamps: unknown[];
}

/** The signed bytes — spec/1.0/signatures.md §1. */
export function signaturePayloadBytes(input: {
  receiptId: string;
  root: { algorithm: string; structure: string; digest: string };
  algorithm: string;
  keyId: string;
  signedAt: string;
}): Uint8Array<ArrayBuffer> {
  const payload = {
    payloadProfile: SIGNATURE_PROFILE,
    specification: { name: SPEC_NAME, version: SPEC_VERSION },
    receiptId: input.receiptId,
    root: {
      algorithm: input.root.algorithm,
      structure: input.root.structure,
      digest: input.root.digest,
    },
    signature: { algorithm: input.algorithm, keyId: input.keyId },
    signedAt: input.signedAt,
  };
  return frame([utf8Bytes(TAG_SIGNATURE), jcsBytes(payload)]);
}

export async function createSignatureRecord(
  receipt: ClinicalReceipt,
  signer: ReceiptSigner,
  signedAt: string,
): Promise<SignatureRecord> {
  if (
    typeof signer?.algorithm !== "string" ||
    typeof signer.keyId !== "string" ||
    typeof signer.sign !== "function"
  ) {
    throw new ReceiptError({
      code: "INVALID_ARGUMENT",
      message: "signer must provide algorithm, keyId, and sign()",
      operation: "sign",
    });
  }
  const payload = signaturePayloadBytes({
    receiptId: receipt.receipt.id,
    root: receipt.commitments.root,
    algorithm: signer.algorithm,
    keyId: signer.keyId,
    signedAt,
  });
  let signature: Uint8Array<ArrayBuffer>;
  try {
    signature = await signer.sign(payload);
  } catch (error) {
    throw new ReceiptError({
      code: "SIGNING_FAILED",
      message: `signer ${signer.keyId} failed to sign the receipt`,
      operation: "sign",
      cause: error,
    });
  }
  return {
    payloadProfile: SIGNATURE_PROFILE,
    algorithm: signer.algorithm,
    keyId: signer.keyId,
    ...(signer.publicKeyJwk !== undefined
      ? { publicKeyJwk: signer.publicKeyJwk }
      : {}),
    signedAt,
    signature: encodeBase64Url(signature),
    timestamps: [],
  };
}

/** keyId = key_1_ + hex of the first 16 digest bytes — signatures.md §4. */
export async function deriveKeyId(
  publicKeyBytes: Uint8Array<ArrayBuffer>,
): Promise<string> {
  const hash = resolveHash(HASH_SHA256, "importKey");
  const digest = await hash.digest(
    frame([utf8Bytes(TAG_KEYID), publicKeyBytes]),
  );
  return `key_1_${bytesToHex(digest.slice(0, 16))}`;
}
