import { describe, expect, it } from "vitest";

import { utf8Bytes } from "../src/core/encoding.js";
import {
  merkleRoot,
  proveInclusion,
  verifyInclusionProof,
} from "../src/core/merkle.js";

const RECEIPT_ID = `rcpt_1_${"0".repeat(32)}`;
const OTHER_RECEIPT_ID = `rcpt_1_${"f".repeat(32)}`;

function makeLeaves(count: number): Uint8Array<ArrayBuffer>[] {
  return Array.from({ length: count }, (_, i) => utf8Bytes(`leaf-${i}`));
}

describe("merkleRoot", () => {
  it("is deterministic and order-sensitive", async () => {
    const leaves = makeLeaves(5);
    const a = await merkleRoot(leaves, RECEIPT_ID);
    const b = await merkleRoot(leaves, RECEIPT_ID);
    expect(a).toEqual(b);
    const swapped = [...leaves];
    const l1 = swapped[1];
    const l2 = swapped[2];
    if (l1 && l2) {
      swapped[1] = l2;
      swapped[2] = l1;
    }
    expect(await merkleRoot(swapped, RECEIPT_ID)).not.toEqual(a);
  });

  it("is receipt-scoped — same leaves, different receipt, different root", async () => {
    const leaves = makeLeaves(4);
    const a = await merkleRoot(leaves, RECEIPT_ID);
    const b = await merkleRoot(leaves, OTHER_RECEIPT_ID);
    expect(a).not.toEqual(b);
  });

  it("has no duplicate-leaf malleability (unbalanced split, not duplication)", async () => {
    // Bitcoin-style duplication would make [a,b,c] and [a,b,c,c] collide.
    const three = makeLeaves(3);
    const four = [...three, three[2] as Uint8Array<ArrayBuffer>];
    expect(await merkleRoot(three, RECEIPT_ID)).not.toEqual(
      await merkleRoot(four, RECEIPT_ID),
    );
  });
});

describe("inclusion proofs", () => {
  it("verify for every leaf at every tree size 1..16", async () => {
    for (let size = 1; size <= 16; size += 1) {
      const leaves = makeLeaves(size);
      const root = await merkleRoot(leaves, RECEIPT_ID);
      for (let index = 0; index < size; index += 1) {
        const proof = await proveInclusion(leaves, index, RECEIPT_ID);
        expect(proof.treeSize).toBe(size);
        const leaf = leaves[index];
        if (leaf === undefined) {
          expect.fail("missing leaf");
        }
        expect(
          await verifyInclusionProof(leaf, proof, root, RECEIPT_ID),
          `size ${size} index ${index}`,
        ).toBe(true);
      }
    }
  });

  it("rejects the wrong leaf, index, root, and receipt", async () => {
    const leaves = makeLeaves(7);
    const root = await merkleRoot(leaves, RECEIPT_ID);
    const proof = await proveInclusion(leaves, 3, RECEIPT_ID);
    const leaf3 = leaves[3];
    const leaf4 = leaves[4];
    if (!leaf3 || !leaf4) {
      expect.fail("missing leaves");
    }

    expect(await verifyInclusionProof(leaf4, proof, root, RECEIPT_ID)).toBe(false);
    expect(
      await verifyInclusionProof(leaf3, { ...proof, leafIndex: 4 }, root, RECEIPT_ID),
    ).toBe(false);
    const wrongRoot = await merkleRoot(makeLeaves(6), RECEIPT_ID);
    expect(await verifyInclusionProof(leaf3, proof, wrongRoot, RECEIPT_ID)).toBe(false);
    // Cross-receipt replay: the context tag breaks it at the hash level.
    const otherRoot = await merkleRoot(leaves, OTHER_RECEIPT_ID);
    expect(
      await verifyInclusionProof(leaf3, proof, otherRoot, OTHER_RECEIPT_ID),
    ).toBe(false);
  });

  it("rejects truncated and extended paths", async () => {
    const leaves = makeLeaves(8);
    const root = await merkleRoot(leaves, RECEIPT_ID);
    const proof = await proveInclusion(leaves, 2, RECEIPT_ID);
    const leaf = leaves[2];
    if (!leaf) {
      expect.fail("missing leaf");
    }
    const short = { ...proof, path: proof.path.slice(1) };
    expect(await verifyInclusionProof(leaf, short, root, RECEIPT_ID)).toBe(false);
    const long = { ...proof, path: [...proof.path, proof.path[0] as string] };
    expect(await verifyInclusionProof(leaf, long, root, RECEIPT_ID)).toBe(false);
  });

  it("rejects sibling substitution", async () => {
    const leaves = makeLeaves(8);
    const root = await merkleRoot(leaves, RECEIPT_ID);
    const proofA = await proveInclusion(leaves, 1, RECEIPT_ID);
    const proofB = await proveInclusion(leaves, 6, RECEIPT_ID);
    const leaf = leaves[1];
    if (!leaf) {
      expect.fail("missing leaf");
    }
    const franken = { ...proofA, path: proofB.path };
    expect(await verifyInclusionProof(leaf, franken, root, RECEIPT_ID)).toBe(false);
  });
});
