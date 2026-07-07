# Selective Disclosure

A disclosure package reveals a chosen subset of a receipt's events and
proves — cryptographically, offline — that every revealed piece belongs
to the original finalized receipt.

## 1. Package shape

```json
{
  "specification": { "name": "clinical-receipt", "version": "1.0" },
  "disclosure": {
    "id": "disc_1_…",
    "createdAt": "…",
    "receiptId": "rcpt_1_…",
    "root": { "algorithm": "sha-256", "structure": "clinical-receipt-merkle@1", "digest": "…" }
  },
  "header": {
    "value": { /* the header-leaf object, in clear */ },
    "proof": { /* inclusion proof for leaf 0 */ }
  },
  "events": [
    {
      "envelope": { /* serialized envelope, possibly mode-downgraded */ },
      "proof": { /* inclusion proof for this event's leaf */ }
    }
  ],
  "leaves": ["<base64url 32B>", "… all leaf contents, in order"],
  "signatures": [ /* copied verbatim from the receipt */ ]
}
```

Rules:

- The header leaf and its proof are ALWAYS present. The header is what
  binds the package to a specific receipt identity, workflow, subject
  commitment, and total event count.
- Every disclosed event carries its own inclusion proof.
- `leaves` is optional but RECOMMENDED (and produced by default): the
  full ordered list of leaf contents — the header's JCS bytes digest
  position is implied; entries 1..n are the raw envelope digests. Leaf
  digests contain zero payload information (payload commitments are
  salted), so `leaves` is PHI-safe. When present, the verifier rebuilds
  the entire tree and reports `complete: true/false`; when absent,
  completeness is `"unknown"`.
- `signatures` carry over verbatim because the signature payload
  (`signatures.md`) covers only the spec version, receipt id, and root
  — all present in the package.

## 2. Redaction: mode-downgrade

The 1.0 redaction primitive is per-event payload mode-downgrade:

```
embedded envelope
  → delete payload.value, payload.encoding, payload.salt
  → set payload.mode = "commitment"
```

By the mode-downgrade invariant (`commitments.md` §4), the downgraded
envelope's digest is unchanged, so the original inclusion proof still
verifies. The withheld salt is what keeps the hidden value
computationally hidden.

Field-level redaction inside a payload (JSONPath-style) is explicitly
OUT of scope for specification 1.0. It requires per-field salts and a
disclosure-of-structure analysis that deserve their own revision; a
future canonicalization profile family is reserved for it. Until then,
the unit of disclosure is the event.

## 3. Verification

A verifier MUST:

1. Validate package shape and spec version.
2. Recompute the header leaf hash from `header.value` and verify its
   proof against `disclosure.root` using `disclosure.receiptId`.
3. Require `header.value.receiptId === disclosure.receiptId`.
4. For each disclosed event: validate the envelope structurally,
   recompute its envelope digest, require `id` consistency, verify its
   inclusion proof against the root, and — when `value`/`salt` are
   present — recompute the payload commitment and require a match.
5. Require every proof's `treeSize` to equal `header.value.eventCount + 1`.
6. If `leaves` is present: require `leaves.length === treeSize`, require
   each disclosed event's digest to equal `leaves[sequence + 1]`,
   rebuild the root from all leaves, and require equality.
7. Verify signatures (if keys are provided) against the reconstructed
   signature payload.

## 4. What a disclosure does and does not claim

- It proves membership: each revealed item was committed in the
  original receipt, at its claimed position.
- With `leaves`, it proves completeness of the *commitment set* — the
  auditor knows exactly how many events exist and holds every digest.
- It does NOT reveal hidden content, and a verifier MUST NOT attempt
  dictionary reconstruction (salting makes it futile by design).
- A package without `leaves` proves membership only; a claim of "this
  is everything relevant" is a human claim, reported as such.
