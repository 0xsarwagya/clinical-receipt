export const SPEC_NAME = "clinical-receipt";
export const SPEC_VERSION = "1.0";

/** Domain-separation tags — pinned in spec/1.0/commitments.md. */
export const TAG_PAYLOAD = "clinical-receipt:payload:v1";
export const TAG_EVENT = "clinical-receipt:event:v1";
export const TAG_TREE_PREFIX = "clinical-receipt:tree:v1:";
export const TAG_SIGNATURE = "clinical-receipt:signature:v1";
export const TAG_KEYID = "clinical-receipt:keyid:v1";

export const HASH_SHA256 = "sha-256";
export const TREE_STRUCTURE = "clinical-receipt-merkle@1";
export const EVENT_CANONICALIZATION = "clinical-receipt-event@1";
export const SIGNATURE_PROFILE = "clinical-receipt-sig@1";

export const RECEIPT_ID_PATTERN = /^rcpt_1_[0-9a-f]{32}$/;
export const EVENT_ID_PATTERN = /^evt_1_[0-9a-f]{64}$/;
export const KEY_ID_PATTERN = /^key_1_[0-9a-f]{32}$/;
export const DISCLOSURE_ID_PATTERN = /^disc_1_[0-9a-f]{32}$/;

/** RFC 3339 UTC, millisecond precision, Z suffix — the only accepted form. */
export const TIMESTAMP_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

export const PAYLOAD_SALT_BYTES = 16;

export const CORE_EVENT_TYPES = [
  "run.started",
  "run.finalized",
  "input.observed",
  "input.transformed",
  "evidence.queried",
  "evidence.retrieved",
  "prompt.template.selected",
  "prompt.rendered",
  "model.requested",
  "model.responded",
  "tool.requested",
  "tool.responded",
  "guardrail.evaluated",
  "human.review.requested",
  "human.review.completed",
  "output.proposed",
  "output.modified",
  "output.committed",
] as const;

export type CoreEventType = (typeof CORE_EVENT_TYPES)[number];

export function isCoreEventType(value: string): value is CoreEventType {
  return (CORE_EVENT_TYPES as readonly string[]).includes(value);
}

const REVERSE_DNS_SEGMENT = /^[a-zA-Z][a-zA-Z0-9-]*$/;

/**
 * Extension event types must be either:
 *
 *   1. an absolute URI (contains `:`), e.g. `https://example.org/x/v1`, OR
 *   2. a reverse-DNS identifier with at least 3 dot-separated segments,
 *      e.g. `org.hl7.fhir.resource.read`.
 *
 * Core event types (`input.observed`, `human.review.completed`) are two
 * or three dotted segments and never conflict with (2) because they are
 * excluded first — a reverse-DNS extension with a namespace like
 * `com.acme.observed` remains valid.
 */
export function isExtensionEventType(value: string): boolean {
  if (isCoreEventType(value)) return false;
  if (value.includes(":")) return true;
  const segments = value.split(".");
  if (segments.length < 3) return false;
  return segments.every((segment) => REVERSE_DNS_SEGMENT.test(segment));
}
