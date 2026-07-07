import { describe, expect, it } from "vitest";

import { fhirExtension } from "../../src/fhir/operation.js";
import { inspectFHIR } from "../../src/fhir/inspect.js";
import {
  CLINICAL_IMPRESSION_PERSISTED,
  HAPI_BASE_URL,
  HAPI_SERVER,
  OBSERVATION_SEARCHSET,
  PATIENT_123,
  deterministicRun,
} from "./fixtures.js";

describe("inspectFHIR", () => {
  it("projects reads, searches, writes into a trace shape", async () => {
    const run = await deterministicRun();
    const fhir = fhirExtension(run, { server: HAPI_SERVER });
    await fhir
      .operation({ method: "GET", baseUrl: HAPI_BASE_URL, path: "/Patient/123" })
      .commitResponse({ status: 200, body: PATIENT_123() });
    await fhir
      .operation({
        method: "GET",
        baseUrl: HAPI_BASE_URL,
        path: "/Observation",
        query: { patient: "123" },
      })
      .commitResponse({ status: 200, body: OBSERVATION_SEARCHSET() });
    await fhir
      .operation({
        method: "POST",
        baseUrl: HAPI_BASE_URL,
        path: "/ClinicalImpression",
        body: { resourceType: "ClinicalImpression", status: "completed" },
      })
      .commitResponse({ status: 201, body: CLINICAL_IMPRESSION_PERSISTED() });
    const receipt = await run.finalize();

    const trace = inspectFHIR(receipt);
    expect(trace.servers).toHaveLength(1);
    expect(trace.servers[0]?.id).toBe(HAPI_SERVER.id);
    expect(trace.reads).toHaveLength(1);
    expect(trace.reads[0]?.resource.type).toBe("Patient");
    expect(trace.searches).toHaveLength(1);
    expect(trace.searches[0]?.resources).toHaveLength(2);
    expect(trace.writes).toHaveLength(1);
    expect(trace.writes[0]?.persisted?.versionId).toBe("1");
    expect(trace.errors).toHaveLength(0);
    // Sequential FHIR events default to a linear DAG through the recorder.
    expect(trace.lineage.length).toBeGreaterThan(0);
  });
});
