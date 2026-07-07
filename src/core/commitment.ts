import type { ReceiptOperation } from "../errors.js";
import { HASH_SHA256, TAG_PAYLOAD } from "./constants.js";
import { encodeBase64Url, frame, utf8Bytes } from "./encoding.js";
import { resolveHash, type HashAlgorithm } from "./hash.js";

/** The commitment record shape used throughout the receipt. */
export interface Commitment {
  algorithm: string;
  canonicalization: string;
  digest: string;
}

/**
 * Payload commitment per spec/1.0/commitments.md §3:
 *
 *   SHA-256( f(tag) || f(algorithm) || f(canonicalization) || f(salt) || f(canonicalBytes) )
 *
 * The salt is 16 random bytes by default (callers supply it); an absent
 * salt is the empty field — permitted for vectors, dangerous for PHI.
 */
export async function commitPayload(
  canonicalBytes: Uint8Array<ArrayBuffer>,
  options: {
    canonicalization: string;
    salt: Uint8Array<ArrayBuffer> | null;
    hash?: HashAlgorithm;
    operation?: ReceiptOperation;
  },
): Promise<Commitment> {
  const hash =
    options.hash ?? resolveHash(HASH_SHA256, options.operation ?? "commit");
  const message = frame([
    utf8Bytes(TAG_PAYLOAD),
    utf8Bytes(hash.id),
    utf8Bytes(options.canonicalization),
    options.salt ?? new Uint8Array(0),
    canonicalBytes,
  ]);
  return {
    algorithm: hash.id,
    canonicalization: options.canonicalization,
    digest: encodeBase64Url(await hash.digest(message)),
  };
}

export function commitmentsEqual(a: Commitment, b: Commitment): boolean {
  return (
    a.algorithm === b.algorithm &&
    a.canonicalization === b.canonicalization &&
    a.digest === b.digest
  );
}

export function isCommitmentShape(value: unknown): value is Commitment {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    typeof record.algorithm === "string" &&
    record.algorithm.length > 0 &&
    typeof record.canonicalization === "string" &&
    record.canonicalization.length > 0 &&
    typeof record.digest === "string" &&
    record.digest.length > 0
  );
}
