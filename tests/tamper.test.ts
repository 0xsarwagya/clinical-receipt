import { describe, expect, it } from "vitest";

import { isReceiptError } from "../src/errors.js";
import type { ClinicalReceipt } from "../src/recorder/receipt.js";
import { disclose } from "../src/disclosure/disclose.js";
import {
  createEd25519Signer,
  exportVerificationKey,
  importVerificationKey,
  type VerificationKey,
} from "../src/signing/webcrypto.js";
import { verifyReceipt } from "../src/verify/receipt.js";
import { verifyDisclosure } from "../src/verify/disclosure.js";
import { buildFullRun } from "./fixtures.js";

/**
 * Every attack documented in spec/1.0/threat-model.md §1 must fail
 * verification. Structural attacks (remove / insert / reorder / id
 * substitution / parent substitution) surface as MALFORMED_RECEIPT from
 * the parser — a strong security posture: crypto is never asked about
 * ill-formed input. Cryptographic attacks (byte flips, canonicalization
 * swaps, signature tamper) surface in the verification report at a
 * specific locus.
 */

async function baseline(overrides: {
  subjectRef?: string;
} = {}): Promise<{ receipt: ClinicalReceipt; key: VerificationKey }> {
  const run = await buildFullRun(
    overrides.subjectRef !== undefined
      ? { subject: { value: { reference: overrides.subjectRef } } }
      : {},
  );
  const signer = await createEd25519Signer({ generate: true });
  const receipt = await run.finalize({ signer });
  const key = await importVerificationKey(exportVerificationKey(signer));
  return { receipt, key };
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

async function expectMalformed(promise: Promise<unknown>): Promise<void> {
  try {
    await promise;
  } catch (error) {
    if (!isReceiptError(error) || error.code !== "MALFORMED_RECEIPT") {
      throw new Error(
        `expected MALFORMED_RECEIPT, got ${(error as { code?: string })?.code ?? String(error)}`,
      );
    }
    return;
  }
  throw new Error("expected MALFORMED_RECEIPT, but the promise resolved");
}

describe("tamper matrix — structural (rejected at parse)", () => {
  it("event removal is rejected", async () => {
    const { receipt, key } = await baseline();
    const tampered = clone(receipt);
    tampered.events.splice(4, 1);
    await expectMalformed(verifyReceipt(tampered, { keys: [key] }));
  });

  it("event reorder is rejected", async () => {
    const { receipt, key } = await baseline();
    const tampered = clone(receipt);
    const a = tampered.events[3];
    const b = tampered.events[4];
    if (a === undefined || b === undefined) throw new Error("fixture");
    tampered.events[3] = b;
    tampered.events[4] = a;
    await expectMalformed(verifyReceipt(tampered, { keys: [key] }));
  });

  it("event insertion is rejected", async () => {
    const { receipt, key } = await baseline();
    const tampered = clone(receipt);
    const template = tampered.events[2];
    if (template === undefined) throw new Error("fixture");
    tampered.events.push({ ...template, sequence: tampered.events.length });
    await expectMalformed(verifyReceipt(tampered, { keys: [key] }));
  });

  it("event id substitution is rejected (breaks parent hashlinks)", async () => {
    const { receipt, key } = await baseline();
    const tampered = clone(receipt);
    const target = tampered.events[3];
    if (target === undefined) throw new Error("fixture");
    target.id = `evt_1_${"0".repeat(64)}`;
    await expectMalformed(verifyReceipt(tampered, { keys: [key] }));
  });

  it("parent id substitution is rejected", async () => {
    const { receipt, key } = await baseline();
    const tampered = clone(receipt);
    const target = tampered.events.find((e) => e.parentIds.length > 0);
    if (target === undefined) throw new Error("fixture");
    target.parentIds = [`evt_1_${"f".repeat(64)}`];
    await expectMalformed(verifyReceipt(tampered, { keys: [key] }));
  });
});

describe("tamper matrix — cryptographic (caught at verify)", () => {
  it("committed payload byte flip surfaces as payload-commitment-mismatch", async () => {
    const { receipt, key } = await baseline();
    const tampered = clone(receipt);
    const target = tampered.events.find(
      (e) => e.payload.mode === "embedded" && typeof e.payload.value === "object",
    );
    if (target === undefined || target.payload.mode !== "embedded") {
      throw new Error("fixture");
    }
    (target.payload.value as { fake?: string }).fake = "x";
    const report = await verifyReceipt(tampered, { keys: [key] });
    expect(report.ok).toBe(false);
    expect(report.integrity.events.failed).toHaveLength(1);
    expect(report.integrity.events.failed[0]?.reason).toBe(
      "payload-commitment-mismatch",
    );
  });

  it("commitment.digest byte flip surfaces at verify (envelope no longer recomputes)", async () => {
    // Digest change moves the committed form, which changes the event
    // id. Verify detects the mismatch between claimed id and recomputed
    // id — parse only checks hashlink structure, not the crypto.
    const { receipt, key } = await baseline();
    const tampered = clone(receipt);
    const target = tampered.events[3];
    if (target === undefined) throw new Error("fixture");
    const original = target.payload.commitment.digest;
    target.payload.commitment.digest =
      original.slice(0, 4) + (original[4] === "A" ? "B" : "A") + original.slice(5);
    const report = await verifyReceipt(tampered, { keys: [key] });
    expect(report.ok).toBe(false);
    expect(report.integrity.events.failed[0]?.reason).toBe("event-id-mismatch");
  });

  it("canonicalization swap surfaces as event-id-mismatch (canonicalization is committed)", async () => {
    const { receipt, key } = await baseline();
    const tampered = clone(receipt);
    // Target the LAST event (run.finalized) so no child parent refs
    // break — canonicalization is inside the committed form, so it
    // rehashes to a different id and fails locally.
    const target = tampered.events[tampered.events.length - 1];
    if (target === undefined) throw new Error("fixture");
    // The final event's payload uses jcs@1 for its committed record.
    if (target.payload.commitment.canonicalization !== "jcs@1") {
      throw new Error("fixture assumption changed");
    }
    target.payload.commitment.canonicalization = "bytes@1";
    const report = await verifyReceipt(tampered, { keys: [key] });
    expect(report.ok).toBe(false);
    expect(report.integrity.events.failed).toHaveLength(1);
    expect(report.integrity.events.failed[0]?.reason).toBe("event-id-mismatch");
  });

  it("signature byte flip surfaces as a failed signature (event integrity intact)", async () => {
    const { receipt, key } = await baseline();
    const tampered = clone(receipt);
    const record = tampered.signatures[0];
    if (record === undefined) throw new Error("fixture");
    const original = record.signature;
    record.signature =
      original.slice(0, 8) + (original[8] === "A" ? "B" : "A") + original.slice(9);
    const report = await verifyReceipt(tampered, { keys: [key] });
    expect(report.ok).toBe(false);
    expect(report.signatures[0]?.status).toBe("failed");
    // The events themselves still verify — the tamper is scoped.
    expect(report.integrity.events.failed).toHaveLength(0);
    expect(report.integrity.root).toBe("verified");
  });

  it("negative control: uncommitted mode/value/salt fields can be stripped and still verify", async () => {
    // The `value`, `salt`, and `mode` fields on the wire envelope are
    // NOT in the committed form — an application may downgrade an
    // embedded payload to commitment form after finalization without
    // touching the receipt's integrity. That is spec-required.
    const { receipt, key } = await baseline();
    const tampered = clone(receipt);
    const target = tampered.events.find((e) => e.payload.mode === "embedded");
    if (target === undefined) throw new Error("fixture");
    target.payload.mode = "commitment";
    const payload = target.payload as unknown as Record<string, unknown>;
    delete payload.value;
    delete payload.salt;
    delete payload.encoding;
    const report = await verifyReceipt(tampered, { keys: [key] });
    expect(report.ok).toBe(true);
    expect(report.integrity.root).toBe("verified");
    expect(report.integrity.events.failed).toHaveLength(0);
  });
});

describe("tamper matrix — disclosures", () => {
  it("cross-receipt proof replay is caught by the tree tag", async () => {
    // Two receipts about different subjects: their events, digests, and
    // roots differ, so A's inclusion proofs cannot thread B's root.
    const a = await baseline({ subjectRef: "Patient/A" });
    const b = await baseline({ subjectRef: "Patient/B" });
    const pkgA = await disclose(a.receipt, { events: ["output.*"] });
    const pkgB = await disclose(b.receipt, { events: ["output.*"] });
    // Stitch A's disclosed events into B's package, keeping B's root.
    const stitched = clone(pkgB);
    stitched.events = clone(pkgA.events);
    const report = await verifyDisclosure(stitched, { keys: [b.key] });
    expect(report.ok).toBe(false);
    expect(report.integrity.root).toBe("failed");
  });

  it("substituted sibling in the header proof breaks the root", async () => {
    const { receipt, key } = await baseline();
    const pkg = await disclose(receipt, { events: ["output.*"] });
    const tampered = clone(pkg);
    if (tampered.header.proof.path.length === 0) {
      throw new Error("fixture: header should have a proof path");
    }
    const first = tampered.header.proof.path[0];
    if (first === undefined) throw new Error("fixture");
    tampered.header.proof.path[0] =
      first.slice(0, 8) + (first[8] === "A" ? "B" : "A") + first.slice(9);
    const report = await verifyDisclosure(tampered, { keys: [key] });
    expect(report.ok).toBe(false);
    expect(report.integrity.root).toBe("failed");
  });

  it("wrong-root disclosure fails verification", async () => {
    const { receipt, key } = await baseline();
    const pkg = await disclose(receipt, { events: ["output.*"] });
    const tampered = clone(pkg);
    const digest = tampered.disclosure.root.digest;
    tampered.disclosure.root.digest =
      digest.slice(0, 4) + (digest[4] === "A" ? "B" : "A") + digest.slice(5);
    const report = await verifyDisclosure(tampered, { keys: [key] });
    expect(report.ok).toBe(false);
  });

  it("hidden leaf mutation collapses completeness", async () => {
    const { receipt, key } = await baseline();
    const pkg = await disclose(receipt, { events: ["output.*"] });
    if (pkg.leaves === undefined || pkg.leaves.length === 0) {
      throw new Error("fixture: leaves should be present by default");
    }
    const tampered = clone(pkg);
    if (tampered.leaves === undefined) throw new Error("clone invariant");
    // Mutate a hidden (non-disclosed) leaf.
    const disclosedSequences = new Set(
      tampered.events.map((e) => e.envelope.sequence + 1),
    );
    // header leaf is index 0
    let hiddenIndex = -1;
    for (let i = 1; i < tampered.leaves.length; i += 1) {
      if (!disclosedSequences.has(i)) {
        hiddenIndex = i;
        break;
      }
    }
    if (hiddenIndex === -1) throw new Error("fixture: no hidden leaves");
    const hidden = tampered.leaves[hiddenIndex];
    if (hidden === undefined) throw new Error("fixture");
    tampered.leaves[hiddenIndex] =
      hidden.slice(0, 4) + (hidden[4] === "A" ? "B" : "A") + hidden.slice(5);
    const report = await verifyDisclosure(tampered, { keys: [key] });
    expect(report.disclosures.complete).toBe(false);
    expect(report.disclosures.cryptographicallyConsistent).toBe(false);
    // Disclosed events still self-verify — the tamper is in a leaf the
    // disclosure never claimed to reveal.
    expect(report.integrity.events.failed).toHaveLength(0);
  });
});

describe("PHI-safety", () => {
  it("no error message ever contains payload values", async () => {
    const secret = "PATIENT-SSN-000-00-0000";
    const { receipt, key } = await baseline();
    const tampered = clone(receipt);
    const target = tampered.events.find(
      (e) => e.payload.mode === "embedded" && typeof e.payload.value === "object",
    );
    if (target === undefined || target.payload.mode !== "embedded") {
      throw new Error("fixture");
    }
    (target.payload.value as Record<string, unknown>).ssn = secret;
    const report = await verifyReceipt(tampered, { keys: [key] });
    const serialized = JSON.stringify(report);
    expect(serialized.includes(secret)).toBe(false);
  });
});
