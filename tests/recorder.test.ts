import { describe, expect, it } from "vitest";

import { isReceiptError } from "../src/errors.js";
import { createReceipt, MemoryReceiptStore } from "../src/index.js";
import { buildFullRun, deterministicOptions } from "./fixtures.js";

async function expectCode(promise: Promise<unknown>, code: string): Promise<void> {
  try {
    await promise;
  } catch (error) {
    expect(isReceiptError(error)).toBe(true);
    if (isReceiptError(error)) {
      expect(error.code).toBe(code);
    }
    return;
  }
  expect.fail(`expected ReceiptError ${code}`);
}

describe("createReceipt", () => {
  it("records a full DAG run and finalizes deterministically", async () => {
    const run = await buildFullRun();
    const receipt = await run.finalize();
    expect(receipt.specification).toEqual({ name: "clinical-receipt", version: "1.0" });
    expect(receipt.events[0]?.type).toBe("run.started");
    expect(receipt.events.at(-1)?.type).toBe("run.finalized");
    expect(receipt.commitments.leafCount).toBe(receipt.events.length + 1);
    expect(receipt.subject?.commitment.digest).toBeDefined();

    // Deterministic with injected id/clock/random.
    const again = await (await buildFullRun()).finalize();
    expect(again.commitments.root.digest).toBe(receipt.commitments.root.digest);
  });

  it("defaults payloads to commitment mode — nothing embedded silently", async () => {
    const run = await createReceipt(deterministicOptions());
    await run.input.observed({ value: { mrn: "secret-123" } });
    const receipt = await run.finalize();
    const input = receipt.events[1];
    expect(input?.payload.mode).toBe("commitment");
    expect(JSON.stringify(receipt)).not.toContain("secret-123");
  });

  it("gates embedding behind explicit opt-in", async () => {
    const run = await createReceipt(deterministicOptions());
    await expectCode(
      run.input.observed({ value: { a: 1 }, mode: "embedded" }),
      "EMBED_NOT_ALLOWED",
    );
    const event = await run.input.observed({ value: { a: 1 }, mode: "embedded", embed: true });
    expect(event.sequence).toBe(1);
  });

  it("rejects unknown parents and post-finalization writes", async () => {
    const run = await createReceipt(deterministicOptions());
    await expectCode(
      run.input.observed({ value: {} }, { parents: [`evt_1_${"0".repeat(64)}`] }),
      "UNKNOWN_PARENT",
    );
    await run.finalize();
    await expectCode(run.input.observed({ value: {} }), "RECEIPT_FINALIZED");
    await expectCode(run.finalize(), "RECEIPT_FINALIZED");
  });

  it("requires content or a precomputed digest", async () => {
    const run = await createReceipt(deterministicOptions());
    await expectCode(run.input.observed({}), "PAYLOAD_NOT_COMMITTABLE");
    const precomputed = await run.input.observed({
      digest: { algorithm: "sha-256", canonicalization: "bytes@1", digest: "AAAA" },
    });
    expect(precomputed.sequence).toBe(1);
  });

  it("keeps extension types namespaced and core types gated", async () => {
    const run = await createReceipt(deterministicOptions());
    await expectCode(
      run.event("model.responded", { value: {} }),
      "INVALID_ARGUMENT",
    );
    await expectCode(run.event("not-a-uri", { value: {} }), "INVALID_ARGUMENT");
  });

  it("write-once store semantics", async () => {
    const store = new MemoryReceiptStore();
    const receipt = await (await buildFullRun()).finalize();
    await store.finalize(receipt);
    await expect(store.finalize(receipt)).rejects.toThrow(/already finalized/);
    expect(await store.get(receipt.receipt.id)).toEqual(receipt);
  });
});
