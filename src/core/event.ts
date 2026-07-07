import { ReceiptError, type ReceiptOperation } from "../errors.js";
import {
  EVENT_CANONICALIZATION,
  EVENT_ID_PATTERN,
  HASH_SHA256,
  TAG_EVENT,
  TIMESTAMP_PATTERN,
  isCoreEventType,
  isExtensionEventType,
} from "./constants.js";
import {
  bytesToHex,
  encodeBase64Url,
  frame,
  utf8Bytes,
} from "./encoding.js";
import { jcsBytes } from "./jcs.js";
import { resolveHash, type HashAlgorithm } from "./hash.js";
import { isCommitmentShape, type Commitment } from "./commitment.js";

export interface Actor {
  type: string;
  id: string;
  display?: string;
}

export interface PayloadRef {
  uri: string;
  version?: string;
}

export type PayloadMode = "commitment" | "reference" | "embedded";

/** The payload descriptor as it appears in a serialized envelope. */
export interface PayloadDescriptor {
  mode: PayloadMode;
  commitment: Commitment;
  mediaType?: string;
  /** Present in embedded mode only. */
  value?: unknown;
  /** "base64url" when the value carries bytes@1 content. */
  encoding?: "base64url";
  /** Present exactly when value is present and the commitment was salted. */
  salt?: string;
  /** Present in reference mode only — committed. */
  ref?: PayloadRef;
}

export interface EventEnvelope {
  id: string;
  type: string;
  sequence: number;
  occurredAt?: string;
  recordedAt: string;
  actor?: Actor;
  parentIds: string[];
  payload: PayloadDescriptor;
  commitment: Commitment;
}

/**
 * The committed form per spec/1.0/commitments.md §4 — exactly these
 * fields, optionals omitted. `id`, `commitment`, and the presentation
 * region (mode/value/encoding/salt) are deliberately excluded: that is
 * the mode-downgrade invariant.
 */
export function committedEventForm(envelope: {
  type: string;
  sequence: number;
  occurredAt?: string;
  recordedAt: string;
  actor?: Actor;
  parentIds: readonly string[];
  payload: { commitment: Commitment; mediaType?: string; ref?: PayloadRef };
}): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    commitment: {
      algorithm: envelope.payload.commitment.algorithm,
      canonicalization: envelope.payload.commitment.canonicalization,
      digest: envelope.payload.commitment.digest,
    },
  };
  if (envelope.payload.mediaType !== undefined) {
    payload.mediaType = envelope.payload.mediaType;
  }
  if (envelope.payload.ref !== undefined) {
    payload.ref =
      envelope.payload.ref.version !== undefined
        ? { uri: envelope.payload.ref.uri, version: envelope.payload.ref.version }
        : { uri: envelope.payload.ref.uri };
  }

  const form: Record<string, unknown> = {
    type: envelope.type,
    sequence: envelope.sequence,
    recordedAt: envelope.recordedAt,
    parentIds: [...envelope.parentIds],
    payload,
  };
  if (envelope.occurredAt !== undefined) {
    form.occurredAt = envelope.occurredAt;
  }
  if (envelope.actor !== undefined) {
    const actor: Record<string, unknown> = {
      type: envelope.actor.type,
      id: envelope.actor.id,
    };
    if (envelope.actor.display !== undefined) {
      actor.display = envelope.actor.display;
    }
    form.actor = actor;
  }
  return form;
}

export interface DerivedEventIdentity {
  digest: Uint8Array<ArrayBuffer>;
  id: string;
  commitment: Commitment;
}

/** envelopeDigest = H( f(tag) || f(hashId) || f(profile) || f(jcs(form)) ) */
export async function deriveEventIdentity(
  form: Record<string, unknown>,
  hash?: HashAlgorithm,
  operation: ReceiptOperation = "record",
): Promise<DerivedEventIdentity> {
  const algorithm = hash ?? resolveHash(HASH_SHA256, operation);
  const message = frame([
    utf8Bytes(TAG_EVENT),
    utf8Bytes(algorithm.id),
    utf8Bytes(EVENT_CANONICALIZATION),
    jcsBytes(form),
  ]);
  const digest = await algorithm.digest(message);
  return {
    digest,
    id: `evt_1_${bytesToHex(digest)}`,
    commitment: {
      algorithm: algorithm.id,
      canonicalization: EVENT_CANONICALIZATION,
      digest: encodeBase64Url(digest),
    },
  };
}

function fail(operation: ReceiptOperation, message: string): never {
  throw new ReceiptError({ code: "MALFORMED_RECEIPT", message, operation });
}

/** Structural validation of a serialized envelope. PHI-safe messages. */
export function assertEnvelopeShape(
  value: unknown,
  operation: ReceiptOperation,
): asserts value is EventEnvelope {
  if (typeof value !== "object" || value === null) {
    fail(operation, "event envelope must be an object");
  }
  const event = value as Record<string, unknown>;
  if (typeof event.id !== "string" || !EVENT_ID_PATTERN.test(event.id)) {
    fail(operation, "event.id is not a well-formed event id");
  }
  if (typeof event.type !== "string" || event.type.length === 0) {
    fail(operation, "event.type must be a non-empty string");
  }
  if (!isCoreEventType(event.type) && !isExtensionEventType(event.type)) {
    fail(
      operation,
      `event.type ${JSON.stringify(event.type)} is neither a core type nor an absolute-URI extension`,
    );
  }
  if (
    typeof event.sequence !== "number" ||
    !Number.isSafeInteger(event.sequence) ||
    event.sequence < 0
  ) {
    fail(operation, "event.sequence must be a non-negative integer");
  }
  if (
    typeof event.recordedAt !== "string" ||
    !TIMESTAMP_PATTERN.test(event.recordedAt)
  ) {
    fail(operation, "event.recordedAt must be an RFC 3339 UTC millisecond timestamp");
  }
  if (
    event.occurredAt !== undefined &&
    (typeof event.occurredAt !== "string" ||
      !TIMESTAMP_PATTERN.test(event.occurredAt))
  ) {
    fail(operation, "event.occurredAt must be an RFC 3339 UTC millisecond timestamp");
  }
  if (event.actor !== undefined) {
    const actor = event.actor as Record<string, unknown>;
    if (
      typeof actor !== "object" ||
      actor === null ||
      typeof actor.type !== "string" ||
      typeof actor.id !== "string"
    ) {
      fail(operation, "event.actor must carry string type and id");
    }
  }
  if (!Array.isArray(event.parentIds)) {
    fail(operation, "event.parentIds must be an array");
  }
  for (const parent of event.parentIds) {
    if (typeof parent !== "string" || !EVENT_ID_PATTERN.test(parent)) {
      fail(operation, "event.parentIds contains a malformed event id");
    }
  }
  const sorted = [...(event.parentIds as string[])].sort();
  if (
    JSON.stringify(sorted) !== JSON.stringify(event.parentIds) ||
    new Set(sorted).size !== sorted.length
  ) {
    fail(operation, "event.parentIds must be a sorted set without duplicates");
  }

  const payload = event.payload as Record<string, unknown>;
  if (typeof payload !== "object" || payload === null) {
    fail(operation, "event.payload must be an object");
  }
  if (
    payload.mode !== "commitment" &&
    payload.mode !== "reference" &&
    payload.mode !== "embedded"
  ) {
    fail(operation, "event.payload.mode must be commitment, reference, or embedded");
  }
  if (!isCommitmentShape(payload.commitment)) {
    fail(operation, "event.payload.commitment is malformed");
  }
  if (payload.mode === "embedded" && !("value" in payload)) {
    fail(operation, "embedded payload must carry a value");
  }
  if (payload.mode !== "embedded" && "value" in payload) {
    fail(operation, "non-embedded payload must not carry a value");
  }
  if (payload.mode === "reference") {
    const ref = payload.ref as Record<string, unknown>;
    if (
      typeof ref !== "object" ||
      ref === null ||
      typeof ref.uri !== "string" ||
      ref.uri.length === 0
    ) {
      fail(operation, "reference payload must carry ref.uri");
    }
  }
  if (payload.salt !== undefined && typeof payload.salt !== "string") {
    fail(operation, "event.payload.salt must be a base64url string");
  }
  if (!isCommitmentShape(event.commitment)) {
    fail(operation, "event.commitment is malformed");
  }
}
