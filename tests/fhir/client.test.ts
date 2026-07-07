import { describe, expect, it } from "vitest";

import { isReceiptError } from "../../src/errors.js";
import { instrumentFHIR } from "../../src/fhir/client.js";
import { FHIR_EVENT_KINDS } from "../../src/fhir/constants.js";
import {
  HAPI_BASE_URL,
  PATIENT_123,
  deterministicRun,
} from "./fixtures.js";

function fakeClientFetch(): typeof fetch {
  return async (input) => {
    const url = typeof input === "string"
      ? new URL(input)
      : input instanceof URL
        ? input
        : new URL((input as Request).url);
    if (
      url.origin === new URL(HAPI_BASE_URL).origin &&
      url.pathname.endsWith("/Patient/123")
    ) {
      return new Response(JSON.stringify(PATIENT_123()), {
        status: 200,
        headers: { "content-type": "application/fhir+json" },
      });
    }
    return new Response(null, { status: 404 });
  };
}

describe("instrumentFHIR", () => {
  it("wraps a client's fetch in place and records subsequent operations", async () => {
    const run = await deterministicRun();
    const client = { baseUrl: HAPI_BASE_URL, fetch: fakeClientFetch() };
    const instrumented = instrumentFHIR({ run, client });
    // The wrapped client is the same object; only its fetch is swapped.
    expect(instrumented).toBe(client);
    const response = await instrumented.fetch(`${HAPI_BASE_URL}/Patient/123`);
    expect(response.status).toBe(200);
    const receipt = await run.finalize();
    const read = receipt.events.find(
      (e) => e.type === FHIR_EVENT_KINDS.resourceRead,
    );
    expect(read).toBeDefined();
  });

  it("refuses to instrument a client without a fetch method", async () => {
    const run = await deterministicRun();
    // biome-ignore lint/suspicious/noExplicitAny: intentional shape mismatch
    const bad = { baseUrl: HAPI_BASE_URL } as unknown as {
      baseUrl: string;
      fetch: typeof fetch;
    };
    try {
      instrumentFHIR({ run, client: bad });
      expect.fail("expected PARTIAL_INSTRUMENTATION_UNSAFE");
    } catch (error) {
      expect(isReceiptError(error)).toBe(true);
      expect((error as { code: string }).code).toBe(
        "PARTIAL_INSTRUMENTATION_UNSAFE",
      );
    }
  });

  it("refuses a client without a baseUrl", async () => {
    const run = await deterministicRun();
    // biome-ignore lint/suspicious/noExplicitAny: intentional shape mismatch
    const bad = { fetch: fakeClientFetch() } as unknown as {
      baseUrl: string;
      fetch: typeof fetch;
    };
    try {
      instrumentFHIR({ run, client: bad });
      expect.fail("expected INVALID_ARGUMENT");
    } catch (error) {
      expect(isReceiptError(error)).toBe(true);
      expect((error as { code: string }).code).toBe("INVALID_ARGUMENT");
    }
  });
});
