# Signatures

A hash proves the artifact has not changed. A signature proves a key
endorsed it. These are different claims; this document covers the
second, including its limits.

## 1. Signature payload

The signed bytes are:

```
signedBytes = f("clinical-receipt:signature:v1") || f(jcsBytes)
```

where `jcsBytes` is the `jcs@1` serialization of:

```json
{
  "payloadProfile": "clinical-receipt-sig@1",
  "specification": { "name": "clinical-receipt", "version": "1.0" },
  "receiptId": "rcpt_1_…",
  "root": { "algorithm": "sha-256", "structure": "clinical-receipt-merkle@1", "digest": "…" },
  "signature": { "algorithm": "ed25519", "keyId": "key_1_…" },
  "signedAt": "2026-07-07T10:16:00.000Z"
}
```

The payload covers the specification version, the receipt identity, the
root commitment (and therefore, transitively, every committed byte in
the receipt), the signature algorithm and key id (no algorithm
confusion), and the claimed signing time. `signedAt` appears both in
the signed bytes and in the stored record — no hidden timestamps.

## 2. Signature record

```json
{
  "payloadProfile": "clinical-receipt-sig@1",
  "algorithm": "ed25519",
  "keyId": "key_1_…",
  "publicKeyJwk": { },
  "signedAt": "…",
  "signature": "<base64url, unpadded>",
  "timestamps": []
}
```

- `publicKeyJwk` is optional convenience. A verifier that uses it MUST
  report the signature as `self-attested`: a key shipped inside the
  artifact proves possession, not identity. Trust comes from
  caller-supplied keys (JWKS, config, out-of-band).
- `timestamps: []` is a reserved slot for future countersignature
  adapters (RFC 3161 TSA, transparency logs). Empty in 1.0.

## 3. Algorithms

| Id | Signature bytes |
| --- | --- |
| `ed25519` | RFC 8032, 64 bytes |
| `ecdsa-p256-sha256` | 64 bytes, IEEE P1363 `r ‖ s` (32 + 32) |

ECDSA signatures MUST be P1363, never DER — P1363 is the WebCrypto
native form; converters to JOSE/COSE ecosystems live outside this
specification.

**Determinism warning:** signature bytes are NOT reproducible.
Ed25519 implementations may add hedging noise (WebKit does); ECDSA uses
a random nonce. Conforming test vectors pin signatures in the verify
direction only: a pinned signature must verify; fresh signatures must
round-trip; bytes are never compared.

## 4. Key ids

```
keyId = "key_1_" + lowercaseHex( SHA-256( f("clinical-receipt:keyid:v1") || f(keyBytes) )[0..16) )
```

`keyBytes` is the raw public key for Ed25519 (32 bytes) and the
uncompressed point (65 bytes, `0x04 ‖ X ‖ Y`) for P-256. Key ids are
identifiers, not trust decisions.

## 5. What a signature proves

Given a trusted key: this key endorsed exactly this root, for this
receipt id, under this spec version, at a claimed time.

It does not prove the key was uncompromised, that the signer read the
content, or that the content was true. Key governance — who may sign,
key rotation, revocation — is organizational infrastructure outside
this specification.
