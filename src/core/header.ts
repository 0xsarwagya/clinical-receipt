import { ReceiptError, type ReceiptOperation } from "../errors.js";
import {
  HASH_SHA256,
  RECEIPT_ID_PATTERN,
  SPEC_NAME,
  SPEC_VERSION,
  TIMESTAMP_PATTERN,
} from "./constants.js";
import { jcsBytes } from "./jcs.js";
import { isCommitmentShape, type Commitment } from "./commitment.js";

/** The header-leaf object — spec/1.0/tree.md §1, leaf 0. */
export interface ReceiptHeader {
  type: "clinical-receipt-header";
  specification: { name: string; version: string };
  receiptId: string;
  createdAt: string;
  finalizedAt: string;
  workflow: { id: string; version: string };
  subject?: { commitment: Commitment };
  supersedes?: string;
  hashAlgorithm: string;
  eventCount: number;
}

export function buildHeader(input: {
  receiptId: string;
  createdAt: string;
  finalizedAt: string;
  workflow: { id: string; version: string };
  subject?: { commitment: Commitment };
  supersedes?: string;
  hashAlgorithm?: string;
  eventCount: number;
}): ReceiptHeader {
  const header: ReceiptHeader = {
    type: "clinical-receipt-header",
    specification: { name: SPEC_NAME, version: SPEC_VERSION },
    receiptId: input.receiptId,
    createdAt: input.createdAt,
    finalizedAt: input.finalizedAt,
    workflow: { id: input.workflow.id, version: input.workflow.version },
    hashAlgorithm: input.hashAlgorithm ?? HASH_SHA256,
    eventCount: input.eventCount,
  };
  if (input.subject !== undefined) {
    header.subject = { commitment: input.subject.commitment };
  }
  if (input.supersedes !== undefined) {
    header.supersedes = input.supersedes;
  }
  return header;
}

/** JCS bytes of the header — the content of leaf 0. */
export function headerLeafBytes(header: ReceiptHeader): Uint8Array<ArrayBuffer> {
  // Rebuild with a fixed field set so extra properties can never ride in.
  return jcsBytes(buildHeader(header));
}

export function assertHeaderShape(
  value: unknown,
  operation: ReceiptOperation,
): asserts value is ReceiptHeader {
  const fail = (message: string): never => {
    throw new ReceiptError({ code: "MALFORMED_RECEIPT", message, operation });
  };
  if (typeof value !== "object" || value === null) {
    fail("header must be an object");
  }
  const header = value as Record<string, unknown>;
  if (header.type !== "clinical-receipt-header") {
    fail("header.type must be clinical-receipt-header");
  }
  const spec = header.specification as Record<string, unknown>;
  if (
    typeof spec !== "object" ||
    spec === null ||
    spec.name !== SPEC_NAME ||
    typeof spec.version !== "string"
  ) {
    fail("header.specification is malformed");
  }
  if (
    typeof header.receiptId !== "string" ||
    !RECEIPT_ID_PATTERN.test(header.receiptId)
  ) {
    fail("header.receiptId is not a well-formed receipt id");
  }
  for (const field of ["createdAt", "finalizedAt"] as const) {
    if (
      typeof header[field] !== "string" ||
      !TIMESTAMP_PATTERN.test(header[field] as string)
    ) {
      fail(`header.${field} must be an RFC 3339 UTC millisecond timestamp`);
    }
  }
  const workflow = header.workflow as Record<string, unknown>;
  if (
    typeof workflow !== "object" ||
    workflow === null ||
    typeof workflow.id !== "string" ||
    workflow.id.length === 0 ||
    typeof workflow.version !== "string" ||
    workflow.version.length === 0
  ) {
    fail("header.workflow must carry non-empty id and version");
  }
  if (header.subject !== undefined) {
    const subject = header.subject as Record<string, unknown>;
    if (
      typeof subject !== "object" ||
      subject === null ||
      !isCommitmentShape(subject.commitment)
    ) {
      fail("header.subject.commitment is malformed");
    }
  }
  if (
    header.supersedes !== undefined &&
    (typeof header.supersedes !== "string" ||
      !RECEIPT_ID_PATTERN.test(header.supersedes))
  ) {
    fail("header.supersedes is not a well-formed receipt id");
  }
  if (typeof header.hashAlgorithm !== "string" || header.hashAlgorithm.length === 0) {
    fail("header.hashAlgorithm must be a non-empty string");
  }
  if (
    typeof header.eventCount !== "number" ||
    !Number.isSafeInteger(header.eventCount) ||
    header.eventCount < 2
  ) {
    fail("header.eventCount must be an integer ≥ 2");
  }
}
