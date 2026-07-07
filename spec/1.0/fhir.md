# FHIR Extension

The `org.hl7.fhir` extension carries FHIR interactions in a receipt.
This chapter defines the wire format for `extensionVersion: "1"` and
`fhirVersion: "R4"` — the profile every conforming implementation must
recompute bit-for-bit against the pinned vectors in
`spec/1.0/vectors/fhir-*.json`.

The words MUST, MUST NOT, SHOULD, and MAY are used as in RFC 2119.

## 1. Namespace and canonicalization

- Namespace: `org.hl7.fhir` (registered per `spec/1.0/extensions.md`).
- Canonicalization: `fhir-json-r4@1`.
- FHIR resources, Bundles, and OperationOutcomes are canonicalized as
  JSON objects with the receiving JSON representation intact. In v1
  the profile is byte-equivalent to `jcs@1` — recursive member sort,
  no whitespace, no terminology normalization, no ordering changes to
  arrays.
- Any future FHIR-specific pre-normalization (primitive extensions,
  contained resources, terminology folding) MUST bump the profile to
  `fhir-json-r4@2`. Receipts declaring `fhir-json-r4@1` remain
  verifiable against v1 forever.

## 2. Event kinds

```
org.hl7.fhir.request
org.hl7.fhir.response
org.hl7.fhir.resource.read
org.hl7.fhir.resource.vread
org.hl7.fhir.resource.write
org.hl7.fhir.search
org.hl7.fhir.search.page       (reserved; not emitted in v0.2)
org.hl7.fhir.transaction
org.hl7.fhir.error
```

Any event whose type starts with `org.hl7.fhir.` belongs to this
namespace. A v0.2 recorder MUST NOT emit any FHIR event kind outside
the list above.

## 3. Payload envelope

Every FHIR event payload is a JSON object with these common fields:

| Field | Required | Notes |
| --- | --- | --- |
| `extensionVersion` | yes | MUST equal `"1"` in v1 |
| `fhirVersion` | yes | MUST equal `"R4"` in v1 |
| `server` | yes | `{ id: string, baseUrl?, software?, environment? }` |
| `privacy` | optional | `{ query?: Record, resourceIds?: "hash" }` — the transforms actually applied |
| `operation` | yes | kind-specific string (see per-kind sections) |

Additional per-kind fields are specified below. Unknown fields on a
FHIR event payload MUST be ignored by verifiers — never rejected.

## 4. Resource read (`resource.read`)

```json
{
  "extensionVersion": "1",
  "fhirVersion": "R4",
  "server": { "id": "hapi-r4-public" },
  "operation": "read",
  "resource": { "type": "Patient", "id": "123", "versionId": "7", "lastUpdated": "..." },
  "commitment": { "algorithm": "sha-256", "canonicalization": "fhir-json-r4@1", "digest": "..." },
  "responseHeaders": { "etag": "W/\"7\"" }
}
```

`resource.versionId` and `resource.lastUpdated` are copied from
`meta.versionId` and `meta.lastUpdated` when the server returned them.
Their presence in the receipt is a *recorded observation*, not a
verifier-side guarantee about the server's honesty.

## 5. Versioned read (`resource.vread`)

Identical to `resource.read` plus:

- `resource.versionId` MUST be present.
- `versionPinned: true` MUST be present.

## 6. Search (`search`)

```json
{
  "extensionVersion": "1",
  "fhirVersion": "R4",
  "server": { "id": "..." },
  "operation": "search",
  "resourceType": "Observation",
  "query": { "patient": "sha256:..." },
  "total": 2,
  "sort": "-date",
  "bundle": {
    "commitment": { "algorithm": "sha-256", "canonicalization": "fhir-json-r4@1", "digest": "..." },
    "resources": [
      { "type": "Observation", "id": "obs-a", "versionId": "4", "lastUpdated": "..." }
    ]
  },
  "pagination": "complete" | "complete-first-page-only" | "partial" | "unknown"
}
```

- `query` is the normalized parameter map AFTER privacy transforms.
- `sort` MUST be present iff the FHIR request included `_sort`. When
  `sort` is present, the `bundle.commitment` is order-sensitive — a
  verifier who reorders resources produces a different digest.
- `bundle.resources` is a projection: `type`, `id`, `versionId`,
  `lastUpdated`. The full Bundle body is committed under
  `bundle.commitment`, not embedded.
- `pagination` values:
  - `complete` — the response had no `next` link.
  - `complete-first-page-only` — the response had a `next` link;
    v0.2 does not follow it.
  - `partial` — the caller consumed less than the first page.
  - `unknown` — the recorder cannot tell.

## 7. Write (`resource.write`)

```json
{
  "extensionVersion": "1",
  "fhirVersion": "R4",
  "server": { "id": "..." },
  "operation": "create" | "update" | "patch" | "delete",
  "target": { "type": "ClinicalImpression", "id": "?", "versionId": "?" },
  "submitted": { "commitment": {...} },
  "persisted": {
    "resource": { "type": "ClinicalImpression", "id": "789", "versionId": "1", "lastUpdated": "..." },
    "commitment": {...}
  },
  "location": "https://.../ClinicalImpression/789/_history/1"
}
```

- `submitted` MAY be absent for `delete`.
- `persisted` MAY be absent when the server returned no body.
- `location` copies the `Location` response header when the caller's
  header allowlist permits it.

## 8. Transaction (`transaction`)

```json
{
  "extensionVersion": "1",
  "fhirVersion": "R4",
  "server": { "id": "..." },
  "operation": "transaction" | "batch",
  "submitted": {
    "commitment": {...},
    "entryCount": 3
  },
  "response": {
    "commitment": {...},
    "entries": [ { "status": "201 Created", "location": "..." } ]
  }
}
```

The submitted request Bundle and the response Bundle are committed
separately. The `entries` projection preserves per-entry ordering and
per-entry response metadata.

## 9. Error (`error`)

```json
{
  "extensionVersion": "1",
  "fhirVersion": "R4",
  "server": { "id": "..." },
  "operation": "error",
  "target": { "method": "GET", "path": "/Patient/missing", "resourceType": "Patient" },
  "httpStatus": 404,
  "operationOutcome": { "commitment": {...} },
  "reason": "http-4xx"
}
```

`reason` is one of: `network`, `http-4xx`, `http-5xx`, `timeout`,
`aborted`, `malformed-response`, `unknown`. It is deliberately coarse
so the receipt never carries a raw error message.

## 10. Vectors

The following vectors under `spec/1.0/vectors/` are part of the
compatibility contract:

- `fhir-read-r4.json`
- `fhir-versioned-read-r4.json`
- `fhir-search-r4.json`
- `fhir-create-r4.json`
- `fhir-transaction-r4.json`
- `fhir-error-r4.json`
- `fhir-redacted-query-r4.json`

An implementation is v1-conformant when it recomputes every pinned
commitment in these files.
