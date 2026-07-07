import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Regression guard for a bug shipped in v0.2.0: the
 * `fhir-json-r4@1` canonicalization alias was registered as a
 * module-load side effect, which some bundlers (Turbopack, aggressive
 * webpack configs) tree-shook out even with the sideEffects list in
 * package.json. Consumers then saw
 *   UNSUPPORTED_CANONICALIZATION: unknown canonicalization profile
 *   "fhir-json-r4@1"
 * the first time they touched commitFhirValue.
 *
 * The fix converts both registrations to explicit function calls that
 * every entry point invokes eagerly. This test asserts the bundle
 * contains the actual call, not just the constant string.
 */

const distDir = resolve(__dirname, "..", "..", "dist");

describe("fhir registration survives the bundle", () => {
  it("dist/fhir.js contains the registerFhirCanonicalization call", () => {
    const source = readFileSync(resolve(distDir, "fhir.js"), "utf8");
    // The compiled name may be minified in tsup output, but the underlying
    // registerCanonicalizationProfile call site MUST survive. We assert
    // on the function's own module load — the string
    // "fhir-json-r4@1" ALONE is not enough; it can appear as a constant.
    expect(source).toContain("registerCanonicalizationProfile");
    expect(source).toContain("fhir-json-r4@1");
  });

  it("dist/fhir.js contains the registerReservedNamespace call", () => {
    const source = readFileSync(resolve(distDir, "fhir.js"), "utf8");
    expect(source).toContain("registerReservedNamespace");
  });

  it("dist/verify.js still contains zero FHIR content — boundary intact", () => {
    const source = readFileSync(resolve(distDir, "verify.js"), "utf8");
    expect(source.includes("fhir-json-r4")).toBe(false);
    expect(source.includes("org.hl7.fhir")).toBe(false);
  });
});
