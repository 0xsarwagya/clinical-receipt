import { describe, expect, it } from "vitest";

import { isReceiptError } from "../src/errors.js";
import { canonicalize } from "../src/core/canonicalize.js";
import { commitPayload } from "../src/core/commitment.js";
import {
  assertEnvelopeShape,
  committedEventForm,
  deriveEventIdentity,
  type EventEnvelope,
} from "../src/core/event.js";

async function makeEnvelope(
  overrides: Partial<EventEnvelope> = {},
): Promise<EventEnvelope> {
  const commitment = await commitPayload(
    canonicalize("jcs@1", { note: "committed content" }),
    { canonicalization: "jcs@1", salt: null },
  );
  const base = {
    type: "input.observed",
    sequence: 1,
    recordedAt: "2026-07-07T10:00:00.000Z",
    parentIds: [`evt_1_${"a".repeat(64)}`],
    payload: { mode: "commitment" as const, commitment },
  };
  const identity = await deriveEventIdentity(committedEventForm(base));
  return {
    ...base,
    id: identity.id,
    commitment: identity.commitment,
    ...overrides,
  };
}

describe("deriveEventIdentity", () => {
  it("derives a stable content-addressed id", async () => {
    const envelope = await makeEnvelope();
    const again = await deriveEventIdentity(committedEventForm(envelope));
    expect(again.id).toBe(envelope.id);
    expect(again.id).toMatch(/^evt_1_[0-9a-f]{64}$/);
  });

  it("changes when any committed field changes", async () => {
    const envelope = await makeEnvelope();
    const base = await deriveEventIdentity(committedEventForm(envelope));
    for (const mutated of [
      { ...envelope, type: "input.transformed" },
      { ...envelope, sequence: 2 },
      { ...envelope, recordedAt: "2026-07-07T10:00:00.001Z" },
      { ...envelope, parentIds: [`evt_1_${"b".repeat(64)}`] },
      { ...envelope, occurredAt: "2026-07-07T09:59:59.000Z" },
      { ...envelope, actor: { type: "service", id: "gw" } },
    ]) {
      const identity = await deriveEventIdentity(committedEventForm(mutated));
      expect(identity.id, JSON.stringify(Object.keys(mutated))).not.toBe(base.id);
    }
  });

  it("does NOT change when only the presentation region changes", async () => {
    const envelope = await makeEnvelope();
    const embedded = {
      ...envelope,
      payload: {
        ...envelope.payload,
        mode: "embedded" as const,
        value: { note: "committed content" },
        salt: "AAAAAAAAAAAAAAAAAAAAAA",
      },
    };
    const a = await deriveEventIdentity(committedEventForm(envelope));
    const b = await deriveEventIdentity(committedEventForm(embedded));
    expect(a.id).toBe(b.id); // the mode-downgrade invariant
  });
});

describe("assertEnvelopeShape", () => {
  it("accepts a well-formed envelope", async () => {
    const envelope = await makeEnvelope();
    expect(() => assertEnvelopeShape(envelope, "verifyReceipt")).not.toThrow();
  });

  it("rejects structural violations with MALFORMED_RECEIPT", async () => {
    const envelope = await makeEnvelope();
    const bad: unknown[] = [
      { ...envelope, id: "evt_1_short" },
      { ...envelope, type: "made-up-type" }, // not core, not URI
      { ...envelope, sequence: -1 },
      { ...envelope, recordedAt: "2026-07-07T10:00:00Z" }, // no millis
      { ...envelope, parentIds: [`evt_1_${"b".repeat(64)}`, `evt_1_${"a".repeat(64)}`] }, // unsorted
      { ...envelope, parentIds: [`evt_1_${"a".repeat(64)}`, `evt_1_${"a".repeat(64)}`] }, // dup
      { ...envelope, payload: { ...envelope.payload, mode: "plain" } },
      { ...envelope, payload: { ...envelope.payload, mode: "embedded" } }, // embedded without value
      { ...envelope, payload: { mode: "commitment", commitment: { algorithm: "sha-256" } } },
      { ...envelope, payload: { ...envelope.payload, mode: "commitment", value: {} } }, // value without embedded
    ];
    for (const value of bad) {
      try {
        assertEnvelopeShape(value, "verifyReceipt");
        expect.fail(`expected rejection: ${JSON.stringify(Object.keys(value as object))}`);
      } catch (error) {
        expect(isReceiptError(error)).toBe(true);
        if (isReceiptError(error)) {
          expect(error.code).toBe("MALFORMED_RECEIPT");
        }
      }
    }
  });
});
