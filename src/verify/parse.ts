import { ReceiptError, type ReceiptOperation } from "../errors.js";
import {
  RECEIPT_ID_PATTERN,
  SPEC_NAME,
  SPEC_VERSION,
  TIMESTAMP_PATTERN,
  TREE_STRUCTURE,
} from "../core/constants.js";
import { isCommitmentShape } from "../core/commitment.js";
import { assertEnvelopeShape } from "../core/event.js";
import { assertHeaderShape } from "../core/header.js";
import type { ClinicalReceipt } from "../recorder/receipt.js";
import type { DisclosurePackage } from "../disclosure/disclose.js";

function toObject(
  input: unknown,
  operation: ReceiptOperation,
  what: "receipt" | "disclosure",
): unknown {
  const code = what === "receipt" ? "MALFORMED_RECEIPT" : "MALFORMED_DISCLOSURE";
  if (typeof input === "string" || input instanceof Uint8Array) {
    const text =
      typeof input === "string" ? input : new TextDecoder().decode(input);
    try {
      return JSON.parse(text) as unknown;
    } catch (error) {
      throw new ReceiptError({
        code,
        message: `${what} is not valid JSON`,
        operation,
        cause: error,
      });
    }
  }
  return input;
}

function fail(operation: ReceiptOperation, message: string): never {
  throw new ReceiptError({ code: "MALFORMED_RECEIPT", message, operation });
}

/** Structural validation. Unknown top-level fields are ignored. */
export function parseReceipt(
  input: unknown,
  operation: ReceiptOperation = "parse",
): ClinicalReceipt {
  const value = toObject(input, operation, "receipt");
  if (typeof value !== "object" || value === null) {
    fail(operation, "receipt must be an object");
  }
  const receipt = value as Record<string, unknown>;

  const spec = receipt.specification as Record<string, unknown>;
  if (typeof spec !== "object" || spec === null || spec.name !== SPEC_NAME) {
    fail(operation, "specification.name must be clinical-receipt");
  }
  if (spec.version !== SPEC_VERSION) {
    throw new ReceiptError({
      code: "UNSUPPORTED_VERSION",
      message: `this verifier speaks specification ${SPEC_VERSION}; the receipt declares ${JSON.stringify(spec.version)}`,
      operation,
    });
  }

  const meta = receipt.receipt as Record<string, unknown>;
  if (
    typeof meta !== "object" ||
    meta === null ||
    typeof meta.id !== "string" ||
    !RECEIPT_ID_PATTERN.test(meta.id) ||
    typeof meta.createdAt !== "string" ||
    !TIMESTAMP_PATTERN.test(meta.createdAt) ||
    typeof meta.finalizedAt !== "string" ||
    !TIMESTAMP_PATTERN.test(meta.finalizedAt)
  ) {
    fail(operation, "receipt.{id,createdAt,finalizedAt} are malformed");
  }

  const workflow = receipt.workflow as Record<string, unknown>;
  if (
    typeof workflow !== "object" ||
    workflow === null ||
    typeof workflow.id !== "string" ||
    workflow.id.length === 0 ||
    typeof workflow.version !== "string" ||
    workflow.version.length === 0
  ) {
    fail(operation, "workflow must carry non-empty id and version");
  }

  if (receipt.subject !== undefined) {
    const subject = receipt.subject as Record<string, unknown>;
    if (
      typeof subject !== "object" ||
      subject === null ||
      !isCommitmentShape(subject.commitment)
    ) {
      fail(operation, "subject.commitment is malformed");
    }
  }
  if (
    receipt.supersedes !== undefined &&
    (typeof receipt.supersedes !== "string" ||
      !RECEIPT_ID_PATTERN.test(receipt.supersedes))
  ) {
    fail(operation, "supersedes is not a well-formed receipt id");
  }

  if (!Array.isArray(receipt.events) || receipt.events.length < 2) {
    fail(operation, "events must contain at least run.started and run.finalized");
  }
  const seenIds = new Set<string>();
  for (let i = 0; i < receipt.events.length; i += 1) {
    const event = receipt.events[i] as Record<string, unknown>;
    assertEnvelopeShape(event, operation);
    if (event.sequence !== i) {
      fail(operation, `event at position ${i} declares sequence ${String(event.sequence)}`);
    }
    if (seenIds.has(event.id as string)) {
      fail(operation, `duplicate event id at sequence ${i}`);
    }
    for (const parent of event.parentIds as string[]) {
      if (!seenIds.has(parent)) {
        fail(operation, `event at sequence ${i} references an unknown or later parent`);
      }
    }
    if (i === 0) {
      if (event.type !== "run.started" || (event.parentIds as string[]).length !== 0) {
        fail(operation, "event 0 must be run.started with no parents");
      }
    } else if ((event.parentIds as string[]).length === 0) {
      fail(operation, `event at sequence ${i} has no parents`);
    }
    seenIds.add(event.id as string);
  }
  const last = receipt.events[receipt.events.length - 1] as Record<string, unknown>;
  if (last.type !== "run.finalized") {
    fail(operation, "the last event must be run.finalized");
  }

  const commitments = receipt.commitments as Record<string, unknown>;
  if (
    typeof commitments !== "object" ||
    commitments === null ||
    commitments.tree !== TREE_STRUCTURE ||
    typeof commitments.leafCount !== "number" ||
    commitments.leafCount !== receipt.events.length + 1
  ) {
    fail(operation, "commitments.tree/leafCount are malformed or inconsistent");
  }
  const root = commitments.root as Record<string, unknown>;
  if (
    typeof root !== "object" ||
    root === null ||
    typeof root.algorithm !== "string" ||
    root.structure !== TREE_STRUCTURE ||
    typeof root.digest !== "string" ||
    root.digest.length === 0
  ) {
    fail(operation, "commitments.root is malformed");
  }

  if (!Array.isArray(receipt.signatures)) {
    fail(operation, "signatures must be an array");
  }
  for (const record of receipt.signatures) {
    const signature = record as Record<string, unknown>;
    if (
      typeof signature !== "object" ||
      signature === null ||
      typeof signature.algorithm !== "string" ||
      typeof signature.keyId !== "string" ||
      typeof signature.signedAt !== "string" ||
      !TIMESTAMP_PATTERN.test(signature.signedAt) ||
      typeof signature.signature !== "string"
    ) {
      fail(operation, "a signature record is malformed");
    }
  }

  return receipt as unknown as ClinicalReceipt;
}

export function parseDisclosure(
  input: unknown,
  operation: ReceiptOperation = "parse",
): DisclosurePackage {
  const value = toObject(input, operation, "disclosure");
  const failDisclosure = (message: string): never => {
    throw new ReceiptError({ code: "MALFORMED_DISCLOSURE", message, operation });
  };
  if (typeof value !== "object" || value === null) {
    failDisclosure("disclosure must be an object");
  }
  const pkg = value as Record<string, unknown>;
  const spec = pkg.specification as Record<string, unknown>;
  if (typeof spec !== "object" || spec === null || spec.name !== SPEC_NAME) {
    failDisclosure("specification.name must be clinical-receipt");
  }
  if (spec.version !== SPEC_VERSION) {
    throw new ReceiptError({
      code: "UNSUPPORTED_VERSION",
      message: `this verifier speaks specification ${SPEC_VERSION}; the disclosure declares ${JSON.stringify(spec.version)}`,
      operation,
    });
  }
  const meta = pkg.disclosure as Record<string, unknown>;
  if (
    typeof meta !== "object" ||
    meta === null ||
    typeof meta.receiptId !== "string" ||
    !RECEIPT_ID_PATTERN.test(meta.receiptId) ||
    typeof meta.root !== "object" ||
    meta.root === null
  ) {
    failDisclosure("disclosure.{receiptId,root} are malformed");
  }
  const header = pkg.header as Record<string, unknown>;
  if (typeof header !== "object" || header === null) {
    failDisclosure("header is required");
  }
  assertHeaderShape(header.value, operation);
  const events: unknown = pkg.events;
  if (!Array.isArray(events)) {
    failDisclosure("events must be an array");
  }
  for (const entry of events as unknown[]) {
    if (typeof entry !== "object" || entry === null) {
      failDisclosure("a disclosed event entry is malformed");
    }
    const disclosed = entry as Record<string, unknown>;
    assertEnvelopeShape(disclosed.envelope, operation);
  }
  if (pkg.leaves !== undefined && !Array.isArray(pkg.leaves)) {
    failDisclosure("leaves must be an array when present");
  }
  if (!Array.isArray(pkg.signatures)) {
    failDisclosure("signatures must be an array");
  }
  return pkg as unknown as DisclosurePackage;
}
