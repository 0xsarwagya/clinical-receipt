import { ReceiptError, type ReceiptOperation } from "../errors.js";
import { HASH_SHA256, TAG_TREE_PREFIX, TREE_STRUCTURE } from "./constants.js";
import {
  bytesEqual,
  concatBytes,
  decodeBase64Url,
  encodeBase64Url,
  frame,
  utf8Bytes,
} from "./encoding.js";
import { resolveHash, type HashAlgorithm } from "./hash.js";

export interface InclusionProof {
  structure: string;
  leafIndex: number;
  treeSize: number;
  path: string[];
}

function ctxBytes(receiptId: string): Uint8Array<ArrayBuffer> {
  return utf8Bytes(TAG_TREE_PREFIX + receiptId);
}

/** leafHash = H( f(ctx) || 0x00 || f(content) ) — spec/1.0/tree.md §2. */
export async function leafHash(
  content: Uint8Array<ArrayBuffer>,
  receiptId: string,
  hash: HashAlgorithm,
): Promise<Uint8Array<ArrayBuffer>> {
  return hash.digest(
    concatBytes([
      frame([ctxBytes(receiptId)]),
      new Uint8Array([0x00]),
      frame([content]),
    ]),
  );
}

/** nodeHash = H( f(ctx) || 0x01 || left || right ) — fixed-width children. */
export async function nodeHash(
  left: Uint8Array<ArrayBuffer>,
  right: Uint8Array<ArrayBuffer>,
  receiptId: string,
  hash: HashAlgorithm,
): Promise<Uint8Array<ArrayBuffer>> {
  return hash.digest(
    concatBytes([frame([ctxBytes(receiptId)]), new Uint8Array([0x01]), left, right]),
  );
}

/** Largest power of two strictly less than n (n ≥ 2). */
function split(n: number): number {
  let k = 1;
  while (k * 2 < n) {
    k *= 2;
  }
  return k;
}

/** RFC 6962 MTH over leaf CONTENTS (not pre-hashed leaves). */
export async function merkleRoot(
  leaves: readonly Uint8Array<ArrayBuffer>[],
  receiptId: string,
  hash?: HashAlgorithm,
  operation: ReceiptOperation = "finalize",
): Promise<Uint8Array<ArrayBuffer>> {
  const algorithm = hash ?? resolveHash(HASH_SHA256, operation);
  if (leaves.length === 0) {
    throw new ReceiptError({
      code: "INVALID_ARGUMENT",
      message: "a receipt tree has at least one leaf",
      operation,
    });
  }
  const subtree = async (
    slice: readonly Uint8Array<ArrayBuffer>[],
  ): Promise<Uint8Array<ArrayBuffer>> => {
    const first = slice[0];
    if (slice.length === 1 && first !== undefined) {
      return leafHash(first, receiptId, algorithm);
    }
    const k = split(slice.length);
    const left = await subtree(slice.slice(0, k));
    const right = await subtree(slice.slice(k));
    return nodeHash(left, right, receiptId, algorithm);
  };
  return subtree(leaves);
}

/** RFC 6962 §2.1.1 audit path for the leaf at `index`. */
export async function proveInclusion(
  leaves: readonly Uint8Array<ArrayBuffer>[],
  index: number,
  receiptId: string,
  hash?: HashAlgorithm,
): Promise<InclusionProof> {
  const algorithm = hash ?? resolveHash(HASH_SHA256, "disclose");
  if (!Number.isSafeInteger(index) || index < 0 || index >= leaves.length) {
    throw new ReceiptError({
      code: "INVALID_ARGUMENT",
      message: `leaf index ${index} is outside the tree`,
      operation: "disclose",
    });
  }
  const path: string[] = [];
  const walk = async (
    slice: readonly Uint8Array<ArrayBuffer>[],
    target: number,
  ): Promise<Uint8Array<ArrayBuffer>> => {
    const first = slice[0];
    if (slice.length === 1 && first !== undefined) {
      return leafHash(first, receiptId, algorithm);
    }
    const k = split(slice.length);
    if (target < k) {
      const left = await walk(slice.slice(0, k), target);
      const right = await subtreeHash(slice.slice(k), receiptId, algorithm);
      path.push(encodeBase64Url(right));
      return nodeHash(left, right, receiptId, algorithm);
    }
    const left = await subtreeHash(slice.slice(0, k), receiptId, algorithm);
    const right = await walk(slice.slice(k), target - k);
    path.push(encodeBase64Url(left));
    return nodeHash(left, right, receiptId, algorithm);
  };
  await walk(leaves, index);
  return {
    structure: TREE_STRUCTURE,
    leafIndex: index,
    treeSize: leaves.length,
    path,
  };
}

async function subtreeHash(
  slice: readonly Uint8Array<ArrayBuffer>[],
  receiptId: string,
  algorithm: HashAlgorithm,
): Promise<Uint8Array<ArrayBuffer>> {
  const first = slice[0];
  if (slice.length === 1 && first !== undefined) {
    return leafHash(first, receiptId, algorithm);
  }
  const k = split(slice.length);
  const left = await subtreeHash(slice.slice(0, k), receiptId, algorithm);
  const right = await subtreeHash(slice.slice(k), receiptId, algorithm);
  return nodeHash(left, right, receiptId, algorithm);
}

/**
 * Verifies an audit path — spec/1.0/tree.md §4. Returns false on any
 * deviation; throws only for malformed proof structure.
 */
export async function verifyInclusionProof(
  content: Uint8Array<ArrayBuffer>,
  proof: InclusionProof,
  root: Uint8Array<ArrayBuffer>,
  receiptId: string,
  hash?: HashAlgorithm,
): Promise<boolean> {
  const algorithm = hash ?? resolveHash(HASH_SHA256, "verifyDisclosure");
  if (
    proof.structure !== TREE_STRUCTURE ||
    !Number.isSafeInteger(proof.leafIndex) ||
    !Number.isSafeInteger(proof.treeSize) ||
    proof.leafIndex < 0 ||
    proof.treeSize < 1 ||
    proof.leafIndex >= proof.treeSize ||
    !Array.isArray(proof.path)
  ) {
    throw new ReceiptError({
      code: "MALFORMED_PROOF",
      message: "inclusion proof structure is malformed",
      operation: "verifyDisclosure",
    });
  }

  // Consume the path top-down positionally, then fold bottom-up.
  const directions: Array<{ sibling: Uint8Array<ArrayBuffer>; siblingOnRight: boolean }> = [];
  let index = proof.leafIndex;
  let size = proof.treeSize;
  for (let i = proof.path.length - 1; i >= 0; i -= 1) {
    if (size === 1) {
      return false; // path longer than the tree height
    }
    const encoded = proof.path[i];
    if (typeof encoded !== "string") {
      throw new ReceiptError({
        code: "MALFORMED_PROOF",
        message: "inclusion proof path entries must be strings",
        operation: "verifyDisclosure",
      });
    }
    let sibling: Uint8Array<ArrayBuffer>;
    try {
      sibling = decodeBase64Url(encoded);
    } catch (error) {
      throw new ReceiptError({
        code: "MALFORMED_PROOF",
        message: "inclusion proof path entry is not valid base64url",
        operation: "verifyDisclosure",
        cause: error,
      });
    }
    if (sibling.length !== 32) {
      return false;
    }
    const k = split(size);
    if (index < k) {
      directions.push({ sibling, siblingOnRight: true });
      size = k;
    } else {
      directions.push({ sibling, siblingOnRight: false });
      index -= k;
      size -= k;
    }
  }
  if (size !== 1) {
    return false; // path shorter than the tree height
  }

  let head = await leafHash(content, receiptId, algorithm);
  for (let i = directions.length - 1; i >= 0; i -= 1) {
    const step = directions[i];
    if (step === undefined) {
      return false;
    }
    head = step.siblingOnRight
      ? await nodeHash(head, step.sibling, receiptId, algorithm)
      : await nodeHash(step.sibling, head, receiptId, algorithm);
  }
  return bytesEqual(head, root);
}
