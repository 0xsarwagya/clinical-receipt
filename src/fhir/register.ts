import { registerReservedNamespace } from "../core/extensions.js";
import { isCommitmentShape } from "../core/commitment.js";
import {
  FHIR_EVENT_KINDS,
  FHIR_EXTENSION_VERSION,
  FHIR_NAMESPACE,
  FHIR_R4,
  isFhirEventKind,
} from "./constants.js";

/**
 * Payload-shape validator for reserved FHIR events. Called by the core
 * `assertExtensionEventShape` when the event's namespace is
 * `org.hl7.fhir`. Returns null when the payload is well-formed for the
 * event kind at the declared extensionVersion, or a short message
 * pointing to the field that failed. NEVER includes a payload value.
 */
function validateFhirPayload(
  kind: string,
  payload: unknown,
  // operation is unused today but keeps parity with the ReservedNamespace
  // interface so future validators can throw richer errors.
  _operation: unknown,
): string | null {
  if (!isFhirEventKind(kind)) {
    return `unrecognized FHIR event kind (namespace claims ${FHIR_NAMESPACE} but kind is not registered)`;
  }
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    return "payload must be a plain object";
  }
  const meta = payload as {
    extensionVersion?: unknown;
    fhirVersion?: unknown;
    server?: unknown;
    commitment?: unknown;
    bundle?: unknown;
    submitted?: unknown;
    resource?: unknown;
    target?: unknown;
    operation?: unknown;
  };

  if (meta.extensionVersion !== FHIR_EXTENSION_VERSION) {
    return `extensionVersion must be ${JSON.stringify(FHIR_EXTENSION_VERSION)}`;
  }
  if (meta.fhirVersion !== FHIR_R4) {
    return `fhirVersion must be ${JSON.stringify(FHIR_R4)}`;
  }
  const server = meta.server as { id?: unknown } | undefined;
  if (
    typeof server !== "object" ||
    server === null ||
    typeof server.id !== "string" ||
    server.id.length === 0
  ) {
    return "server.id must be a non-empty string";
  }

  switch (kind) {
    case FHIR_EVENT_KINDS.resourceRead:
    case FHIR_EVENT_KINDS.resourceVersionedRead: {
      const resource = meta.resource as { type?: unknown } | undefined;
      if (
        typeof resource !== "object" ||
        resource === null ||
        typeof resource.type !== "string" ||
        resource.type.length === 0
      ) {
        return "resource.type must be a non-empty string";
      }
      if (!isCommitmentShape(meta.commitment)) {
        return "commitment must be a valid Commitment record";
      }
      if (
        kind === FHIR_EVENT_KINDS.resourceVersionedRead &&
        typeof (resource as { versionId?: unknown }).versionId !== "string"
      ) {
        return "resource.versionId is required for versioned reads";
      }
      return null;
    }
    case FHIR_EVENT_KINDS.resourceWrite: {
      const target = meta.target as { type?: unknown } | undefined;
      if (
        typeof target !== "object" ||
        target === null ||
        typeof target.type !== "string" ||
        target.type.length === 0
      ) {
        return "target.type must be a non-empty string";
      }
      const op = meta.operation;
      if (op !== "create" && op !== "update" && op !== "patch" && op !== "delete") {
        return "operation must be create|update|patch|delete";
      }
      const submitted = meta.submitted as { commitment?: unknown } | undefined;
      if (submitted !== undefined && !isCommitmentShape(submitted.commitment)) {
        return "submitted.commitment must be a valid Commitment record";
      }
      return null;
    }
    case FHIR_EVENT_KINDS.search: {
      const bundle = meta.bundle as
        | { commitment?: unknown; resources?: unknown }
        | undefined;
      if (
        typeof bundle !== "object" ||
        bundle === null ||
        !isCommitmentShape(bundle.commitment) ||
        !Array.isArray(bundle.resources)
      ) {
        return "bundle.{commitment,resources} required for search events";
      }
      return null;
    }
    case FHIR_EVENT_KINDS.transaction: {
      const submitted = meta.submitted as
        | { commitment?: unknown; entryCount?: unknown }
        | undefined;
      if (
        typeof submitted !== "object" ||
        submitted === null ||
        !isCommitmentShape(submitted.commitment) ||
        typeof submitted.entryCount !== "number"
      ) {
        return "submitted.{commitment,entryCount} required for transaction events";
      }
      return null;
    }
    case FHIR_EVENT_KINDS.error: {
      const target = meta.target as
        | { method?: unknown; path?: unknown }
        | undefined;
      if (
        typeof target !== "object" ||
        target === null ||
        typeof target.method !== "string" ||
        typeof target.path !== "string"
      ) {
        return "target.{method,path} required for error events";
      }
      return null;
    }
    default:
      // We already accepted the kind at the top; anything reaching here
      // is a schema-only event kind we do not further shape-validate.
      return null;
  }
}

let registered = false;

/**
 * Register the `org.hl7.fhir` reserved namespace on the receiver. Called
 * eagerly by every entry point that needs FHIR semantics (the /fhir
 * barrel and the FHIR verifier). Explicit instead of side-effectful so
 * a tree-shaker cannot drop it silently.
 */
export function registerFhirNamespace(): void {
  if (registered) return;
  registered = true;
  registerReservedNamespace({
    namespace: FHIR_NAMESPACE,
    validate: (kind, payload, operation) =>
      validateFhirPayload(kind, payload, operation),
  });
}

// Also register at module load — harmless if the module actually gets
// loaded, and callers who import the barrel get the registration
// automatically. Tree-shakers may drop the load-time call but callers
// that import `registerFhirNamespace` and invoke it explicitly are safe.
registerFhirNamespace();
