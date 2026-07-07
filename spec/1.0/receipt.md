# Clinical Receipt Specification 1.0 — Data Model

Status: 1.0. The specification version is independent of any package
version; a receipt that declares `specification.version: "1.0"` MUST be
verifiable by any conforming 1.0 verifier, forever.

The words MUST, MUST NOT, SHOULD, and MAY are used as in RFC 2119.

## 1. Scope and honesty

A clinical receipt is a portable record of a single clinical AI
computation run: its inputs, evidence, prompts, model calls, tool calls,
guardrails, human review, and outputs, bound together by cryptographic
commitments into one independently verifiable artifact.

A conforming implementation proves exactly one thing:

> The committed record has not changed since finalization.

It does not prove that the original record was true, that the recorder
was honest, that timestamps are accurate, or that a model output can be
reproduced. Integrity and reproducibility are separate claims and MUST
never be conflated (see `verification.md`).

## 2. Identifiers

| Kind | Format | Derivation |
| --- | --- | --- |
| Receipt id | `rcpt_1_` + 32 lowercase hex chars | 16 random bytes |
| Event id | `evt_1_` + 64 lowercase hex chars | full SHA-256 envelope digest (`commitments.md` §4) |
| Key id | `key_1_` + 32 lowercase hex chars | truncated digest of the public key (`signatures.md` §4) |
| Disclosure id | `disc_1_` + 32 lowercase hex chars | 16 random bytes |

Event ids are content-derived: the id IS the envelope digest. This makes
`parentIds` full-strength hash links (a Merkle DAG in the git sense), and
makes duplicate-id or forged-graph receipts detectable as `id ≠ derived
digest` violations.

The `1` in each prefix names the identifier scheme version.

## 3. The receipt object

Serialized as JSON (UTF-8). Field order in storage is irrelevant —
everything integrity-bearing is committed through canonical forms.

```json
{
  "specification": { "name": "clinical-receipt", "version": "1.0" },
  "receipt": {
    "id": "rcpt_1_…",
    "createdAt": "2026-07-07T10:00:00.000Z",
    "finalizedAt": "2026-07-07T10:16:00.000Z"
  },
  "workflow": { "id": "discharge-risk-review", "version": "2.4.1" },
  "subject": { "commitment": { "algorithm": "sha-256", "canonicalization": "jcs@1", "digest": "…" } },
  "supersedes": "rcpt_1_…",
  "events": [ /* EventEnvelope, ordered by sequence, run.started first, run.finalized last */ ],
  "commitments": {
    "tree": "clinical-receipt-merkle@1",
    "leafCount": 19,
    "root": { "algorithm": "sha-256", "structure": "clinical-receipt-merkle@1", "digest": "…" }
  },
  "signatures": [ /* SignatureRecord, see signatures.md */ ],
  "disclosures": [ /* informational, uncommitted, see §8 */ ]
}
```

- `subject` is OPTIONAL and, in 1.0, commitment-mode only: a receipt MUST
  NOT embed a subject identifier. `subject.commitment` is a payload
  commitment (`commitments.md` §3) over a caller-chosen subject value.
- `supersedes` is OPTIONAL. Receipts are immutable after finalization;
  corrections create a new receipt whose `supersedes` names the old one.
- Timestamps are RFC 3339 UTC with millisecond precision and a `Z`
  suffix: `^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$`. All timestamps
  in this specification are recorder-asserted claims.

## 4. The event envelope

```json
{
  "id": "evt_1_…",
  "type": "model.responded",
  "sequence": 7,
  "occurredAt": "2026-07-07T10:15:03.120Z",
  "recordedAt": "2026-07-07T10:15:03.244Z",
  "actor": { "type": "service", "id": "inference-gateway" },
  "parentIds": ["evt_1_…"],
  "payload": {
    "mode": "commitment",
    "mediaType": "application/json",
    "commitment": { "algorithm": "sha-256", "canonicalization": "jcs@1", "digest": "…" },
    "value": { },
    "encoding": "base64url",
    "salt": "…",
    "ref": { "uri": "…", "version": "…" }
  },
  "commitment": {
    "algorithm": "sha-256",
    "canonicalization": "clinical-receipt-event@1",
    "digest": "…"
  }
}
```

- `sequence` is 0-based, unique, and strictly increasing across the
  receipt; the event with sequence 0 MUST be `run.started` and the last
  MUST be `run.finalized`.
- `parentIds` is a lexicographically sorted set of event ids that
  causally precede this event. Every parent MUST have a smaller
  sequence. `run.started` has no parents; every other event has at
  least one.
- `occurredAt` (optional) is when the recorder claims the thing
  happened; `recordedAt` is when the recorder wrote the event.
- `actor` (optional): `{ "type": string, "id": string, "display"?: string }`.
  Actors SHOULD be pseudonymous references, never embedded personal data.
- Which envelope fields are committed, and how, is defined in
  `commitments.md` §4. `id`, `commitment`, and the payload presentation
  fields (`mode`, `value`, `encoding`, `salt`) are derived or
  presentation-only and are NOT part of the committed bytes.

## 5. Payload recording modes

| Mode | `value` present | Committed content |
| --- | --- | --- |
| `commitment` (default) | no | the content's canonical bytes (digest only is stored) |
| `reference` | no | the content's canonical bytes, plus the committed `ref {uri, version?}` |
| `embedded` | yes | the content's canonical bytes (also stored in clear) |

Rules:

- `commitment` is the DEFAULT. Recorders MUST NOT embed payloads unless
  the caller explicitly opts in; clinical data is never embedded
  silently.
- All three modes commit the same thing — the content. A payload
  commitment can therefore be *downgraded* (embedded → commitment) after
  the fact without changing any committed digest; this is the selective
  disclosure primitive (`disclosure.md`).
- `reference` mode additionally commits `ref` inside the envelope, so
  the claimed URI and version are tamper-evident. Reference mode still
  requires the content (or a precomputed commitment) — a reference
  without a content commitment is not representable in 1.0.
- When `value` is present and the canonicalization is `bytes@1`, the
  value is a base64url string and `encoding: "base64url"` MUST be set.

## 6. Event types

Core types (18):

```
run.started                run.finalized
input.observed             input.transformed
evidence.queried           evidence.retrieved
prompt.template.selected   prompt.rendered
model.requested            model.responded
tool.requested             tool.responded
guardrail.evaluated
human.review.requested     human.review.completed
output.proposed            output.modified            output.committed
```

Extension types MUST be absolute URIs (contain `:`), e.g.
`https://hospital.example/receipt-events/mdt-review/v1`. Verifiers MUST
treat unknown extension events exactly like core events for integrity
purposes: an unknown type never invalidates a receipt.

Recommended payload shapes for the core types are defined by the
reference implementation's exported TypeScript interfaces; they are
recommendations, not integrity requirements — integrity applies to
whatever bytes were committed.

## 7. Graph rules

A conforming receipt satisfies all of:

1. `events` sorted by `sequence`, 0-based, no gaps, no duplicates.
2. Event 0 is `run.started`; the last event is `run.finalized`.
3. Every `parentIds` entry names an event in this receipt with a
   strictly smaller sequence (this makes cycles unrepresentable).
4. `parentIds` is sorted, without duplicates.
5. Every event other than `run.started` has ≥ 1 parent.
6. Every event id equals its derived envelope digest.
7. `commitments.leafCount` equals `events.length + 1` (header leaf).

Violations are structural: the receipt is MALFORMED and verification
fails before any hashing is reported.

## 8. Uncommitted regions

The following are explicitly NOT integrity-protected, and verifiers MUST
report them as recorder-asserted:

- `disclosures[]` on the receipt (an informational log of disclosure
  packages created after finalization).
- The payload presentation fields (`mode`, `value`, `encoding`, `salt`)
  — though when `value`/`salt` are present the verifier MUST recompute
  the payload commitment from them and require a match.
