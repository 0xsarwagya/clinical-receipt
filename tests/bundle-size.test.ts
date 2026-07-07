import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Permanent regression guard: importing the root package barrel MUST
 * NOT pull in any FHIR code. The `sideEffects` list in package.json
 * and the tsup entry configuration keep the two subpaths independent;
 * this test proves the emitted bundle keeps the boundary honest.
 */

const distDir = resolve(__dirname, "..", "dist");

describe("bundle-size boundary", () => {
  it("dist/index.js contains zero FHIR code", () => {
    const path = resolve(distDir, "index.js");
    if (!existsSync(path)) {
      throw new Error("run pnpm build before this test");
    }
    const source = readFileSync(path, "utf8");
    // Any of these strings appearing in the root bundle would mean the
    // FHIR module got tree-shake-included through a transitive import.
    const forbidden = [
      "org.hl7.fhir",
      "FHIR_NAMESPACE",
      "fhir-json-r4",
      "fhirExtension",
      "instrumentFHIRFetch",
      "instrumentFHIR(",
      "verifyFHIR",
      "inspectFHIR",
    ];
    for (const needle of forbidden) {
      expect
        .soft(source.includes(needle), `dist/index.js contains ${JSON.stringify(needle)}`)
        .toBe(false);
    }
  });

  it("dist/verify.js contains zero FHIR code", () => {
    const path = resolve(distDir, "verify.js");
    if (!existsSync(path)) {
      throw new Error("run pnpm build before this test");
    }
    const source = readFileSync(path, "utf8");
    const forbidden = [
      "org.hl7.fhir",
      "FHIR_NAMESPACE",
      "fhir-json-r4",
      "instrumentFHIRFetch",
      "verifyFHIR",
    ];
    for (const needle of forbidden) {
      expect
        .soft(source.includes(needle), `dist/verify.js contains ${JSON.stringify(needle)}`)
        .toBe(false);
    }
  });

  it("dist/fhir.js DOES contain FHIR code", () => {
    const path = resolve(distDir, "fhir.js");
    if (!existsSync(path)) {
      throw new Error("run pnpm build before this test");
    }
    const source = readFileSync(path, "utf8");
    expect(source.includes("org.hl7.fhir")).toBe(true);
    expect(source.includes("fhir-json-r4")).toBe(true);
  });
});
