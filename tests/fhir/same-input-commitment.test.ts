import { describe, expect, it } from "vitest";

import type { EventEnvelope } from "../../src/core/event.js";
import { FHIR_EVENT_KINDS } from "../../src/fhir/constants.js";
import { fhirExtension } from "../../src/fhir/operation.js";
import { createReceipt } from "../../src/recorder/receipt.js";
import { deterministicOptions, fixedRandom } from "../fixtures.js";
import {
  HAPI_BASE_URL,
  HAPI_SERVER,
  OBSERVATION_SEARCHSET,
  PATIENT_123,
} from "./fixtures.js";

/**
 * Property the Same State demo depends on:
 *
 *   Two independent receipts committing the *same* FHIR body through
 *   the operation API MUST produce identical commitment.digest values,
 *   provided the caller passes a shared random source for the salt.
 *
 * Absent this test v0.2.0/0.2.1 silently violated the property — the
 * default per-call random in `commitFhirValue` made each digest
 * unique. That failure was invisible to source-level determinism tests
 * because they either passed an explicit salt or called
 * `commitFhirValue` directly. The operation API path was untested.
 *
 * The property must hold across:
 *   - read events (single resource)
 *   - search events (Bundle body)
 *   - write events (submitted + persisted)
 * If any of these regress, the "same clinical state" claim in any
 * comparison-style consumer breaks silently.
 */

async function twoRunsHitting(
  path: string,
  method: "GET" | "POST",
  body: unknown,
  extra?: (
    op: ReturnType<ReturnType<typeof fhirExtension>["operation"]>,
    body: unknown,
  ) => Promise<void>,
): Promise<{ a: EventEnvelope; b: EventEnvelope }> {
  const runs = await Promise.all(
    [0, 1].map(async () => {
      const run = await createReceipt(deterministicOptions());
      // Each run gets a FRESH fixedRandom() seeded identically — the
      // counter is per-closure, so two independent instances produce the
      // same byte sequence. Sharing ONE closure would interleave the
      // counter across runs and defeat the shared-salt guarantee.
      const fhir = fhirExtension(run, {
        server: HAPI_SERVER,
        random: fixedRandom(),
      });
      // For write ops, the submitted body must be passed to operation(),
      // not just commitResponse — the recorder reads it from the input.
      const op = fhir.operation({
        method,
        baseUrl: HAPI_BASE_URL,
        path,
        ...(method !== "GET" ? { body } : {}),
      });
      if (extra !== undefined) {
        await extra(op, body);
      } else {
        await op.commitResponse({ status: 200, body });
      }
      const receipt = await run.finalize();
      const event = receipt.events.find((e) => e.type.startsWith("org.hl7.fhir."));
      if (event === undefined) {
        throw new Error("no FHIR event recorded");
      }
      return event;
    }),
  );
  const [a, b] = runs;
  if (a === undefined || b === undefined) throw new Error("expected two runs");
  return { a, b };
}

describe("same input → same commitment (Same State invariant)", () => {
  it("read: two runs with a shared random produce identical Patient commitments", async () => {
    const { a, b } = await twoRunsHitting(
      "/Patient/123",
      "GET",
      PATIENT_123(),
    );
    expect(a.type).toBe(FHIR_EVENT_KINDS.resourceRead);
    expect(b.type).toBe(FHIR_EVENT_KINDS.resourceRead);
    const aInner = (a.payload as { value: { commitment: { digest: string } } })
      .value.commitment.digest;
    const bInner = (b.payload as { value: { commitment: { digest: string } } })
      .value.commitment.digest;
    expect(aInner).toBe(bInner);
  });

  it("search: identical Bundle bodies commit to identical digests", async () => {
    const { a, b } = await twoRunsHitting(
      "/Observation",
      "GET",
      OBSERVATION_SEARCHSET(),
    );
    expect(a.type).toBe(FHIR_EVENT_KINDS.search);
    const aInner = (a.payload as {
      value: { bundle: { commitment: { digest: string } } };
    }).value.bundle.commitment.digest;
    const bInner = (b.payload as {
      value: { bundle: { commitment: { digest: string } } };
    }).value.bundle.commitment.digest;
    expect(aInner).toBe(bInner);
  });

  it("write: identical submitted bodies produce identical submitted commitments", async () => {
    const submitted = {
      resourceType: "ClinicalImpression",
      status: "completed",
      subject: { reference: "Patient/123" },
      summary: "same-state probe",
    };
    const { a, b } = await twoRunsHitting(
      "/ClinicalImpression",
      "POST",
      submitted,
      async (op) => {
        // No response body — only submitted matters for this property.
        await op.commitResponse({ status: 201 });
      },
    );
    expect(a.type).toBe(FHIR_EVENT_KINDS.resourceWrite);
    const aInner = (a.payload as {
      value: { submitted?: { commitment: { digest: string } } };
    }).value.submitted?.commitment.digest;
    const bInner = (b.payload as {
      value: { submitted?: { commitment: { digest: string } } };
    }).value.submitted?.commitment.digest;
    expect(aInner).toBeDefined();
    expect(aInner).toBe(bInner);
  });

  it("without a shared random, digests DIVERGE by design (salting is doing its job)", async () => {
    // Regression guard on the other direction: two runs with the DEFAULT
    // random must NOT produce equal digests — that would mean salting
    // silently broke and PHI became dictionary-attackable.
    const run1 = await createReceipt(deterministicOptions());
    const run2 = await createReceipt(deterministicOptions());
    const fhir1 = fhirExtension(run1, { server: HAPI_SERVER });
    const fhir2 = fhirExtension(run2, { server: HAPI_SERVER });
    const body = PATIENT_123();
    await fhir1
      .operation({ method: "GET", baseUrl: HAPI_BASE_URL, path: "/Patient/123" })
      .commitResponse({ status: 200, body });
    await fhir2
      .operation({ method: "GET", baseUrl: HAPI_BASE_URL, path: "/Patient/123" })
      .commitResponse({ status: 200, body });
    const receipt1 = await run1.finalize();
    const receipt2 = await run2.finalize();
    const e1 = receipt1.events.find((e) => e.type === FHIR_EVENT_KINDS.resourceRead);
    const e2 = receipt2.events.find((e) => e.type === FHIR_EVENT_KINDS.resourceRead);
    const d1 = (e1?.payload as { value: { commitment: { digest: string } } })
      .value.commitment.digest;
    const d2 = (e2?.payload as { value: { commitment: { digest: string } } })
      .value.commitment.digest;
    expect(d1).not.toBe(d2);
  });
});
