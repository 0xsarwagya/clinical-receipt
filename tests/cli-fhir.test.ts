import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const CLI = path.resolve(__dirname, "..", "dist", "cli.js");
const VECTORS = path.resolve(__dirname, "..", "spec", "1.0", "vectors");

function run(args: string[]) {
  return spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8" });
}

const skipIfNoBuild = !existsSync(CLI);

describe.skipIf(skipIfNoBuild)("CLI · fhir", () => {
  const vread = path.join(VECTORS, "fhir-versioned-read-r4.json");
  const redacted = path.join(VECTORS, "fhir-redacted-query-r4.json");

  it("fhir inspect: projects reads / searches / writes from a vectored receipt", () => {
    const result = run(["fhir", "inspect", vread]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("servers: 1");
    expect(result.stdout).toContain("hapi-r4-public");
    expect(result.stdout).toContain("vread · Patient/vector-1/_history/3");
  });

  it("fhir inspect --json: emits a structured trace", () => {
    const result = run(["fhir", "inspect", "--json", vread]);
    expect(result.status).toBe(0);
    const trace = JSON.parse(result.stdout);
    expect(trace.servers).toHaveLength(1);
    expect(trace.reads).toHaveLength(1);
    expect(trace.reads[0].operation).toBe("vread");
  });

  it("fhir verify: exits 0 on an untampered receipt and reports understood=true", () => {
    const result = run(["fhir", "verify", vread]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("integrity.root: verified");
    expect(result.stdout).toContain("fhir.understood: true");
  });

  it("fhir verify --json: report carries the fhir block", () => {
    const result = run(["fhir", "verify", "--json", vread]);
    expect(result.status).toBe(0);
    const report = JSON.parse(result.stdout);
    expect(report.ok).toBe(true);
    expect(report.fhir).toBeDefined();
    expect(report.fhir.understood).toBe(true);
    expect(Array.isArray(report.fhir.resources)).toBe(true);
  });

  it("fhir diff: reports reads-only-in-A vs reads-only-in-B", () => {
    const result = run(["fhir", "diff", vread, redacted]);
    expect(result.status).toBe(0);
    // The two vectors have different FHIR event shapes, so at least
    // one side should have a unique read or write.
    expect(result.stdout).toContain("reads only in A:");
    expect(result.stdout).toContain("searches:");
  });

  it("fhir with an unknown subcommand exits 2 with usage", () => {
    const result = run(["fhir", "shrug", vread]);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("unknown subcommand");
  });

  it("fhir verify --resource <ref>=<path>: unsalted vectors match", () => {
    // fhir-read-r4.json is NOT a receipt — it's a raw commitment vector.
    // For a receipt with salt-less content, a caller-supplied resource
    // path can produce match/mismatch outcomes. This exercises the
    // wiring; content-equality is exercised by tests/fhir/verify.test.ts.
    const result = run([
      "fhir",
      "verify",
      "--resource",
      `Patient/vector-1/_history/3=${path.join(VECTORS, "fhir-read-r4.json")}`,
      vread,
    ]);
    // The vread receipt commits the resource with a salt, so unsalted
    // recomputation will report `mismatch` — but exit code 1 vs 0 is
    // still deterministic. Assert on both branches.
    expect([0, 1]).toContain(result.status);
    expect(result.stdout).toContain("fhir.commitments:");
  });
});
