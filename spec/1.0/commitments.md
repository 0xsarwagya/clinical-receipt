# Commitments

Everything integrity-bearing in a receipt reduces to SHA-256 digests of
deterministically framed messages. This document is the root of the
specification: every other document builds on the framing defined here.

## 1. Framing

All hashed messages are concatenations of length-prefixed fields:

```
f(x) = uint32be(byteLength(x)) || x
```

The first field of every message is an ASCII domain-separation tag.
Because every variable-length field is length-prefixed, no two distinct
field sequences can produce the same message bytes; the only unprefixed
concatenation in this specification is of fixed-width 32-byte digests
inside Merkle nodes (`tree.md`), which is unambiguous by width.

### Tag registry

| Tag | Purpose |
| --- | --- |
| `clinical-receipt:payload:v1` | payload commitments (§3) |
| `clinical-receipt:event:v1` | event envelope commitments (§4) |
| `clinical-receipt:tree:v1:<receiptId>` | Merkle leaf/node hashing (`tree.md`) |
| `clinical-receipt:signature:v1` | signature payloads (`signatures.md`) |
| `clinical-receipt:keyid:v1` | key id derivation (`signatures.md`) |

The tree tag embeds the receipt id, making every inclusion proof
receipt-scoped at the hash level: a proof lifted from one receipt cannot
verify against another even if the two receipts contain identical
events.

## 2. Hash algorithms

1.0 registers exactly one algorithm:

| Id | Digest |
| --- | --- |
| `sha-256` | FIPS 180-4 SHA-256, 32 bytes |

Every commitment record names its algorithm; verifiers MUST reject
unknown algorithm identifiers rather than guessing. Future algorithms
are added by registration, never by substitution.

Commitment record shape (used throughout):

```json
{ "algorithm": "sha-256", "canonicalization": "jcs@1", "digest": "<base64url, unpadded>" }
```

## 3. Payload commitments

```
digest = SHA-256(
  f("clinical-receipt:payload:v1")
  || f(algorithmId)          e.g. "sha-256"
  || f(canonicalizationId)   e.g. "jcs@1"
  || f(salt)                 16 bytes, or empty
  || f(canonicalBytes)
)
```

### Salt

By default every payload commitment carries a fresh 16-byte random
salt. The salt is stored NEXT TO the value (in the uncommitted
presentation region of the envelope) and is withheld whenever the value
is withheld.

Rationale: clinical payloads are low-entropy — diagnosis codes, dates,
dosages, booleans. An unsalted digest of such a value is a dictionary
oracle: anyone holding the receipt can confirm guesses offline. The
salt makes a withheld commitment computationally hiding while keeping
it perfectly binding.

`salt: null` (the empty field) is permitted for deterministic test
vectors and content-addressed deduplication. **Warning:** an unsalted
commitment over guessable content offers no hiding. Implementations
SHOULD require explicit opt-out and SHOULD document this loudly.

## 4. Event envelope commitments

The committed form of an envelope is a JSON object with exactly these
fields (optional fields omitted entirely when absent — never null):

```json
{
  "type": "…",
  "sequence": 7,
  "occurredAt": "…",          // optional
  "recordedAt": "…",
  "actor": { "type": "…", "id": "…", "display": "…" },   // optional
  "parentIds": ["evt_1_…"],   // sorted set; [] only for run.started
  "payload": {
    "commitment": { "algorithm": "…", "canonicalization": "…", "digest": "…" },
    "mediaType": "…",         // optional
    "ref": { "uri": "…", "version": "…" }                // reference mode only
  }
}
```

```
envelopeDigest = SHA-256(
  f("clinical-receipt:event:v1")
  || f("sha-256")
  || f("clinical-receipt-event@1")
  || f(jcsBytesOfCommittedForm)
)

eventId = "evt_1_" + lowercaseHex(envelopeDigest)
```

Deliberately excluded from the committed form:

- `id` and `commitment` — both derived from the committed bytes;
- `mode`, `value`, `encoding`, `salt` — the presentation region.

This exclusion is the mode-downgrade invariant: stripping a payload's
`value` and `salt` and setting `mode: "commitment"` changes nothing that
was committed, so the envelope digest, the event id, the Merkle leaf,
the root, and every signature remain valid. Selective disclosure
(`disclosure.md`) is built entirely on this property.

Because `parentIds` contains content-derived event ids, the committed
form hash-links the DAG: changing any ancestor changes its id, which
changes every descendant's committed bytes.

## 5. Non-goals

Commitments bind content. They do not bind wall-clock time (timestamps
inside committed forms are recorder claims), do not prove authorship
(signatures do, within the limits of key trust), and do not prove the
content was true when recorded.
