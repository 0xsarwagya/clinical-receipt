# Clinical Receipt — Specification 1.0

This directory is the definition of the `clinical-receipt` protocol at
specification version **1.0**. The TypeScript implementation in
`../..` is one conforming implementation. It is not the definition.

Any implementation, in any language, that reproduces every pinned
vector under [`./vectors/`](./vectors/) is a v1.0-conformant
implementation.

## Documents

- [`receipt.md`](./receipt.md) — the receipt data model: workflow,
  subject, events, commitments, signatures, disclosures. Rules for
  identity, ordering, and finalization.
- [`canonicalization.md`](./canonicalization.md) — the registered
  canonicalization profiles: `jcs@1`, `bytes@1`, `utf8@1`,
  `utf8-nfc@1`, and the alias mechanism.
- [`commitments.md`](./commitments.md) — the byte-level commitment
  formula. Domain-separation tags, field framing, salt.
- [`tree.md`](./tree.md) — the receipt Merkle tree. Leaf and node
  hashing, split rule, receipt-scoped context, inclusion proofs.
- [`disclosure.md`](./disclosure.md) — selective disclosure package
  shape and verification.
- [`signatures.md`](./signatures.md) — the signed bytes, key
  identity, algorithm profiles (Ed25519, ECDSA P-256), and the
  boundary between integrity and identity.
- [`verification.md`](./verification.md) — the verification
  algorithm and the report shape. A verifier is deterministic, runs
  offline, and never returns a bare boolean.
- [`threat-model.md`](./threat-model.md) — what the protocol
  defends against, what it deliberately does not, and why the
  distinction matters.
- [`extensions.md`](./extensions.md) — the extension protocol:
  namespaces, versioning, per-namespace validation, unknown-extension
  behavior. Reserved namespaces are listed here.
- [`fhir.md`](./fhir.md) — the `org.hl7.fhir` extension for FHIR R4:
  event kinds, payload envelopes, resource commitment profile,
  privacy transforms.

## Vectors

Every deterministic surface has a byte-pinned vector under
[`./vectors/`](./vectors/). An implementation that recomputes each
vector's committed digest is v1.0-conformant for that surface.

- **Base protocol:** `jcs.json`, `commitment.json`, `tree.json`,
  `header.json`, `receipt-minimal.json`, `disclosure-basic.json`,
  `signature-ed25519.json`.
- **FHIR extension (extensionVersion `1`, fhirVersion `R4`):**
  `fhir-read-r4.json`, `fhir-versioned-read-r4.json`,
  `fhir-search-r4.json`, `fhir-create-r4.json`,
  `fhir-transaction-r4.json`, `fhir-error-r4.json`,
  `fhir-redacted-query-r4.json`.

Signatures are pinned in the **verify** direction only. Ed25519
signatures are hedged on some engines (WebKit); ECDSA is inherently
randomized. Byte-identical signature bytes across engines are NOT a
protocol requirement. Verifying that a pinned signature validates
against a pinned key IS a protocol requirement.

## Versioning and compatibility

Specification 1.0 is the version this directory describes. The
package version (`0.2.0`, `0.3.0`, …) is independent of the
specification version. A receipt declaring `specification.version:
"1.0"` MUST be verifiable by any 1.0-conforming verifier, forever.

Extension namespaces version independently through
`extensionVersion`. Any incompatible change to a namespace's committed
shape MUST bump `extensionVersion` and produce a new set of vectors.
Vectors pinned against an earlier `extensionVersion` remain valid
against that version forever.

## Reading order for a new implementation

1. `commitments.md` — the framing rule underlies everything.
2. `canonicalization.md` — the profiles that convert values to bytes.
3. `receipt.md` — how a receipt is structured.
4. `tree.md` — how the root is computed and how proofs work.
5. `signatures.md` — the signature envelope.
6. `verification.md` — the verification algorithm.
7. `disclosure.md` — how selective disclosure preserves the root.
8. `extensions.md` and `fhir.md` — the extension mechanism and the
   FHIR profile that ships with v0.2.
9. `threat-model.md` — what the protocol claims and does not claim.
10. `./vectors/*.json` — the compatibility contract.

## The one durable statement

The protocol proves that the committed record has not changed. It
does not prove that the original record was true. Every document in
this directory respects that boundary; every verifier's report
respects it too.
