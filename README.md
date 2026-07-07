# clinical-receipt

Portable, independently verifiable receipts of how a clinical AI output
came to exist.

A TypeScript library that records the inputs, evidence, prompts, models,
tools, guardrails, and human decisions behind an AI-produced clinical
output — then commits, signs, and lets anyone verify the record
offline.

The package proves the committed record has not changed. It does not
prove the original record was true. That distinction is deliberate; it
appears in the docs, the reports, and the specification.

## What it is not

Not a blockchain. Not a hosted service. Not a compliance product. Not an
LLM observability dashboard. Not a substitute for clinical validation.

## Install

```
npm install @0xsarwagya/clinical-receipt
```

Node ≥ 20 (Web Crypto with Ed25519).

## Usage

```ts
import { createReceipt, createEd25519Signer } from "@0xsarwagya/clinical-receipt";

const run = await createReceipt({
  workflow: { id: "discharge-review", version: "2.1.0" },
});

await run.input.observed({ value: patientBundle });
await run.evidence.retrieved({
  value: { chunk: "guideline text", rank: 1 },
  mode: "reference",
  ref: { uri: "guidelines://hf/2026", version: "2026-06-14" },
});
await run.prompt.rendered({ value: renderedPrompt });
await run.model.responded({ value: modelOutput });
await run.guardrail.evaluated({ value: { policy, result: "passed" } });
await run.humanReview.completed({ value: reviewRecord });
await run.output.committed({ value: finalOutput });

const signer = await createEd25519Signer({ generate: true });
const receipt = await run.finalize({ signer });
```

Verify anywhere:

```ts
import { verifyReceipt, importVerificationKey } from "@0xsarwagya/clinical-receipt/verify";

const key = await importVerificationKey(publicJwk);
const report = await verifyReceipt(receipt, { keys: [key] });
// report.ok, report.integrity, report.signatures, report.warnings, ...
```

## FHIR

Since v0.2, wrap your FHIR access to commit which exact resource
versions the AI saw:

```ts
import { instrumentFHIRFetch, verifyFHIR } from "@0xsarwagya/clinical-receipt/fhir";

const fhirFetch = instrumentFHIRFetch(globalThis.fetch, {
  run,
  baseUrl: "https://hapi.fhir.org/baseR4",
});
const patient = await fhirFetch(`${BASE}/Patient/123`).then((r) => r.json());
// reads, searches, and writes are now part of the receipt.
```

The wire format for the `org.hl7.fhir` extension is pinned in
[`spec/1.0/fhir.md`](./spec/1.0/fhir.md); vectors sit under
[`spec/1.0/vectors/fhir-*.json`](./spec/1.0/vectors/).

## CLI

```
clinical-receipt verify receipt.json
clinical-receipt verify --disclosure package.json --key public.jwk
clinical-receipt inspect receipt.json
clinical-receipt disclose receipt.json --event output.* --out share.json
```

Exit codes: 0 ok, 1 verification failed, 2 usage or IO error.

## Specification

The wire format is a versioned specification, not an implementation
detail. Every byte-level rule lives in [`spec/1.0/`](./spec/1.0/). Test
vectors in [`spec/1.0/vectors/`](./spec/1.0/vectors/) are byte-pinned for
canonicalization, commitments, tree structure, header leaves, and full
receipts; signatures are pinned in the verify direction only (WebKit
hedges Ed25519).

Any implementation that speaks specification 1.0 — in any language —
must verify these vectors.

## License

Apache-2.0. This is infrastructure and the patent grant matters.
