import { describe, expect, it } from "vitest";

import {
  createEd25519Signer,
  exportVerificationKey,
  importVerificationKey,
} from "../src/signing/webcrypto.js";
import { verifyReceipt } from "../src/verify/receipt.js";
import { verifyDisclosure } from "../src/verify/disclosure.js";
import { disclose } from "../src/disclosure/disclose.js";
import { buildFullRun, fixedRandom } from "./fixtures.js";

async function finalizedReceipt() {
  const run = await buildFullRun();
  const signer = await createEd25519Signer({ generate: true });
  const receipt = await run.finalize({ signer });
  const key = await importVerificationKey(exportVerificationKey(signer));
  return { receipt, key };
}

describe("verifyReceipt", () => {
  it("accepts an untouched receipt with signature verified", async () => {
    const { receipt, key } = await finalizedReceipt();
    const report = await verifyReceipt(receipt, { keys: [key] });
    expect(report.ok).toBe(true);
    expect(report.integrity.root).toBe("verified");
    expect(report.integrity.events.total).toBe(receipt.events.length);
    expect(report.integrity.events.failed).toHaveLength(0);
    expect(report.signatures[0]?.status).toBe("verified");
    expect(report.warnings.some((w) => w.code === "NO_EXTERNAL_TIMESTAMP")).toBe(
      true,
    );
    expect(report.reproducibility.nondeterministic).toBe("not-claimed");
  });

  it("survives round-trip through JSON", async () => {
    const { receipt, key } = await finalizedReceipt();
    const roundTripped = JSON.parse(JSON.stringify(receipt));
    const report = await verifyReceipt(roundTripped, { keys: [key] });
    expect(report.ok).toBe(true);
  });

  it("falls back to embedded JWK as self-attested when no trusted key is provided", async () => {
    const { receipt } = await finalizedReceipt();
    const report = await verifyReceipt(receipt);
    // Signer embedded its own JWK; verify uses it but flags self-attestation.
    expect(report.signatures[0]?.status).toBe("self-attested");
    expect(report.warnings.some((w) => w.code === "SELF_ATTESTED_KEY")).toBe(true);
    // Structural integrity is still verified — key absence would be a
    // no-key-provided status, not tamper.
    expect(report.integrity.root).toBe("verified");
    // A self-attested signature still counts as passing integrity, but the
    // report communicates the limit via the warning.
    expect(report.ok).toBe(true);
  });
});

describe("verifyDisclosure", () => {
  it("verifies a disclosure package end to end", async () => {
    const { receipt, key } = await finalizedReceipt();
    const pkg = await disclose(receipt, {
      events: ["output.*"],
      random: fixedRandom(),
      clock: () => new Date(Date.UTC(2026, 6, 7, 10, 0, 30, 0)),
    });
    const report = await verifyDisclosure(pkg, { keys: [key] });
    expect(report.ok).toBe(true);
    expect(report.disclosures.applicable).toBe(true);
    expect(report.disclosures.complete).toBe(true);
    expect(report.disclosures.cryptographicallyConsistent).toBe(true);
    expect(report.signatures[0]?.status).toBe("verified");
    expect(report.warnings.some((w) => w.code === "PARTIAL_DISCLOSURE")).toBe(
      true,
    );
  });

  it("mode-downgrade preserves the root and stays cryptographically consistent", async () => {
    const { receipt, key } = await finalizedReceipt();
    const pkg = await disclose(receipt, {
      events: ["*"],
      redact: ["prompt.*", "model.*", "guardrail.*", "human-review.*"],
      random: fixedRandom(),
      clock: () => new Date(Date.UTC(2026, 6, 7, 10, 0, 30, 0)),
    });
    const report = await verifyDisclosure(pkg, { keys: [key] });
    expect(report.ok).toBe(true);
    expect(report.disclosures.complete).toBe(true);
    // Every human-review / model event's payload should have been downgraded.
    for (const disclosed of pkg.events) {
      if (
        disclosed.envelope.type.startsWith("model.") ||
        disclosed.envelope.type.startsWith("prompt.") ||
        disclosed.envelope.type.startsWith("human-review.") ||
        disclosed.envelope.type.startsWith("guardrail.")
      ) {
        expect(disclosed.envelope.payload.mode).not.toBe("embedded");
      }
    }
  });

  it("reports unknown completeness when leaves are omitted", async () => {
    const { receipt } = await finalizedReceipt();
    const pkg = await disclose(receipt, {
      events: ["output.*"],
      includeLeaves: false,
    });
    const report = await verifyDisclosure(pkg);
    expect(report.disclosures.complete).toBe("unknown");
  });
});
