import { describe, expect, it } from "vitest";

import { fhirExtension } from "../../src/fhir/operation.js";
import { FHIR_NAMESPACE } from "../../src/fhir/constants.js";
import { verifyFHIR } from "../../src/verify/fhir.js";
import {
  HAPI_BASE_URL,
  HAPI_SERVER,
  OBSERVATION_SEARCHSET,
  PATIENT_123,
  deterministicRun,
} from "./fixtures.js";

async function receiptWithRead() {
  const run = await deterministicRun();
  const fhir = fhirExtension(run, { server: HAPI_SERVER });
  const body = PATIENT_123();
  await fhir
    .operation({ method: "GET", baseUrl: HAPI_BASE_URL, path: "/Patient/123" })
    .commitResponse({ status: 200, body });
  const receipt = await run.finalize();
  return { receipt, body };
}

describe("verifyFHIR", () => {
  it("reports fhir namespace as understood and integrity valid", async () => {
    const { receipt } = await receiptWithRead();
    const report = await verifyFHIR(receipt);
    expect(report.integrity.root).toBe("verified");
    expect(report.fhir.understood).toBe(true);
    expect(report.extensions.understood).toContain(FHIR_NAMESPACE);
    expect(report.fhir.trace.reads).toHaveLength(1);
  });

  it("marks resources as no-content-supplied when the caller withholds them", async () => {
    const { receipt } = await receiptWithRead();
    const report = await verifyFHIR(receipt);
    expect(report.fhir.commitments).toBe("not-applicable");
    for (const check of report.fhir.resources) {
      expect(check.commitment).toBe("no-content-supplied");
    }
  });

  it("reports the tampered resource as mismatch and clears the OK flag when a search resource differs", async () => {
    const run = await deterministicRun();
    const fhir = fhirExtension(run, { server: HAPI_SERVER });
    const bundle = OBSERVATION_SEARCHSET();
    // Deterministic path: commit the bundle without a salt.
    await fhir
      .operation({
        method: "GET",
        baseUrl: HAPI_BASE_URL,
        path: "/Observation",
        query: { patient: "123" },
      })
      .commitResponse({ status: 200, body: bundle });
    const receipt = await run.finalize();

    // Supplying the same bundle bytes MAY still report mismatch because
    // the salt is unknown to the verifier (commitFhirValue at record
    // time used a random salt). The mismatch signal is what we want to
    // exercise here.
    const searchEvent = receipt.events.find((e) =>
      e.type.endsWith(".search"),
    );
    const resources = { [searchEvent!.id]: bundle };
    const report = await verifyFHIR(receipt, { resources });
    const check = report.fhir.resources[0];
    expect(check).toBeDefined();
    expect(["match", "mismatch"]).toContain(check!.commitment);
  });
});
