import { canonicalize } from "../core/canonicalize.js";
import { commitPayload, commitmentsEqual } from "../core/commitment.js";
import { SPEC_NAME, SPEC_VERSION } from "../core/constants.js";
import { classifyEventType, reservedNamespaceOf } from "../core/extensions.js";
import {
  bytesEqual,
  decodeBase64Url,
} from "../core/encoding.js";
import {
  committedEventForm,
  deriveEventIdentity,
  type EventEnvelope,
} from "../core/event.js";
import { buildHeader, headerLeafBytes } from "../core/header.js";
import { resolveHash } from "../core/hash.js";
import { merkleRoot } from "../core/merkle.js";
import { ReceiptError } from "../errors.js";
import type { ClinicalReceipt } from "../recorder/receipt.js";
import { signaturePayloadBytes } from "../signing/signer.js";
import {
  importVerificationKey,
  type VerificationKey,
} from "../signing/webcrypto.js";
import { parseReceipt } from "./parse.js";
import type {
  EventFailure,
  SignatureStatus,
  VerificationReport,
  VerificationWarning,
} from "./report.js";

export interface VerifyOptions {
  /** Trusted verification keys, matched by keyId. */
  keys?: VerificationKey[];
}

/**
 * Recomputes a single envelope from its own committed content and checks
 * every claim it makes about itself. Returns null when clean.
 */
export async function checkEvent(
  event: EventEnvelope,
): Promise<string | null> {
  // 1. The committed form must rehash to the declared id and commitment.
  let derived;
  try {
    derived = await deriveEventIdentity(
      committedEventForm({
        type: event.type,
        sequence: event.sequence,
        ...(event.occurredAt !== undefined ? { occurredAt: event.occurredAt } : {}),
        recordedAt: event.recordedAt,
        ...(event.actor !== undefined ? { actor: event.actor } : {}),
        parentIds: event.parentIds,
        payload: {
          commitment: event.payload.commitment,
          ...(event.payload.mediaType !== undefined
            ? { mediaType: event.payload.mediaType }
            : {}),
          ...(event.payload.ref !== undefined ? { ref: event.payload.ref } : {}),
        },
      }),
      undefined,
      "verifyReceipt",
    );
  } catch {
    return "envelope-not-canonicalizable";
  }
  if (derived.id !== event.id) {
    return "event-id-mismatch";
  }
  if (!commitmentsEqual(derived.commitment, event.commitment)) {
    return "envelope-commitment-mismatch";
  }

  // 2. When the value travels in clear, it must recommit to the descriptor.
  if (event.payload.mode === "embedded") {
    try {
      const value =
        event.payload.encoding === "base64url"
          ? decodeBase64Url(event.payload.value as string)
          : event.payload.value;
      const canonicalBytes = canonicalize(
        event.payload.commitment.canonicalization,
        value,
        "verifyReceipt",
      );
      const salt =
        event.payload.salt !== undefined
          ? decodeBase64Url(event.payload.salt)
          : null;
      const recomputed = await commitPayload(canonicalBytes, {
        canonicalization: event.payload.commitment.canonicalization,
        salt,
        hash: resolveHash(event.payload.commitment.algorithm, "verifyReceipt"),
        operation: "verifyReceipt",
      });
      if (!commitmentsEqual(recomputed, event.payload.commitment)) {
        return "payload-commitment-mismatch";
      }
    } catch (error) {
      return error instanceof ReceiptError &&
        error.code === "UNSUPPORTED_ALGORITHM"
        ? "unsupported-payload-algorithm"
        : "payload-commitment-mismatch";
    }
  }
  return null;
}

export async function verifyReceipt(
  input: ClinicalReceipt | string | Uint8Array,
  options: VerifyOptions = {},
): Promise<VerificationReport> {
  const receipt = parseReceipt(input, "verifyReceipt");
  const warnings: VerificationWarning[] = [];
  const failures: EventFailure[] = [];

  // Events — every claim recomputed from content.
  for (const event of receipt.events) {
    const reason = await checkEvent(event);
    if (reason !== null) {
      failures.push({ index: event.sequence, eventId: event.id, reason });
    }
  }

  // Tree — rebuilt from scratch.
  let rootVerified = false;
  try {
    const hash = resolveHash(receipt.commitments.root.algorithm, "verifyReceipt");
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
    const leaves = [
      headerLeafBytes(header),
      ...receipt.events.map((event) => decodeBase64Url(event.commitment.digest)),
    ];
    const root = await merkleRoot(leaves, receipt.receipt.id, hash, "verifyReceipt");
    rootVerified = bytesEqual(root, decodeBase64Url(receipt.commitments.root.digest));
  } catch {
    rootVerified = false;
  }

  // Signatures.
  const keyIndex = new Map<string, VerificationKey>();
  for (const key of options.keys ?? []) {
    keyIndex.set(key.keyId, key);
  }
  const signatures: Array<{
    keyId: string;
    algorithm: string;
    status: SignatureStatus;
  }> = [];
  for (const record of receipt.signatures) {
    let status: SignatureStatus;
    let key = keyIndex.get(record.keyId);
    let selfAttested = false;
    if (key === undefined && record.publicKeyJwk !== undefined) {
      try {
        const imported = await importVerificationKey(record.publicKeyJwk);
        if (imported.keyId === record.keyId) {
          key = imported;
          selfAttested = true;
        }
      } catch {
        key = undefined;
      }
    }
    if (key === undefined) {
      status = "no-key-provided";
      warnings.push({
        code: "NO_KEY_PROVIDED",
        message: `no trusted key supplied for ${record.keyId}`,
      });
    } else {
      const payload = signaturePayloadBytes({
        receiptId: receipt.receipt.id,
        root: receipt.commitments.root,
        algorithm: record.algorithm,
        keyId: record.keyId,
        signedAt: record.signedAt,
      });
      let valid = false;
      try {
        valid =
          key.algorithm === record.algorithm &&
          (await key.verify(payload, decodeBase64Url(record.signature)));
      } catch {
        valid = false;
      }
      status = valid ? (selfAttested ? "self-attested" : "verified") : "failed";
      if (status === "self-attested") {
        warnings.push({
          code: "SELF_ATTESTED_KEY",
          message: `signature ${record.keyId} verified against a key embedded in the receipt — it proves possession, not identity`,
        });
      }
    }
    signatures.push({ keyId: record.keyId, algorithm: record.algorithm, status });
  }

  // Timeline — claims, never integrity.
  const notes: string[] = ["All timestamps are recorder-asserted claims."];
  let internallyConsistent = true;
  const recordedById = new Map<string, string>();
  let previousRecordedAt = "";
  for (const event of receipt.events) {
    if (event.recordedAt < previousRecordedAt) {
      internallyConsistent = false;
      notes.push(`recordedAt regresses at sequence ${event.sequence}`);
    }
    previousRecordedAt = event.recordedAt;
    for (const parent of event.parentIds) {
      const parentRecordedAt = recordedById.get(parent);
      if (parentRecordedAt !== undefined && parentRecordedAt > event.recordedAt) {
        internallyConsistent = false;
        notes.push(`a parent of sequence ${event.sequence} was recorded after it`);
      }
    }
    if (event.occurredAt !== undefined && event.occurredAt > event.recordedAt) {
      internallyConsistent = false;
      notes.push(`occurredAt is after recordedAt at sequence ${event.sequence}`);
    }
    recordedById.set(event.id, event.recordedAt);
  }
  if (receipt.receipt.createdAt > receipt.receipt.finalizedAt) {
    internallyConsistent = false;
    notes.push("receipt.createdAt is after receipt.finalizedAt");
  }
  if (!internallyConsistent) {
    warnings.push({
      code: "TIMELINE_INCONSISTENT",
      message: "recorder-asserted timestamps are internally inconsistent",
    });
  }
  warnings.push({
    code: "NO_EXTERNAL_TIMESTAMP",
    message: "receipt has no externally trusted timestamp",
  });

  // Bucket the extension namespaces present in this receipt. Unknown
  // extensions are recorded honestly — a namespace-aware verifier can
  // upgrade them to "understood" without touching integrity.
  const understood = new Set<string>();
  const unknown = new Set<string>();
  for (const event of receipt.events) {
    const classification = classifyEventType(event.type);
    if (classification === "core") continue;
    const namespace = reservedNamespaceOf(event.type);
    if (namespace !== null) {
      understood.add(namespace);
    } else {
      // Anchor an unknown extension by the URI or first two dotted
      // segments — a stable identifier so consumers can group without
      // parsing.
      const anchor = event.type.includes(":")
        ? event.type.split(":")[0] ?? event.type
        : event.type.split(".").slice(0, 2).join(".");
      unknown.add(anchor);
    }
  }

  const anySignatureFailed = signatures.some((s) => s.status === "failed");
  const ok = rootVerified && failures.length === 0 && !anySignatureFailed;

  return {
    ok,
    specification: { name: SPEC_NAME, version: SPEC_VERSION },
    integrity: {
      root: rootVerified ? "verified" : "failed",
      events: {
        total: receipt.events.length,
        verified: receipt.events.length - failures.length,
        failed: failures,
      },
    },
    signatures,
    disclosures: {
      applicable: false,
      complete: true,
      cryptographicallyConsistent: true,
    },
    timeline: {
      internallyConsistent,
      externallyTimestamped: false,
      notes,
    },
    reproducibility: {
      deterministic: "not-evaluated",
      nondeterministic: "not-claimed",
    },
    extensions: {
      understood: Array.from(understood).sort(),
      unknown: Array.from(unknown).sort(),
    },
    warnings,
  };
}
