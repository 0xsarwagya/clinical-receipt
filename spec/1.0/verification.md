# Verification

Verification is the security-critical path of this specification. A
conforming verifier is deterministic, runs offline, and produces a
structured report — never a bare boolean.

## 1. Algorithm

Given a receipt:

1. **Parse and validate shape.** Unknown top-level fields are ignored;
   missing required fields, malformed identifiers, malformed timestamps,
   or unknown `specification.version` fail as MALFORMED (with the
   version case distinguished as unsupported-version).
2. **Validate the graph** (`receipt.md` §7). Structural violations fail
   before any hashing.
3. **Recompute every envelope digest** from each event's committed form.
   Require `id` and `commitment.digest` to match. When payload
   presentation fields (`value`, `salt`) are present, recompute the
   payload commitment and require a match against the committed
   descriptor.
4. **Rebuild the header leaf** from receipt metadata; require field
   consistency (`eventCount === events.length`).
5. **Rebuild the tree** and compare the root and `leafCount`.
6. **Verify signatures.** For each record: reconstruct the payload
   bytes from the receipt's own (now verified) identity and root;
   verify with caller-supplied keys by `keyId`; fall back to
   `publicKeyJwk` with a `self-attested` status; report
   `no-key-provided` when neither exists.
7. **Check timeline claims** (see §3) — warnings only.
8. Assemble the report.

Steps 3–5 MUST be computed from the receipt's raw content, never
trusted from its own claims. The only trusted inputs are the
caller-supplied keys.

## 2. Report shape

```json
{
  "ok": false,
  "specification": { "name": "clinical-receipt", "version": "1.0" },
  "integrity": {
    "root": "verified",
    "events": {
      "total": 18,
      "verified": 17,
      "failed": [ { "index": 4, "eventId": "evt_1_…", "reason": "payload-commitment-mismatch" } ]
    }
  },
  "signatures": [
    { "keyId": "key_1_…", "algorithm": "ed25519", "status": "verified" }
  ],
  "disclosures": { "applicable": false, "complete": "unknown", "cryptographicallyConsistent": true },
  "timeline": {
    "internallyConsistent": true,
    "externallyTimestamped": false,
    "notes": ["All timestamps are recorder-asserted claims."]
  },
  "reproducibility": {
    "deterministic": "not-evaluated",
    "nondeterministic": "not-claimed"
  },
  "warnings": [ { "code": "SELF_ATTESTED_KEY", "message": "…" } ]
}
```

- `ok` is true iff the root verified, zero events failed, the graph was
  well-formed, and no signature that was checkable failed. Missing keys
  and warnings do not flip `ok`; forged bytes do.
- Signature statuses: `verified`, `failed`, `no-key-provided`,
  `self-attested` (verified against an embedded key).
- `reproducibility.nondeterministic` is the honesty field: model
  outputs are `"not-claimed"` in 1.0 — a receipt never asserts that a
  hosted model's output can be regenerated. Deterministic replay is a
  future capability; until then `deterministic: "not-evaluated"`.

## 3. Timeline checks (claims, not proofs)

- `recordedAt` non-decreasing with sequence;
- every parent's `recordedAt ≤` the child's;
- `receipt.createdAt ≤ receipt.finalizedAt`;
- `occurredAt ≤ recordedAt` where both exist.

Violations set `internallyConsistent: false` and add warnings. They
never fail integrity: clocks skew, distributed recorders disagree, and
a timestamp was never a proof. `externallyTimestamped` is `false` in
1.0 (the `timestamps` slot is reserved).

## 4. Error philosophy

Verification of hostile input returns a failing report; it throws only
on malformed artifacts that cannot be interpreted at all. Error
messages and reports MUST NOT include payload values — a verification
log must be safe to attach to a ticket.
