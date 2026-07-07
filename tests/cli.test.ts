import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const CLI = path.resolve(__dirname, "..", "dist", "cli.js");
const VECTORS = path.resolve(__dirname, "..", "spec", "1.0", "vectors");

function run(args: string[]) {
  return spawnSync(process.execPath, [CLI, ...args], {
    encoding: "utf8",
  });
}

const skipIfNoBuild = !existsSync(CLI);

describe.skipIf(skipIfNoBuild)("CLI", () => {
  it("verify: exits 0 on the pinned receipt vector", () => {
    const result = run(["verify", path.join(VECTORS, "receipt-minimal.json")]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("ok: true");
    expect(result.stdout).toContain("integrity.root: verified");
  });

  it("verify --json: emits a structured report", () => {
    const result = run([
      "verify",
      "--json",
      path.join(VECTORS, "receipt-minimal.json"),
    ]);
    expect(result.status).toBe(0);
    const report = JSON.parse(result.stdout);
    expect(report.ok).toBe(true);
    expect(report.specification.version).toBe("1.0");
  });

  it("verify --disclosure: exits 0 on a valid disclosure package", () => {
    const result = run([
      "verify",
      "--disclosure",
      path.join(VECTORS, "disclosure-basic.json"),
    ]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("disclosure.complete");
  });

  it("verify: exits 1 on a malformed receipt (not 2 — parse is still a receipt path)", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "clinical-cli-"));
    const broken = path.join(dir, "broken.json");
    writeFileSync(
      broken,
      JSON.stringify({ specification: { name: "clinical-receipt", version: "1.0" } }),
    );
    const result = run(["verify", broken]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("MALFORMED_RECEIPT");
  });

  it("verify: exits 2 when the file argument is missing", () => {
    const result = run(["verify"]);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("missing path");
  });

  it("inspect: prints stats without payload values", () => {
    const result = run(["inspect", path.join(VECTORS, "receipt-minimal.json")]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("workflow:");
    expect(result.stdout).toContain("events:");
    // No payload values leak.
    expect(result.stdout).not.toContain("hello");
    expect(result.stdout).not.toContain("Patient/1");
  });

  it("diff: reports rootsEqual for two identical receipts", () => {
    const result = run([
      "diff",
      path.join(VECTORS, "receipt-minimal.json"),
      path.join(VECTORS, "receipt-minimal.json"),
    ]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("rootsEqual: true");
  });

  it("disclose: produces a package that verify --disclosure accepts", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "clinical-cli-"));
    const out = path.join(dir, "disclosure.json");
    const result = run([
      "disclose",
      path.join(VECTORS, "receipt-minimal.json"),
      "--event",
      "output.*",
      "--out",
      out,
    ]);
    expect(result.status).toBe(0);
    expect(readFileSync(out, "utf8")).toContain("clinical-receipt");
    const verifyResult = run(["verify", "--disclosure", out]);
    expect(verifyResult.status).toBe(0);
  });
});
