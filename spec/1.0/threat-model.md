# Threat Model

The package proves: **the committed record has not changed.**
It does not prove: **the original record was true.**

Every design decision below defends the first sentence. Nothing in this
specification can rescue the second — that limit is stated, not hidden.

## 1. Defended attacks

| # | Attack | Defense |
| --- | --- | --- |
| 1 | Post-hoc payload modification | payload commitment mismatch (event fails) |
| 2 | Event deletion | header `eventCount` + tree root change |
| 3 | Event insertion | tree root change; `run.finalized` must be last |
| 4 | Event reordering | leaf order = sequence order → root change |
| 5 | Parent/DAG rewiring | `parentIds` inside committed form; ids are content-derived hash links |
| 6 | Algorithm substitution | algorithm ids inside committed bytes; unknown ids rejected |
| 7 | Canonicalizer substitution | profile ids inside committed bytes |
| 8 | Duplicate / forged event ids | id must equal derived envelope digest |
| 9 | Graph cycles | parents must have smaller sequence — cycles unrepresentable |
| 10 | Orphan parents | graph validation (structural failure) |
| 11 | Receipt metadata tampering (workflow, subject, spec version) | header leaf committed at position 0 |
| 12 | Truncated/extended disclosure | proofs pinned to `treeSize` = header `eventCount + 1` |
| 13 | Fake hidden commitments in a disclosure | `leaves` root reconstruction |
| 14 | Cross-receipt proof replay | receipt-scoped tree context tag |
| 15 | Dictionary attack on withheld payloads | 16-byte salts, withheld with the value |
| 16 | Algorithm-confusion on signatures | algorithm + keyId inside the signed payload |
| 17 | Signature payload substitution | payload reconstructed from verified receipt content, never trusted |

## 2. Explicit non-defenses

The specification claims nothing against:

- a compromised or malicious recorder **before** commitment — garbage
  in, faithfully committed garbage out;
- application code recording false inputs;
- stolen or shared signing keys (governance is organizational);
- dishonest humans approving bad outputs;
- incorrect models or bad clinical decisions;
- false recorder-asserted timestamps (external timestamping is a
  reserved future adapter);
- traffic analysis of disclosure *shape* (event count, types, and
  timing are visible even when payloads are hidden).

## 3. Privacy posture

- Commitment mode is the default; embedding requires explicit opt-in.
- Payload commitments are salted by default; withheld salts make hidden
  payloads computationally hidden, not just omitted.
- Error messages, reports, and CLI output never contain payload values.
- The core performs no network I/O and emits no telemetry; verification
  is fully offline.

## 4. Residual risks worth naming

- An unsalted commitment (`salt: null`) over low-entropy content is a
  dictionary oracle. The escape hatch exists for test vectors; using it
  on PHI is an implementation bug, and documentation must say so.
- Event *types* are committed in clear even in disclosures; a package
  that hides all payloads still reveals workflow shape. Organizations
  disclosing to adversarial parties should consider that metadata.
- `disclosures[]` on a receipt is an uncommitted convenience log; it
  proves nothing about what has actually been shared.
