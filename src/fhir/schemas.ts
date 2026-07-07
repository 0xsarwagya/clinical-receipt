import type { Commitment } from "../core/commitment.js";
import { FHIR_EXTENSION_VERSION, FHIR_R4 } from "./constants.js";

/**
 * Descriptor of the FHIR store observations were made against. `id`
 * is the caller's stable identifier for the store (durable across URL
 * changes). Everything else is optional metadata — never trusted as
 * cryptographic identity.
 */
export interface FhirServer {
  id: string;
  baseUrl?: string;
  software?: string;
  environment?: string;
}

/** Common metadata carried by every FHIR extension event's payload. */
export interface FhirEventMeta {
  extensionVersion: typeof FHIR_EXTENSION_VERSION;
  fhirVersion: typeof FHIR_R4;
  server: FhirServer;
  /** Which per-field privacy transforms the recorder applied. */
  privacy?: {
    query?: Record<string, "preserve" | "hash" | "redact">;
    resourceIds?: "preserve" | "hash";
  };
}

/** Resource identity captured in a receipt event. */
export interface FhirResourceRef {
  type: string;
  /** Present when the recorder observed a logical id; may be a digest under `privacy.resourceIds:"hash"`. */
  id?: string;
  idCommitment?: string;
  versionId?: string;
  lastUpdated?: string;
}

/** `org.hl7.fhir.resource.read` — an unversioned GET on a specific resource. */
export interface FhirResourceReadPayload extends FhirEventMeta {
  operation: "read";
  resource: FhirResourceRef;
  commitment: Commitment;
  /** Response headers permitted by the caller's allowlist. */
  responseHeaders?: Record<string, string>;
}

/** `org.hl7.fhir.resource.vread` — a GET against `/_history/{versionId}`. */
export interface FhirResourceVersionedReadPayload extends FhirEventMeta {
  operation: "vread";
  resource: FhirResourceRef & { versionId: string };
  commitment: Commitment;
  versionPinned: true;
}

/** `org.hl7.fhir.resource.write` — POST/PUT/PATCH/DELETE against a resource. */
export interface FhirResourceWritePayload extends FhirEventMeta {
  operation: "create" | "update" | "patch" | "delete";
  target: {
    type: string;
    id?: string;
    versionId?: string;
  };
  /** What the caller submitted; absent for DELETE. */
  submitted?: {
    commitment: Commitment;
  };
  /** What the server acknowledged; absent when the server returned no body. */
  persisted?: {
    resource: FhirResourceRef;
    commitment: Commitment;
  };
  /** Response Location header, when the server supplied one. */
  location?: string;
}

/** `org.hl7.fhir.search` — a search interaction and the observed resources. */
export interface FhirSearchPayload extends FhirEventMeta {
  operation: "search";
  resourceType: string;
  /** Normalized query parameters with privacy transforms applied. */
  query: Record<string, string>;
  /** Server-reported total, when present. */
  total?: number;
  /** Explicit `_sort` value, when present — commitment MUST preserve order in that case. */
  sort?: string;
  /**
   * The FIRST page of the search response. In v0.2.0 pagination beyond
   * the first page is out of scope; multi-page state is carried by
   * separate `org.hl7.fhir.search.page` events in later versions.
   */
  bundle: {
    commitment: Commitment;
    resources: FhirResourceRef[];
  };
  /** How the recorder characterized pagination for this event. */
  pagination:
    | "complete"
    | "complete-first-page-only"
    | "partial"
    | "unknown";
}

/** `org.hl7.fhir.transaction` — a Bundle-of-Bundles submission. */
export interface FhirTransactionPayload extends FhirEventMeta {
  operation: "transaction" | "batch";
  submitted: {
    commitment: Commitment;
    entryCount: number;
  };
  response?: {
    commitment: Commitment;
    entries: Array<{
      status: string;
      location?: string;
    }>;
  };
}

/** `org.hl7.fhir.error` — a FHIR operation that failed. */
export interface FhirErrorPayload extends FhirEventMeta {
  operation: "error";
  target: {
    method: string;
    path: string;
    resourceType?: string;
  };
  httpStatus?: number;
  /** OperationOutcome commitment, when the server returned one. */
  operationOutcome?: {
    commitment: Commitment;
  };
  /** A short, PHI-safe class of failure — never a raw error message. */
  reason:
    | "network"
    | "http-4xx"
    | "http-5xx"
    | "timeout"
    | "aborted"
    | "malformed-response"
    | "unknown";
}

export type FhirEventPayload =
  | FhirResourceReadPayload
  | FhirResourceVersionedReadPayload
  | FhirResourceWritePayload
  | FhirSearchPayload
  | FhirTransactionPayload
  | FhirErrorPayload;
