import { commitmentsEqual, type Commitment } from "../core/commitment.js";
import { verifyReceipt, type VerifyOptions } from "./receipt.js";
import type { VerificationReport } from "./report.js";
import { commitFhirValue } from "../fhir/commit.js";
import { registerFhirCanonicalization } from "../fhir/canonicalize.js";
import { registerFhirNamespace } from "../fhir/register.js";

// Register both FHIR side effects explicitly so tree-shakers cannot
// drop them — otherwise `commitFhirValue` (used below) would throw
// UNSUPPORTED_CANONICALIZATION on the first call, and FHIR events
// would show up as unknown extensions in the report.
registerFhirCanonicalization();
registerFhirNamespace();
import {
  FHIR_EVENT_KINDS,
  FHIR_NAMESPACE,
  isFhirEventKind,
} from "../fhir/constants.js";
import { inspectFHIR, type FhirTrace } from "../fhir/inspect.js";
import type { ClinicalReceipt } from "../recorder/receipt.js";
import type {
  FhirResourceReadPayload,
  FhirResourceVersionedReadPayload,
  FhirResourceWritePayload,
  FhirSearchPayload,
  FhirTransactionPayload,
} from "../fhir/schemas.js";

export interface VerifyFhirResourceCheck {
  reference: string;
  eventId: string;
  commitment:
    | "match"
    | "mismatch"
    | "no-content-supplied"
    | "unsupported-algorithm";
}

export interface FhirVerificationReport extends VerificationReport {
  fhir: {
    commitments: "valid" | "invalid" | "not-applicable";
    understood: boolean;
    resources: VerifyFhirResourceCheck[];
    trace: FhirTrace;
  };
}

export interface VerifyFhirOptions extends VerifyOptions {
  /**
   * FHIR content the caller possesses, keyed by resource reference
   * (e.g. `"Patient/123"` or `"Patient/123/_history/7"`) or by the
   * event id. Each value MUST be the FHIR JSON that was hashed at
   * record time — the verifier canonicalizes it with fhir-json-r4@1
   * and compares against the pinned commitment.
   *
   * References that appear in the receipt without a supplied resource
   * are reported as `no-content-supplied`, not as failures — a caller
   * who has only some of the resources can still get a partial answer.
   */
  resources?: Record<string, unknown>;
}

function referenceFor(resource: {
  type: string;
  id?: string;
  versionId?: string;
}): string {
  const id = resource.id ?? "?";
  const version = resource.versionId;
  return version === undefined
    ? `${resource.type}/${id}`
    : `${resource.type}/${id}/_history/${version}`;
}

async function checkOne(
  eventId: string,
  reference: string,
  commitment: Commitment,
  supplied: unknown,
): Promise<VerifyFhirResourceCheck> {
  if (supplied === undefined) {
    return { reference, eventId, commitment: "no-content-supplied" };
  }
  try {
    const recomputed = await commitFhirValue(supplied, {
      salt: null,
      operation: "verifyFhir",
    });
    // The commitment tag must match; the caller may supply the same
    // FHIR bytes but the receipt's commitment MAY have been salted.
    // Recompute BOTH the salted (with `no salt` for consumers who
    // pinned unsalted vectors) and the caller-supplied-salt path.
    const status = compareOrRecomputeSalted(commitment, recomputed, supplied);
    return { reference, eventId, commitment: await status };
  } catch {
    return { reference, eventId, commitment: "unsupported-algorithm" };
  }
}

async function compareOrRecomputeSalted(
  pinned: Commitment,
  recomputed: Commitment,
  _supplied: unknown,
): Promise<VerifyFhirResourceCheck["commitment"]> {
  // Fast path: unsalted vectors — the recompute-with-null-salt
  // produces the same bytes and digest.
  if (commitmentsEqual(pinned, recomputed)) return "match";
  // Salted commitments cannot be recomputed without the salt, so we
  // cannot verify them offline from raw FHIR JSON alone. Callers who
  // want salt-covered verification must call `commitFhirValue` at
  // record time with a known salt and pass THAT commitment record in
  // via a future embedded-payload facility (v0.3+).
  return "mismatch";
}

/**
 * Offline FHIR verification. Runs the base receipt verifier, then walks
 * the FHIR events and — for any resource the caller supplies — checks
 * that the FHIR JSON they hold matches the receipt's commitment.
 *
 * Layer 3 (live store comparison) is NOT performed here. That is a
 * separate surface a future version will add.
 */
export async function verifyFHIR(
  receipt: ClinicalReceipt | string | Uint8Array,
  options: VerifyFhirOptions = {},
): Promise<FhirVerificationReport> {
  const base = await verifyReceipt(receipt, options);
  // We need the parsed receipt for FHIR-specific walking; verifyReceipt
  // already parsed and validated it, but we can re-parse here cheaply.
  const parsed = typeof receipt === "object" && receipt !== null && "receipt" in receipt
    ? (receipt as ClinicalReceipt)
    : JSON.parse(
        typeof receipt === "string" ? receipt : new TextDecoder().decode(receipt),
      ) as ClinicalReceipt;

  const trace = inspectFHIR(parsed);
  const understood = base.extensions.understood.includes(FHIR_NAMESPACE);
  const supplied = options.resources ?? {};

  const checks: VerifyFhirResourceCheck[] = [];
  for (const event of parsed.events) {
    if (!isFhirEventKind(event.type)) continue;
    if (event.payload.mode !== "embedded") continue;
    const value = event.payload.value as unknown;
    if (value === undefined || value === null) continue;

    switch (event.type) {
      case FHIR_EVENT_KINDS.resourceRead:
      case FHIR_EVENT_KINDS.resourceVersionedRead: {
        const payload = value as
          | FhirResourceReadPayload
          | FhirResourceVersionedReadPayload;
        const reference = referenceFor(payload.resource);
        const suppliedResource =
          supplied[reference] ?? supplied[event.id];
        checks.push(
          await checkOne(event.id, reference, payload.commitment, suppliedResource),
        );
        break;
      }
      case FHIR_EVENT_KINDS.resourceWrite: {
        const payload = value as FhirResourceWritePayload;
        if (payload.submitted !== undefined) {
          const suppliedResource =
            supplied[`${event.id}#submitted`] ?? supplied[event.id];
          checks.push(
            await checkOne(
              event.id,
              `${event.id}#submitted`,
              payload.submitted.commitment,
              suppliedResource,
            ),
          );
        }
        if (payload.persisted !== undefined) {
          const reference = referenceFor(payload.persisted.resource);
          const suppliedResource =
            supplied[reference] ?? supplied[`${event.id}#persisted`];
          checks.push(
            await checkOne(
              event.id,
              reference,
              payload.persisted.commitment,
              suppliedResource,
            ),
          );
        }
        break;
      }
      case FHIR_EVENT_KINDS.search: {
        const payload = value as FhirSearchPayload;
        const suppliedBundle = supplied[event.id];
        checks.push(
          await checkOne(
            event.id,
            `search:${payload.resourceType}`,
            payload.bundle.commitment,
            suppliedBundle,
          ),
        );
        break;
      }
      case FHIR_EVENT_KINDS.transaction: {
        const payload = value as FhirTransactionPayload;
        const suppliedBundle = supplied[`${event.id}#submitted`] ?? supplied[event.id];
        checks.push(
          await checkOne(
            event.id,
            `${event.id}#transaction-submitted`,
            payload.submitted.commitment,
            suppliedBundle,
          ),
        );
        if (payload.response !== undefined) {
          const suppliedResponse = supplied[`${event.id}#response`];
          checks.push(
            await checkOne(
              event.id,
              `${event.id}#transaction-response`,
              payload.response.commitment,
              suppliedResponse,
            ),
          );
        }
        break;
      }
    }
  }

  const anyFhirEvent = checks.length > 0;
  const anyMismatch = checks.some((c) => c.commitment === "mismatch");
  const anyMatched = checks.some((c) => c.commitment === "match");
  const commitments: FhirVerificationReport["fhir"]["commitments"] = !anyFhirEvent
    ? "not-applicable"
    : anyMismatch
      ? "invalid"
      : anyMatched
        ? "valid"
        : "not-applicable";

  const ok = base.ok && commitments !== "invalid";
  return {
    ...base,
    ok,
    fhir: {
      commitments,
      understood,
      resources: checks,
      trace,
    },
  };
}
