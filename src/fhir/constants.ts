/**
 * FHIR extension identifiers — pinned in spec/1.0/fhir.md. Any change
 * to the committed shape of these events MUST bump `FHIR_EXTENSION_VERSION`
 * and produce a new set of test vectors; existing receipts remain
 * verifiable against the version they declared.
 */
export const FHIR_NAMESPACE = "org.hl7.fhir";
export const FHIR_EXTENSION_VERSION = "1";

/** The one FHIR release this package targets in v0.2.0. */
export const FHIR_R4 = "R4";

/**
 * FHIR JSON canonicalization profile — v0.2.0 is byte-equivalent to
 * jcs@1. If future work adds FHIR-specific pre-normalization (primitive
 * extensions, contained resources, terminology folding) the profile
 * MUST be bumped to `fhir-json-r4@2` so pinned vectors stay honest.
 */
export const FHIR_CANONICALIZATION = "fhir-json-r4@1";

export const FHIR_EVENT_KINDS = {
  request: "org.hl7.fhir.request",
  response: "org.hl7.fhir.response",
  resourceRead: "org.hl7.fhir.resource.read",
  resourceVersionedRead: "org.hl7.fhir.resource.vread",
  resourceWrite: "org.hl7.fhir.resource.write",
  search: "org.hl7.fhir.search",
  searchPage: "org.hl7.fhir.search.page",
  transaction: "org.hl7.fhir.transaction",
  error: "org.hl7.fhir.error",
} as const;

export type FhirEventKind =
  (typeof FHIR_EVENT_KINDS)[keyof typeof FHIR_EVENT_KINDS];

const FHIR_KIND_SET = new Set<string>(Object.values(FHIR_EVENT_KINDS));

export function isFhirEventKind(value: string): value is FhirEventKind {
  return FHIR_KIND_SET.has(value);
}

/**
 * Response headers permitted to enter a receipt by default. Names are
 * compared case-insensitively at the boundary; the committed name is
 * always lowercase.
 */
export const DEFAULT_PERMITTED_RESPONSE_HEADERS = [
  "etag",
  "last-modified",
  "location",
  "content-location",
] as const;

/**
 * Headers hard-blocked from committal regardless of the caller's
 * allowlist. This list is not exhaustive — the allowlist is the primary
 * control — but these are the ones an accidental wildcard would leak.
 */
export const BLOCKED_RESPONSE_HEADERS = [
  "authorization",
  "cookie",
  "set-cookie",
  "proxy-authorization",
  "x-api-key",
  "x-auth-token",
] as const;

/** Match `Patient/123/_history/7` in a URL path. */
export const FHIR_VERSIONED_PATH =
  /^\/?([A-Za-z]+)\/([A-Za-z0-9\-.]{1,64})\/_history\/([A-Za-z0-9\-.]{1,64})$/;

/** Match `Patient/123` in a URL path. */
export const FHIR_RESOURCE_PATH =
  /^\/?([A-Za-z]+)\/([A-Za-z0-9\-.]{1,64})$/;

/** Match a type-level path (search or create): `Patient`. */
export const FHIR_TYPE_PATH = /^\/?([A-Za-z]+)$/;
