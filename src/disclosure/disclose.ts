import { ReceiptError } from "../errors.js";
import { HASH_SHA256, SPEC_NAME, SPEC_VERSION } from "../core/constants.js";
import { bytesToHex, decodeBase64Url, encodeBase64Url } from "../core/encoding.js";
import type { EventEnvelope, PayloadDescriptor } from "../core/event.js";
import { buildHeader, headerLeafBytes, type ReceiptHeader } from "../core/header.js";
import { resolveHash } from "../core/hash.js";
import { proveInclusion, type InclusionProof } from "../core/merkle.js";
import type { ClinicalReceipt } from "../recorder/receipt.js";
import type { SignatureRecord } from "../signing/signer.js";

export interface DiscloseOptions {
  /**
   * Which events to reveal: exact event ids, exact types, or `*`-glob
   * patterns over types (e.g. "model.*", "output.*").
   */
  events: string[];
  /**
   * Which of the disclosed events get their payloads mode-downgraded
   * (embedded → commitment). Same pattern language.
   */
  redact?: string[];
  /** Include all leaf digests so verifiers can prove completeness. Default true. */
  includeLeaves?: boolean;
  random?: (byteLength: number) => Uint8Array<ArrayBuffer>;
  clock?: () => Date;
}

export interface DisclosedEvent {
  envelope: EventEnvelope;
  proof: InclusionProof;
}

export interface DisclosurePackage {
  specification: { name: string; version: string };
  disclosure: {
    id: string;
    createdAt: string;
    receiptId: string;
    root: { algorithm: string; structure: string; digest: string };
  };
  header: { value: ReceiptHeader; proof: InclusionProof };
  events: DisclosedEvent[];
  leaves?: string[];
  signatures: SignatureRecord[];
}

function matches(patterns: readonly string[], event: EventEnvelope): boolean {
  for (const pattern of patterns) {
    if (pattern === event.id || pattern === event.type || pattern === "*") {
      return true;
    }
    if (pattern.endsWith("*") && event.type.startsWith(pattern.slice(0, -1))) {
      return true;
    }
  }
  return false;
}

/**
 * embedded → commitment: strip the presentation region, keep the proof.
 * Commitment and reference payloads carry nothing strippable (ref is
 * committed and cannot be hidden without breaking the envelope).
 */
function downgrade(payload: PayloadDescriptor): PayloadDescriptor {
  if (payload.mode !== "embedded") {
    return payload;
  }
  return {
    mode: "commitment",
    commitment: payload.commitment,
    ...(payload.mediaType !== undefined ? { mediaType: payload.mediaType } : {}),
  };
}

export async function disclose(
  receipt: ClinicalReceipt,
  options: DiscloseOptions,
): Promise<DisclosurePackage> {
  if (!Array.isArray(options?.events) || options.events.length === 0) {
    throw new ReceiptError({
      code: "INVALID_ARGUMENT",
      message: "disclose needs at least one event pattern",
      operation: "disclose",
    });
  }
  const hash = resolveHash(receipt.commitments.root.algorithm, "disclose");
  const random =
    options.random ??
    ((n: number) => {
      const bytes = new Uint8Array(n);
      globalThis.crypto.getRandomValues(bytes);
      return bytes;
    });
  const clock = options.clock ?? (() => new Date());

  const header = buildHeader({
    receiptId: receipt.receipt.id,
    createdAt: receipt.receipt.createdAt,
    finalizedAt: receipt.receipt.finalizedAt,
    workflow: receipt.workflow,
    ...(receipt.subject !== undefined ? { subject: receipt.subject } : {}),
    ...(receipt.supersedes !== undefined
      ? { supersedes: receipt.supersedes }
      : {}),
    hashAlgorithm: receipt.commitments.root.algorithm,
    eventCount: receipt.events.length,
  });
  const leaves: Uint8Array<ArrayBuffer>[] = [
    headerLeafBytes(header),
    ...receipt.events.map((event) => decodeBase64Url(event.commitment.digest)),
  ];

  const selected = receipt.events.filter((event) =>
    matches(options.events, event),
  );
  if (selected.length === 0) {
    throw new ReceiptError({
      code: "INVALID_ARGUMENT",
      message: "no events matched the disclosure patterns",
      operation: "disclose",
    });
  }
  const redactPatterns = options.redact ?? [];

  const events: DisclosedEvent[] = [];
  for (const event of selected) {
    const shouldRedact = matches(redactPatterns, event);
    const envelope: EventEnvelope = {
      ...event,
      payload: shouldRedact ? downgrade(event.payload) : event.payload,
    };
    events.push({
      envelope,
      proof: await proveInclusion(
        leaves,
        event.sequence + 1,
        receipt.receipt.id,
        hash,
      ),
    });
  }

  return {
    specification: { name: SPEC_NAME, version: SPEC_VERSION },
    disclosure: {
      id: `disc_1_${bytesToHex(random(16))}`,
      createdAt: clock().toISOString(),
      receiptId: receipt.receipt.id,
      root: receipt.commitments.root,
    },
    header: {
      value: header,
      proof: await proveInclusion(leaves, 0, receipt.receipt.id, hash),
    },
    events,
    ...(options.includeLeaves === false
      ? {}
      : { leaves: leaves.map((leaf) => encodeBase64Url(leaf)) }),
    signatures: receipt.signatures.map((signature) => ({ ...signature })),
  };
}
