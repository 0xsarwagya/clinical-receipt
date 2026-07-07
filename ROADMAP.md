# Roadmap

This is deliberately not a day-ship package. Verification is
security-critical and the specification is the primary artifact.

## 0.1 — the specification release (current)

- Frozen v1 protocol: canonicalization, commitments, envelopes, tree,
  disclosure, signatures, verification.
- Byte-pinned test vectors for every deterministic surface; verify-only
  pins for signatures.
- Full recorder: 18 core event types, extension URIs, embedded /
  commitment / reference modes.
- Standalone verifier (`./verify`) with zero recorder dependencies.
- Selective disclosure with inclusion proofs and mode-downgrade.
- Ed25519 and ECDSA P-256 signing over Web Crypto.
- Offline CLI: `verify`, `verify --disclosure`, `inspect`, `diff`,
  `disclose`.

## 0.2 — the FHIR release (current)

- First-party FHIR R4 integration under `./fhir`:
  - Instrumented fetch, instrumented client, and an explicit operation
    API — one code path for all three levels.
  - Reads, versioned reads, searches (first page), writes with
    submitted vs persisted commitments, transactions, and error
    events.
  - Offline `verifyFHIR` — Layer 1 receipt integrity + Layer 2 FHIR
    commitment comparison from resources the caller supplies.
- Extension protocol formalized: reserved namespaces, per-namespace
  payload validation, extension-aware verifier reports.
- `fhir-json-r4@1` canonicalization pinned with 7 byte-exact vectors.
- Bundle-size regression guard: root imports load zero FHIR code.

Deferred to 0.3:
- Layer-3 live FHIR store comparison (network-optional).
- Multi-page search consumption + lazy-iteration adapter.
- `run.scope(name, fn)` with async-context propagation.
- CLI `fhir inspect | verify` subcommands.

## 0.3 — the practical release

- Layer-3 live FHIR verification (opt-in, never implicit).
- Search pagination state machine + lazy consumption honesty.
- KMS/HSM signer adapter with the same `ReceiptSigner` contract.
- PostgreSQL storage adapter for `ReceiptStore`.
- Field-level redaction disclosure profile (JSONPath, on committed
  content). Currently v1 supports per-event mode-downgrade only.

## 0.3 — the observability release

- OpenTelemetry linkage: attach a receipt to the span that produced it,
  or attach a span reference into the receipt (recorder-asserted).
- Object-storage adapter (S3-compatible) with content-addressed layout.
- Provenance-attested npm releases via GitHub OIDC.

## What I have decided not to build

- A hosted receipt service. Verification is offline by design.
- Blockchain anchoring. RFC 3161 timestamps are the correct primitive.
- Replay: the report says `nondeterministic: "not-claimed"` and means it.
- Vendor-branded event types. Extension URIs already fit that use case.
- A policy engine. Guardrail events record decisions; enforcement is
  another product.
