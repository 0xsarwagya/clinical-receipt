import { describe, expect, it } from "vitest";

import { canonicalize } from "../../src/core/canonicalize.js";
import { commitFhirValue } from "../../src/fhir/commit.js";
import { FHIR_CANONICALIZATION } from "../../src/fhir/constants.js";

describe("fhir-json-r4@1", () => {
  it("is registered and produces jcs@1-equivalent bytes", () => {
    const resource = {
      resourceType: "Patient",
      id: "123",
      meta: { versionId: "7", lastUpdated: "2026-07-07T10:00:00.000Z" },
      name: [{ family: "Doe" }],
    };
    const fhir = canonicalize(FHIR_CANONICALIZATION, resource);
    const jcs = canonicalize("jcs@1", resource);
    expect(new Uint8Array(fhir)).toEqual(new Uint8Array(jcs));
  });

  it("sorts object keys deterministically for nested FHIR resources", () => {
    const first = {
      resourceType: "Observation",
      subject: { reference: "Patient/123" },
      code: { coding: [{ system: "http://loinc.org", code: "1234-5" }] },
    };
    const second = {
      code: { coding: [{ code: "1234-5", system: "http://loinc.org" }] },
      subject: { reference: "Patient/123" },
      resourceType: "Observation",
    };
    const a = canonicalize(FHIR_CANONICALIZATION, first);
    const b = canonicalize(FHIR_CANONICALIZATION, second);
    expect(new Uint8Array(a)).toEqual(new Uint8Array(b));
  });

  it("preserves array order (search results, contained resources)", () => {
    const ordered = { entry: [{ id: "a" }, { id: "b" }, { id: "c" }] };
    const reversed = { entry: [{ id: "c" }, { id: "b" }, { id: "a" }] };
    const a = canonicalize(FHIR_CANONICALIZATION, ordered);
    const b = canonicalize(FHIR_CANONICALIZATION, reversed);
    expect(new Uint8Array(a)).not.toEqual(new Uint8Array(b));
  });

  it("carries FHIR primitive-extension keys transparently", () => {
    const resource = {
      resourceType: "Patient",
      birthDate: "2000-01-01",
      _birthDate: { extension: [{ url: "http://x", valueString: "explanatory" }] },
    };
    // Just proves canonicalization does not choke on `_` keys.
    const bytes = canonicalize(FHIR_CANONICALIZATION, resource);
    expect(bytes.length).toBeGreaterThan(0);
  });
});

describe("commitFhirValue", () => {
  it("produces a Commitment tagged with fhir-json-r4@1", async () => {
    const resource = { resourceType: "Patient", id: "1" };
    const commitment = await commitFhirValue(resource, {
      salt: new Uint8Array(16).fill(1),
    });
    expect(commitment.algorithm).toBe("sha-256");
    expect(commitment.canonicalization).toBe(FHIR_CANONICALIZATION);
    expect(commitment.digest).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("is deterministic when given the same salt", async () => {
    const resource = { resourceType: "Patient", id: "1" };
    const salt = new Uint8Array(16).fill(9);
    const first = await commitFhirValue(resource, { salt });
    const second = await commitFhirValue(resource, { salt });
    expect(first.digest).toBe(second.digest);
  });

  it("differs when the FHIR body differs", async () => {
    const salt = new Uint8Array(16);
    const a = await commitFhirValue({ resourceType: "Patient", id: "1" }, { salt });
    const b = await commitFhirValue({ resourceType: "Patient", id: "2" }, { salt });
    expect(a.digest).not.toBe(b.digest);
  });

  it("differs when the salt differs, all else equal", async () => {
    const value = { resourceType: "Patient", id: "1" };
    const a = await commitFhirValue(value, { salt: new Uint8Array(16).fill(1) });
    const b = await commitFhirValue(value, { salt: new Uint8Array(16).fill(2) });
    expect(a.digest).not.toBe(b.digest);
  });
});
