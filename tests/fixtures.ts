import type { CreateReceiptOptions, ReceiptRun } from "../src/recorder/receipt.js";
import { createReceipt } from "../src/recorder/receipt.js";

/** Deterministic clock: starts at a fixed instant, +250ms per call. */
export function fixedClock(startMs = Date.UTC(2026, 6, 7, 10, 0, 0, 0)): () => Date {
  let calls = 0;
  return () => new Date(startMs + 250 * calls++);
}

/** Deterministic "randomness" — a counter stream. NEVER outside tests. */
export function fixedRandom(): (n: number) => Uint8Array<ArrayBuffer> {
  let counter = 0;
  return (n) => {
    const bytes = new Uint8Array(n);
    for (let i = 0; i < n; i += 1) {
      bytes[i] = (counter + i * 7) % 256;
    }
    counter += 1;
    return bytes;
  };
}

export const FIXED_RECEIPT_ID = `rcpt_1_${"ab".repeat(16)}`;

export function deterministicOptions(
  overrides: Partial<CreateReceiptOptions> = {},
): CreateReceiptOptions {
  return {
    workflow: { id: "discharge-risk-review", version: "2.4.1" },
    id: FIXED_RECEIPT_ID,
    clock: fixedClock(),
    random: fixedRandom(),
    ...overrides,
  };
}

/** A representative run touching every event family, with a DAG fan-out. */
export async function buildFullRun(
  overrides: Partial<CreateReceiptOptions> = {},
): Promise<ReceiptRun> {
  const run = await createReceipt(
    deterministicOptions({
      subject: { value: { reference: "Patient/123" } },
      ...overrides,
    }),
  );

  const input = await run.input.observed({
    value: { resourceType: "Observation", id: "obs-1", value: 42 },
    mediaType: "application/fhir+json",
  });
  const query = await run.evidence.queried(
    { value: { text: "heart failure discharge criteria" } },
    { parents: [input.id] },
  );
  const evidence = await run.evidence.retrieved(
    {
      value: { chunk: "guideline text", rank: 1, score: 0.91 },
      mode: "reference",
      ref: { uri: "guidelines://hf/2026", version: "2026-06-14" },
    },
    { parents: [query.id] },
  );
  const template = await run.prompt.templateSelected(
    { value: { template: { id: "discharge-review", version: "4.2.0" } }, mode: "embedded", embed: true },
    { parents: [input.id] },
  );
  const rendered = await run.prompt.rendered(
    { value: "System: review this discharge…", canonicalization: "utf8@1" },
    { parents: [template.id, evidence.id].sort() },
  );
  const modelReq = await run.model.requested(
    {
      value: { provider: "openai", model: "gpt-x-2026-06", configuration: { temperature: 0 } },
      mode: "embedded",
      embed: true,
    },
    { parents: [rendered.id] },
  );
  const modelRes = await run.model.responded(
    { value: { recommendation: "Consider urgent cardiology review." } },
    { parents: [modelReq.id], actor: { type: "service", id: "inference-gw" } },
  );
  const guardrail = await run.guardrail.evaluated(
    {
      value: { policy: { id: "no-autonomous-medication-change", version: "3.0" }, result: "passed" },
      mode: "embedded",
      embed: true,
    },
    { parents: [modelRes.id] },
  );
  const proposed = await run.output.proposed(
    { value: { recommendation: "Consider urgent cardiology review." } },
    { parents: [modelRes.id] },
  );
  const review = await run.humanReview.completed(
    {
      value: {
        reviewer: { type: "PractitionerRole", reference: "PractitionerRole/9" },
        action: "modified-and-approved",
      },
      mode: "embedded",
      embed: true,
    },
    { parents: [guardrail.id, proposed.id].sort() },
  );
  await run.output.committed(
    { value: { recommendation: "Urgent cardiology review today." } },
    { parents: [review.id] },
  );
  await run.event(
    "https://hospital.example/receipt-events/mdt-review/v1",
    { value: { board: "cardiology-mdt" }, mode: "embedded", embed: true },
    { parents: [review.id] },
  );
  return run;
}
