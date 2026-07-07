import { describe, expect, it } from "vitest";

import { createReceipt } from "../src/recorder/receipt.js";
import {
  createEd25519Signer,
  exportVerificationKey,
  importVerificationKey,
} from "../src/signing/webcrypto.js";
import { verifyReceipt } from "../src/verify/receipt.js";
import { disclose } from "../src/disclosure/disclose.js";
import { verifyDisclosure } from "../src/verify/disclosure.js";
import { fixedClock, fixedRandom } from "./fixtures.js";

// Extension URIs — the recorder's `event()` refuses core types (those go
// through the typed builders), so property tests use vendor URIs.
const EXTENSION_TYPES = [
  "https://property.example/random/a/v1",
  "https://property.example/random/b/v1",
  "https://property.example/random/c/v1",
  "https://property.example/random/d/v1",
];

/**
 * Property: any well-formed DAG receipt verifies, and any subset of it
 * can be selectively disclosed without breaking integrity. Seeded xorshift
 * — deterministic failures, no dependency.
 */

function xorshift(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 0xffffffff;
  };
}

async function buildRandomReceipt(seed: number, eventCount: number) {
  const rng = xorshift(seed);
  const run = await createReceipt({
    workflow: { id: `wf-${seed}`, version: "1.0.0" },
    clock: fixedClock(Date.UTC(2026, 6, 7, 10, 0, 0, 0) + seed * 1000),
    random: fixedRandom(),
  });
  const ids: string[] = [];
  for (let i = 0; i < eventCount; i += 1) {
    const type = EXTENSION_TYPES[Math.floor(rng() * EXTENSION_TYPES.length)]!;
    // Pick 1 or 2 parents from earlier user-recorded ids. If none exist
    // yet, omit `parents` so the recorder chains to the previous event
    // (the auto-emitted run.started for i=0).
    const parents: string[] = [];
    if (ids.length > 0) {
      const parentCount = 1 + (rng() < 0.3 && ids.length > 1 ? 1 : 0);
      for (let p = 0; p < parentCount; p += 1) {
        const pick = ids[Math.floor(rng() * ids.length)];
        if (pick !== undefined && !parents.includes(pick)) {
          parents.push(pick);
        }
      }
    }
    const recorded = await run.event(
      type,
      { value: { seq: i, note: `entry ${i}` } },
      parents.length > 0 ? { parents } : {},
    );
    ids.push(recorded.id);
  }
  const signer = await createEd25519Signer({ generate: true });
  const receipt = await run.finalize({ signer });
  const key = await importVerificationKey(exportVerificationKey(signer));
  return { receipt, key, allEventIds: ids };
}

describe("property: random DAG receipts always verify", () => {
  it("holds across 20 seeded seeds and event counts 3..25", async () => {
    for (let seed = 1; seed <= 20; seed += 1) {
      const eventCount = 3 + (seed % 23);
      const { receipt, key } = await buildRandomReceipt(seed, eventCount);
      const report = await verifyReceipt(receipt, { keys: [key] });
      expect(report.ok, `seed=${seed}`).toBe(true);
      expect(report.integrity.root, `seed=${seed}`).toBe("verified");
      // Every event verified — none in failures list.
      expect(report.integrity.events.failed).toHaveLength(0);
    }
  }, 60_000);
});

describe("property: any disclosure subset stays consistent", () => {
  it("random subsets of random receipts verify", async () => {
    for (let seed = 100; seed <= 110; seed += 1) {
      const { receipt, key, allEventIds } = await buildRandomReceipt(seed, 12);
      // Pick a random half of the ids.
      const rng = xorshift(seed * 31);
      const subset = allEventIds.filter(() => rng() < 0.5);
      const events = subset.length === 0 ? [allEventIds[0]!] : subset;
      const pkg = await disclose(receipt, { events });
      const report = await verifyDisclosure(pkg, { keys: [key] });
      expect(report.ok, `seed=${seed}`).toBe(true);
      expect(report.disclosures.complete, `seed=${seed}`).toBe(true);
      expect(report.disclosures.cryptographicallyConsistent, `seed=${seed}`).toBe(
        true,
      );
    }
  }, 60_000);
});

describe("property: proofs verify for every leaf at every random tree", () => {
  it("holds across sizes 1..32", async () => {
    // Import merkle primitives directly to build a leaf-by-leaf claim.
    const {
      merkleRoot,
      proveInclusion,
      verifyInclusionProof,
    } = await import("../src/core/merkle.js");
    const { sha256 } = await import("../src/core/hash.js");
    for (let n = 1; n <= 32; n += 1) {
      const receiptId = `rcpt_1_${"1".repeat(32)}`;
      const leaves = Array.from({ length: n }, (_, i) => {
        const bytes = new Uint8Array(4);
        new DataView(bytes.buffer).setUint32(0, i + n * 10);
        return bytes;
      });
      const root = await merkleRoot(leaves as Uint8Array<ArrayBuffer>[], receiptId, sha256, "verifyReceipt");
      for (let i = 0; i < n; i += 1) {
        const proof = await proveInclusion(
          leaves as Uint8Array<ArrayBuffer>[],
          i,
          receiptId,
          sha256,
        );
        const ok = await verifyInclusionProof(
          leaves[i]!,
          proof,
          root,
          receiptId,
          sha256,
        );
        expect(ok, `n=${n} i=${i}`).toBe(true);
      }
    }
  }, 60_000);
});
