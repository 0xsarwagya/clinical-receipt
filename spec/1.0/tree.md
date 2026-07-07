# The Receipt Tree

The root commitment is the head of a Merkle tree over the receipt
header and the ordered event envelope digests. The tree exists for two
reasons: one digest commits the entire run, and any single leaf can be
proven to belong to that digest without revealing the others — the
foundation of selective disclosure.

## 1. Leaves

Leaf contents, in order:

- **Leaf 0 — the header leaf.** The `jcs@1` bytes of:

```json
{
  "type": "clinical-receipt-header",
  "specification": { "name": "clinical-receipt", "version": "1.0" },
  "receiptId": "rcpt_1_…",
  "createdAt": "…",
  "finalizedAt": "…",
  "workflow": { "id": "…", "version": "…" },
  "subject": { "commitment": { … } },      // optional
  "supersedes": "rcpt_1_…",                // optional
  "hashAlgorithm": "sha-256",
  "eventCount": 18
}
```

  The header leaf binds receipt identity, workflow identity, the subject
  commitment, and — critically — `eventCount`, which pins the tree size
  and defeats truncation and extension.

- **Leaf i (1 ≤ i ≤ n)** — the raw 32-byte envelope digest of the event
  with `sequence = i − 1`. Leaf order is sequence order, so reordering
  events changes the root even though each envelope is individually
  intact.

Header content (JSON text, length ≠ 32, position 0) cannot be confused
with an event leaf (raw 32-byte digest).

## 2. Hashing

With `ctx = "clinical-receipt:tree:v1:" + receiptId` and `f` from
`commitments.md` §1:

```
leafHash(content)      = SHA-256( f(ctx) || 0x00 || f(content) )
nodeHash(left, right)  = SHA-256( f(ctx) || 0x01 || left || right )
```

`left` and `right` are 32-byte child hashes, concatenated without
prefixes (unambiguous by fixed width). The `0x00`/`0x01` bytes are the
RFC 6962 leaf/node domain separators; the receipt-scoped `ctx` makes
proofs unusable across receipts.

## 3. Tree shape (RFC 6962 MTH)

```
MTH([])            — undefined; a receipt always has ≥ 3 leaves
                     (header, run.started, run.finalized)
MTH([x])           = leafHash(x)
MTH(D[n])          = nodeHash( MTH(D[0:k]), MTH(D[k:n]) )
                     where k is the largest power of two < n
```

Odd nodes are handled by the unbalanced split. Duplicating the last
leaf (the Bitcoin construction) is REJECTED: duplicate-leaf trees admit
distinct leaf sets with equal roots (the CVE-2012-2459 ambiguity
class).

The root commitment record:

```json
"commitments": {
  "tree": "clinical-receipt-merkle@1",
  "leafCount": 19,
  "root": { "algorithm": "sha-256", "structure": "clinical-receipt-merkle@1", "digest": "…" }
}
```

`leafCount` MUST equal `eventCount + 1`.

## 4. Inclusion proofs

```json
{
  "structure": "clinical-receipt-merkle@1",
  "leafIndex": 5,
  "treeSize": 19,
  "path": ["<base64url 32B>", "…"]
}
```

`path` lists sibling hashes from the leaf toward the root (RFC 6962
§2.1.1 audit path). Verification recomputes the root from
`leafHash(content)` and the path, using the position algorithm:

```
verify(content, proof, root, receiptId):
  // proof.path is leaf-to-root; descend the tree top-down by
  // consuming it in REVERSE, recording each sibling's side,
  // then fold upward from the leaf.
  idx = proof.leafIndex; size = proof.treeSize; steps = []
  for sibling in reverse(proof.path):
    if size == 1: fail                    // path longer than tree height
    k = largest power of two < size
    if idx < k:  steps.push((sibling, right)); size = k
    else:        steps.push((sibling, left)); idx -= k; size -= k
  if size != 1: fail                      // path shorter than tree height
  h = leafHash(content)                   // with ctx from receiptId
  for (sibling, side) in reverse(steps):
    h = side == right ? nodeHash(h, sibling) : nodeHash(sibling, h)
  accept iff h == root
```

Any deviation — wrong index, wrong size, substituted sibling, path from
another receipt — produces a different head and fails.
