import { describe, expect, it } from "vitest";

import { isReceiptError } from "../../src/errors.js";
import { fhirExtension } from "../../src/fhir/operation.js";
import {
  FHIR_EVENT_KINDS,
  FHIR_NAMESPACE,
} from "../../src/fhir/constants.js";
import {
  CLINICAL_IMPRESSION_PERSISTED,
  HAPI_BASE_URL,
  HAPI_SERVER,
  OBSERVATION_SEARCHSET,
  PATIENT_123,
  deterministicRun,
} from "./fixtures.js";

describe("fhirExtension.operation", () => {
  it("records a read event bound to the FHIR namespace", async () => {
    const run = await deterministicRun();
    const fhir = fhirExtension(run, { server: HAPI_SERVER });
    const op = fhir.operation({
      method: "GET",
      baseUrl: HAPI_BASE_URL,
      path: "/Patient/123",
    });
    const event = await op.commitResponse({ status: 200, body: PATIENT_123() });
    expect(event.commitment.canonicalization).toBe("clinical-receipt-event@1");
    const receipt = await run.finalize();
    const recorded = receipt.events.find(
      (e) => e.type === FHIR_EVENT_KINDS.resourceRead,
    );
    expect(recorded).toBeDefined();
    expect(recorded?.payload.mode).toBe("embedded");
    const payload = (recorded?.payload as { value: { server: { id: string } } }).value;
    expect(payload.server.id).toBe(HAPI_SERVER.id);
  });

  it("records a versioned-read as a distinct event kind with versionId pinned", async () => {
    const run = await deterministicRun();
    const fhir = fhirExtension(run, { server: HAPI_SERVER });
    const op = fhir.operation({
      method: "GET",
      baseUrl: HAPI_BASE_URL,
      path: "/Patient/123/_history/7",
    });
    await op.commitResponse({ status: 200, body: PATIENT_123() });
    const receipt = await run.finalize();
    const recorded = receipt.events.find(
      (e) => e.type === FHIR_EVENT_KINDS.resourceVersionedRead,
    );
    expect(recorded).toBeDefined();
    const value = (recorded?.payload as { value: { resource: { versionId: string }; versionPinned: true } }).value;
    expect(value.resource.versionId).toBe("7");
    expect(value.versionPinned).toBe(true);
  });

  it("records a search event with observed resources", async () => {
    const run = await deterministicRun();
    const fhir = fhirExtension(run, { server: HAPI_SERVER });
    const op = fhir.operation({
      method: "GET",
      baseUrl: HAPI_BASE_URL,
      path: "/Observation",
      query: { patient: "123", category: "laboratory" },
    });
    await op.commitResponse({ status: 200, body: OBSERVATION_SEARCHSET() });
    const receipt = await run.finalize();
    const searchEvent = receipt.events.find(
      (e) => e.type === FHIR_EVENT_KINDS.search,
    );
    const value = (searchEvent?.payload as {
      value: { bundle: { resources: Array<{ type: string; versionId?: string }> }; pagination: string; total?: number };
    }).value;
    expect(value.bundle.resources).toHaveLength(2);
    expect(value.bundle.resources[0]?.type).toBe("Observation");
    expect(value.bundle.resources[0]?.versionId).toBe("4");
    expect(value.pagination).toBe("complete");
    expect(value.total).toBe(2);
  });

  it("records a create event with both submitted and persisted commitments", async () => {
    const run = await deterministicRun();
    const fhir = fhirExtension(run, { server: HAPI_SERVER });
    const submitted = {
      resourceType: "ClinicalImpression",
      status: "completed",
      subject: { reference: "Patient/123" },
      summary: "Consider urgent cardiology review.",
    };
    const op = fhir.operation({
      method: "POST",
      baseUrl: HAPI_BASE_URL,
      path: "/ClinicalImpression",
      body: submitted,
    });
    await op.commitResponse({
      status: 201,
      body: CLINICAL_IMPRESSION_PERSISTED(),
      headers: {
        location: "https://hapi.fhir.org/baseR4/ClinicalImpression/789/_history/1",
        "content-type": "application/fhir+json",
      },
    });
    const receipt = await run.finalize();
    const write = receipt.events.find(
      (e) => e.type === FHIR_EVENT_KINDS.resourceWrite,
    );
    const value = (write?.payload as {
      value: {
        operation: string;
        submitted?: { commitment: unknown };
        persisted?: { commitment: unknown; resource: { versionId?: string } };
        location?: string;
      };
    }).value;
    expect(value.operation).toBe("create");
    expect(value.submitted).toBeDefined();
    expect(value.persisted).toBeDefined();
    expect(value.persisted?.resource.versionId).toBe("1");
    expect(value.location).toContain("ClinicalImpression/789/_history/1");
  });

  it("applies query privacy transforms and records the policy", async () => {
    const run = await deterministicRun();
    const fhir = fhirExtension(run, {
      server: HAPI_SERVER,
      privacy: { query: { patient: "hash", identifier: "redact" } },
    });
    await fhir
      .operation({
        method: "GET",
        baseUrl: HAPI_BASE_URL,
        path: "/Observation",
        query: { patient: "123", identifier: "SSN-42", status: "final" },
      })
      .commitResponse({ status: 200, body: OBSERVATION_SEARCHSET() });
    const receipt = await run.finalize();
    const search = receipt.events.find(
      (e) => e.type === FHIR_EVENT_KINDS.search,
    );
    const value = (search?.payload as {
      value: {
        query: Record<string, string>;
        privacy?: { query?: Record<string, string> };
      };
    }).value;
    expect(value.query.patient).toMatch(/^sha256:[0-9a-f]{32}$/);
    expect(value.query.identifier).toBe("[redacted]");
    expect(value.query.status).toBe("final");
    expect(value.privacy?.query?.patient).toBe("hash");
  });

  it("rejects wildcard header allowlists", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(() =>
      // biome-ignore lint/style/noNonNullAssertion: intentionally malformed input
      fhirExtension({} as never, {
        server: HAPI_SERVER,
        privacy: { headers: ["*"] },
      }),
    ).toThrow();
  });

  it("rejects reserved-namespace payloads that omit extensionVersion", async () => {
    const run = await deterministicRun();
    try {
      await run.event(
        FHIR_EVENT_KINDS.resourceRead,
        {
          value: { fhirVersion: "R4", server: { id: HAPI_SERVER.id } },
          mode: "embedded",
          embed: true,
        },
      );
      expect.fail("expected extension validation to reject");
    } catch (error) {
      expect(isReceiptError(error)).toBe(true);
      expect((error as { message: string }).message).toContain(FHIR_NAMESPACE);
    }
  });

  it("commits an error event for HTTP failures without leaking the message", async () => {
    const run = await deterministicRun();
    const fhir = fhirExtension(run, { server: HAPI_SERVER });
    await fhir
      .operation({
        method: "GET",
        baseUrl: HAPI_BASE_URL,
        path: "/Patient/missing",
      })
      .commitError({ httpStatus: 404 });
    const receipt = await run.finalize();
    const error = receipt.events.find(
      (e) => e.type === FHIR_EVENT_KINDS.error,
    );
    const value = (error?.payload as {
      value: { httpStatus?: number; reason: string; target: { path: string } };
    }).value;
    expect(value.httpStatus).toBe(404);
    expect(value.reason).toBe("http-4xx");
    expect(value.target.path).toBe("/Patient/missing");
  });
});
