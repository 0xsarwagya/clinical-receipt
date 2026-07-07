import { describe, expect, it } from "vitest";

import { fhirExtension } from "../../src/fhir/operation.js";
import { FHIR_EVENT_KINDS, FHIR_NAMESPACE } from "../../src/fhir/constants.js";
import { verifyReceipt } from "../../src/verify/receipt.js";
import { verifyFHIR } from "../../src/verify/fhir.js";
import { fixedRandom } from "../fixtures.js";
import {
  HAPI_BASE_URL,
  HAPI_SERVER,
  OBSERVATION_SEARCHSET,
  PATIENT_123,
  deterministicRun,
} from "./fixtures.js";

async function baseReceipt() {
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
  return run.finalize();
}

describe("adversarial FHIR tamper matrix", () => {
  it("modified resource body flips the payload digest → integrity failure", async () => {
    const receipt = await baseReceipt();
    const clone = JSON.parse(JSON.stringify(receipt));
    const read = clone.events.find(
      (e: { type: string }) => e.type === FHIR_EVENT_KINDS.resourceRead,
    );
    // Mutate the embedded FHIR body — the recorder's payload commitment
    // was over the pristine bytes; changed bytes now fail to match.
    read.payload.value.commitment.digest = read.payload.value.commitment.digest
      .split("")
      .reverse()
      .join("");
    const report = await verifyReceipt(clone);
    expect(report.integrity.events.failed.length).toBeGreaterThan(0);
    expect(report.ok).toBe(false);
  });

  it("modified versionId on a versioned-read fails validation on parse", async () => {
    // The reserved-namespace validator refuses to admit a vread payload
    // without a versionId string on the resource; mutation to omit it
    // makes the receipt structurally invalid.
    const run = await deterministicRun();
    const fhir = fhirExtension(run, { server: HAPI_SERVER });
    await fhir
      .operation({
        method: "GET",
        baseUrl: HAPI_BASE_URL,
        path: "/Patient/123/_history/7",
      })
      .commitResponse({ status: 200, body: PATIENT_123() });
    const receipt = await run.finalize();
    const clone = JSON.parse(JSON.stringify(receipt));
    const vread = clone.events.find(
      (e: { type: string }) => e.type === FHIR_EVENT_KINDS.resourceVersionedRead,
    );
    delete vread.payload.value.resource.versionId;
    const report = await verifyReceipt(clone);
    // The event's commitment was computed over the version-bearing
    // payload; removing the versionId changes the canonical bytes and
    // the recomputed digest no longer matches.
    expect(report.integrity.events.failed.length).toBeGreaterThan(0);
    expect(report.ok).toBe(false);
  });

  it("reordered search results changes the bundle digest → integrity failure", async () => {
    const receipt = await baseReceipt();
    const clone = JSON.parse(JSON.stringify(receipt));
    const search = clone.events.find(
      (e: { type: string }) => e.type === FHIR_EVENT_KINDS.search,
    );
    // Rotate the resource references in the search payload.
    const resources = search.payload.value.bundle.resources;
    search.payload.value.bundle.resources = [resources[1], resources[0]];
    const report = await verifyReceipt(clone);
    expect(report.integrity.events.failed.length).toBeGreaterThan(0);
    expect(report.ok).toBe(false);
  });

  it("a swapped bundle commitment digest is rejected by verifyFHIR", async () => {
    const receipt = await baseReceipt();
    const clone = JSON.parse(JSON.stringify(receipt));
    const search = clone.events.find(
      (e: { type: string }) => e.type === FHIR_EVENT_KINDS.search,
    );
    // Point the bundle at a different digest — an attacker trying to
    // hand-wave which resources were observed. The receipt's own event
    // commitment fails first (integrity), and if we bypassed that the
    // supplied-resource path would still refuse (mismatch).
    search.payload.value.bundle.commitment.digest = "AAAA" + search.payload.value.bundle.commitment.digest.slice(4);
    const report = await verifyReceipt(clone);
    expect(report.integrity.events.failed.length).toBeGreaterThan(0);
    expect(report.ok).toBe(false);
  });

  it("hostile OperationOutcome content is still committed to a stable digest", async () => {
    const run = await deterministicRun();
    const fhir = fhirExtension(run, { server: HAPI_SERVER });
    // Simulate a server returning a huge OperationOutcome body — the
    // commitment must still be a fixed-size digest; nothing about the
    // FHIR content can grow the receipt unboundedly.
    const hostile = {
      resourceType: "OperationOutcome",
      issue: Array.from({ length: 500 }, () => ({
        severity: "error",
        diagnostics: "x".repeat(200),
      })),
    };
    await fhir
      .operation({ method: "GET", baseUrl: HAPI_BASE_URL, path: "/Patient/missing" })
      .commitError({ httpStatus: 404, operationOutcome: hostile });
    const receipt = await run.finalize();
    const report = await verifyReceipt(receipt);
    expect(report.integrity.root).toBe("verified");
    const error = receipt.events.find(
      (e) => e.type === FHIR_EVENT_KINDS.error,
    );
    expect(error).toBeDefined();
  });

  it("unknown extension namespace does NOT break integrity — it is reported as unknown", async () => {
    const run = await deterministicRun();
    await run.event(
      "com.example.custom.marker",
      { value: { note: "hello" }, mode: "embedded", embed: true },
    );
    const receipt = await run.finalize();
    const report = await verifyReceipt(receipt);
    expect(report.integrity.root).toBe("verified");
    expect(report.extensions.understood).not.toContain(FHIR_NAMESPACE);
    expect(report.extensions.unknown.some((u) => u.startsWith("com.example"))).toBe(true);
  });
});
