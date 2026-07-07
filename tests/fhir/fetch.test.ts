import { describe, expect, it } from "vitest";

import { FHIR_EVENT_KINDS } from "../../src/fhir/constants.js";
import { instrumentFHIRFetch } from "../../src/fhir/fetch.js";
import {
  CLINICAL_IMPRESSION_PERSISTED,
  HAPI_BASE_URL,
  HAPI_SERVER,
  OBSERVATION_SEARCHSET,
  PATIENT_123,
  deterministicRun,
} from "./fixtures.js";

/**
 * A minimal in-memory fetch that returns pre-canned FHIR responses for
 * the routes the test drives. Any URL outside `HAPI_BASE_URL` returns
 * 502 so we can also assert pass-through.
 */
function fakeFetch(): typeof fetch {
  return async (input, init) => {
    const url = typeof input === "string"
      ? new URL(input)
      : input instanceof URL
        ? input
        : new URL((input as Request).url);
    const method =
      (init?.method as string | undefined)?.toUpperCase() ??
      (input instanceof Request ? input.method.toUpperCase() : "GET");
    if (!url.href.startsWith(HAPI_BASE_URL)) {
      return new Response(null, { status: 502 });
    }
    const path = url.pathname.slice(new URL(HAPI_BASE_URL).pathname.length);
    if (method === "GET" && path === "/Patient/123") {
      return new Response(JSON.stringify(PATIENT_123()), {
        status: 200,
        headers: { "content-type": "application/fhir+json", etag: 'W/"7"' },
      });
    }
    if (method === "GET" && path === "/Observation") {
      return new Response(JSON.stringify(OBSERVATION_SEARCHSET()), {
        status: 200,
        headers: { "content-type": "application/fhir+json" },
      });
    }
    if (method === "POST" && path === "/ClinicalImpression") {
      return new Response(JSON.stringify(CLINICAL_IMPRESSION_PERSISTED()), {
        status: 201,
        headers: {
          "content-type": "application/fhir+json",
          location: `${HAPI_BASE_URL}/ClinicalImpression/789/_history/1`,
        },
      });
    }
    if (method === "GET" && path === "/Patient/missing") {
      return new Response(
        JSON.stringify({
          resourceType: "OperationOutcome",
          issue: [{ severity: "error", code: "not-found" }],
        }),
        { status: 404, headers: { "content-type": "application/fhir+json" } },
      );
    }
    return new Response(null, { status: 404 });
  };
}

describe("instrumentFHIRFetch", () => {
  it("records read, search, create through a fake fetch and preserves the response body", async () => {
    const run = await deterministicRun();
    const wrapped = instrumentFHIRFetch(fakeFetch(), {
      run,
      baseUrl: HAPI_BASE_URL,
      server: HAPI_SERVER,
    });
    const read = await wrapped(`${HAPI_BASE_URL}/Patient/123`);
    const readBody = (await read.json()) as { resourceType: string; id: string };
    expect(readBody.resourceType).toBe("Patient");
    expect(readBody.id).toBe("123");

    const search = await wrapped(
      `${HAPI_BASE_URL}/Observation?patient=123&category=laboratory`,
    );
    const searchBody = (await search.json()) as { entry: unknown[] };
    expect(searchBody.entry).toHaveLength(2);

    const create = await wrapped(`${HAPI_BASE_URL}/ClinicalImpression`, {
      method: "POST",
      body: JSON.stringify({
        resourceType: "ClinicalImpression",
        status: "completed",
        subject: { reference: "Patient/123" },
      }),
    });
    expect(create.status).toBe(201);

    const receipt = await run.finalize();
    const kinds = receipt.events.map((e) => e.type);
    expect(kinds).toContain(FHIR_EVENT_KINDS.resourceRead);
    expect(kinds).toContain(FHIR_EVENT_KINDS.search);
    expect(kinds).toContain(FHIR_EVENT_KINDS.resourceWrite);
  });

  it("passes non-FHIR requests through untouched", async () => {
    const run = await deterministicRun();
    const wrapped = instrumentFHIRFetch(fakeFetch(), {
      run,
      baseUrl: HAPI_BASE_URL,
    });
    const response = await wrapped("https://otherapp.example/telemetry");
    // The fake fetch returns 502 for non-FHIR origins — passed through.
    expect(response.status).toBe(502);
    const receipt = await run.finalize();
    for (const event of receipt.events) {
      expect(event.type.startsWith("org.hl7.fhir")).toBe(false);
    }
  });

  it("commits an error event on HTTP 4xx and reads OperationOutcome commitment", async () => {
    const run = await deterministicRun();
    const wrapped = instrumentFHIRFetch(fakeFetch(), {
      run,
      baseUrl: HAPI_BASE_URL,
    });
    const response = await wrapped(`${HAPI_BASE_URL}/Patient/missing`);
    expect(response.status).toBe(404);
    const receipt = await run.finalize();
    const error = receipt.events.find(
      (e) => e.type === FHIR_EVENT_KINDS.error,
    );
    const value = (error?.payload as {
      value: {
        httpStatus?: number;
        operationOutcome?: { commitment: { canonicalization: string } };
      };
    }).value;
    expect(value.httpStatus).toBe(404);
    expect(value.operationOutcome?.commitment.canonicalization).toBe(
      "fhir-json-r4@1",
    );
  });

  it("filters response headers to the allowlist and drops blocked headers", async () => {
    const run = await deterministicRun();
    const wrapped = instrumentFHIRFetch(fakeFetch(), {
      run,
      baseUrl: HAPI_BASE_URL,
      privacy: { headers: ["etag", "content-location"] },
    });
    await wrapped(`${HAPI_BASE_URL}/Patient/123`);
    const receipt = await run.finalize();
    const read = receipt.events.find(
      (e) => e.type === FHIR_EVENT_KINDS.resourceRead,
    );
    const value = (read?.payload as {
      value: { responseHeaders?: Record<string, string> };
    }).value;
    expect(value.responseHeaders?.etag).toBe('W/"7"');
    // content-type is NOT on the allowlist → not committed.
    expect(value.responseHeaders?.["content-type"]).toBeUndefined();
  });
});
