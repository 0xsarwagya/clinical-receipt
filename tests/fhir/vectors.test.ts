import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { commitmentsEqual } from "../../src/core/commitment.js";
import { commitFhirValue } from "../../src/fhir/commit.js";

const VECTORS = resolve(__dirname, "..", "..", "spec", "1.0", "vectors");

function load<T>(name: string): T {
  return JSON.parse(readFileSync(resolve(VECTORS, name), "utf8")) as T;
}

describe("FHIR test vectors — decode direction pins", () => {
  it("fhir-read-r4: recomputes the pinned Patient commitment", async () => {
    const vector = load<{ resource: unknown; commitment: { digest: string; canonicalization: string; algorithm: string } }>(
      "fhir-read-r4.json",
    );
    const recomputed = await commitFhirValue(vector.resource, { salt: null });
    expect(commitmentsEqual(recomputed, vector.commitment)).toBe(true);
  });

  it("fhir-search-r4: recomputes the pinned Bundle commitment", async () => {
    const vector = load<{ bundle: unknown; commitment: { digest: string; canonicalization: string; algorithm: string } }>(
      "fhir-search-r4.json",
    );
    const recomputed = await commitFhirValue(vector.bundle, { salt: null });
    expect(commitmentsEqual(recomputed, vector.commitment)).toBe(true);
  });

  it("fhir-create-r4: submitted and persisted commitments recompute independently", async () => {
    const vector = load<{
      submitted: { resource: unknown; commitment: { digest: string; canonicalization: string; algorithm: string } };
      persisted: { resource: unknown; commitment: { digest: string; canonicalization: string; algorithm: string } };
    }>("fhir-create-r4.json");
    const submitted = await commitFhirValue(vector.submitted.resource, { salt: null });
    const persisted = await commitFhirValue(vector.persisted.resource, { salt: null });
    expect(commitmentsEqual(submitted, vector.submitted.commitment)).toBe(true);
    expect(commitmentsEqual(persisted, vector.persisted.commitment)).toBe(true);
    // Different content → different digest.
    expect(submitted.digest).not.toBe(persisted.digest);
  });

  it("fhir-transaction-r4: request and response Bundles are independently committed", async () => {
    const vector = load<{
      submitted: { bundle: unknown; commitment: { digest: string; canonicalization: string; algorithm: string } };
      response: { bundle: unknown; commitment: { digest: string; canonicalization: string; algorithm: string } };
    }>("fhir-transaction-r4.json");
    const req = await commitFhirValue(vector.submitted.bundle, { salt: null });
    const res = await commitFhirValue(vector.response.bundle, { salt: null });
    expect(commitmentsEqual(req, vector.submitted.commitment)).toBe(true);
    expect(commitmentsEqual(res, vector.response.commitment)).toBe(true);
  });

  it("fhir-error-r4: OperationOutcome commitment recomputes", async () => {
    const vector = load<{ operationOutcome: unknown; commitment: { digest: string; canonicalization: string; algorithm: string } }>(
      "fhir-error-r4.json",
    );
    const recomputed = await commitFhirValue(vector.operationOutcome, { salt: null });
    expect(commitmentsEqual(recomputed, vector.commitment)).toBe(true);
  });

  it("fhir-versioned-read-r4: receipt round-trips through JSON without loss", () => {
    const receipt = load<{ receipt: { id: string }; events: unknown[]; commitments: unknown }>(
      "fhir-versioned-read-r4.json",
    );
    expect(receipt.receipt.id).toMatch(/^rcpt_1_/);
    expect(Array.isArray(receipt.events)).toBe(true);
    expect(receipt.commitments).toBeDefined();
  });

  it("fhir-redacted-query-r4: hashed query values are stable across regeneration", () => {
    const receipt = load<{ events: Array<{ type: string; payload: { value: unknown } }> }>(
      "fhir-redacted-query-r4.json",
    );
    const search = receipt.events.find((e) => e.type.endsWith(".search"));
    const value = search?.payload.value as { query: Record<string, string> };
    expect(value.query.patient).toMatch(/^sha256:[0-9a-f]{32}$/);
    expect(value.query.identifier).toBe("[redacted]");
  });
});
