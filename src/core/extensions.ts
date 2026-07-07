import { ReceiptError, type ReceiptOperation } from "../errors.js";

/**
 * Extension namespaces are how the receipt protocol carries domain
 * semantics without inflating the core event vocabulary. Every extension
 * event type is an absolute URI whose scheme-and-authority form is the
 * "namespace": `org.hl7.fhir.resource.read` belongs to `org.hl7.fhir`,
 * `com.example.custom.thing` belongs to `com.example.custom`.
 *
 * Reserved namespaces are shipped by this package; unreserved namespaces
 * remain free to use but receive no first-party schema validation.
 */

export interface ExtensionEventPayloadMeta {
  /**
   * A monotonically increasing string, per-namespace. Any incompatible
   * change to the namespace's committed shape MUST bump this — vectors
   * pinned against v1 must remain valid forever.
   */
  extensionVersion: string;
}

export interface ReservedNamespace {
  /** The dotted namespace, e.g. `org.hl7.fhir`. */
  namespace: string;
  /**
   * Returns null if the payload is well-formed for this namespace at the
   * declared extensionVersion, or a short message pointing to the field
   * that failed. NEVER mentions a payload value — messages travel in
   * error logs and stay PHI-safe.
   */
  validate(
    kind: string,
    payload: unknown,
    operation: ReceiptOperation,
  ): string | null;
}

const RESERVED = new Map<string, ReservedNamespace>();

export function registerReservedNamespace(namespace: ReservedNamespace): void {
  if (RESERVED.has(namespace.namespace)) {
    // Re-registration of the same namespace with the same identity is a
    // no-op — module load order in tsup can import twice under CJS/ESM
    // interop and we must not blow up.
    return;
  }
  RESERVED.set(namespace.namespace, namespace);
}

export function reservedNamespaces(): readonly string[] {
  return Array.from(RESERVED.keys()).sort();
}

/**
 * Strips off the trailing `.kind` segment: `org.hl7.fhir.resource.read`
 * → `org.hl7.fhir` if that namespace is registered, else null. Returns
 * the longest matching reserved namespace (longest-prefix wins so a
 * hypothetical future `org.hl7.fhir.subprotocol` namespace could nest).
 */
export function reservedNamespaceOf(kind: string): string | null {
  let best: string | null = null;
  for (const ns of RESERVED.keys()) {
    if (kind === ns || kind.startsWith(`${ns}.`)) {
      if (best === null || ns.length > best.length) {
        best = ns;
      }
    }
  }
  return best;
}

/**
 * When an extension event uses a reserved namespace, its payload MUST
 * carry the namespace's meta shape. This is the recorder-side guard;
 * the verifier applies the same rule when parsing receipts.
 *
 * Non-reserved namespaces skip validation entirely — the core protocol
 * commits to their bytes and nothing more. That is the whole point of
 * the extension mechanism.
 */
export function assertExtensionEventShape(
  kind: string,
  payloadValue: unknown,
  operation: ReceiptOperation,
): void {
  const namespace = reservedNamespaceOf(kind);
  if (namespace === null) return;
  const registered = RESERVED.get(namespace);
  if (registered === undefined) return;

  if (
    typeof payloadValue !== "object" ||
    payloadValue === null ||
    Array.isArray(payloadValue)
  ) {
    throw new ReceiptError({
      code: "MALFORMED_EXTENSION",
      message: `${namespace} extension payload must be a plain object`,
      operation,
    });
  }
  const meta = payloadValue as { extensionVersion?: unknown };
  if (
    typeof meta.extensionVersion !== "string" ||
    meta.extensionVersion.length === 0
  ) {
    throw new ReceiptError({
      code: "MALFORMED_EXTENSION",
      message: `${namespace} extension payload must declare extensionVersion`,
      operation,
    });
  }
  const detail = registered.validate(kind, payloadValue, operation);
  if (detail !== null) {
    throw new ReceiptError({
      code: "MALFORMED_EXTENSION",
      message: `${kind}: ${detail}`,
      operation,
    });
  }
}

/**
 * A verifier-side check: what does this event's *type* tell us about
 * how a semantically-aware verifier should treat it?
 *
 *   - "reserved" — a shipped namespace understands this kind; a
 *     namespace-aware verifier can inspect its payload.
 *   - "extension" — a well-formed absolute URI outside the reserved
 *     table; integrity remains provable, semantics are not this
 *     verifier's job.
 *   - "core" — a base-protocol event type; verified by the core.
 */
export function classifyEventType(
  kind: string,
): "reserved" | "extension" | "core" {
  if (!kind.includes(":") && !kind.includes(".")) {
    // Bare dot-free identifiers are core event types; the recorder
    // enforces this shape before we ever get here.
    return "core";
  }
  const namespace = reservedNamespaceOf(kind);
  if (namespace !== null) return "reserved";
  return "extension";
}
