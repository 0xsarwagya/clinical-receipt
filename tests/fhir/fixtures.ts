import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import type { ReceiptRun } from "../../src/recorder/receipt.js";
import { createReceipt } from "../../src/recorder/receipt.js";
import { deterministicOptions } from "../fixtures.js";

export const HAPI_BASE_URL = "https://hapi.fhir.org/baseR4";
export const HAPI_SERVER = { id: "hapi-r4-public" };

function loadFixture<T = unknown>(name: string): T {
  const path = resolve(__dirname, "fixtures", name);
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

export const PATIENT_123 = () => loadFixture("patient-123.json");
export const OBSERVATION_SEARCHSET = () => loadFixture("observation-searchset.json");
export const CLINICAL_IMPRESSION_PERSISTED = () =>
  loadFixture("clinical-impression-persisted.json");

/** Build a receipt run with the standard deterministic clock + random. */
export async function deterministicRun(): Promise<ReceiptRun> {
  return createReceipt(deterministicOptions());
}
