# Extensions

Extension events carry domain semantics that do not belong in the core
protocol vocabulary. A `clinical-receipt` verifier can always check the
integrity of a receipt containing extension events; understanding what
those events *mean* is a namespace-aware verifier's job.

The words MUST, MUST NOT, SHOULD, and MAY are used as in RFC 2119.

## 1. Namespaces

An extension namespace is a dotted reverse-DNS name (`org.hl7.fhir`) or
an absolute URI (`https://example.org/receipt-events/discharge/v1`).

Every extension event type belongs to exactly one namespace:

- For a reverse-DNS event type such as `org.hl7.fhir.resource.read`, the
  namespace is the longest reserved-namespace prefix that the receiver's
  registry recognizes (`org.hl7.fhir` in this case). If no reserved
  namespace matches, the whole event type is treated as opaque.
- For a URI event type, the namespace is the scheme + authority component
  (or the full URI if the receiver's registry stores a longer form).

An event type MUST:

- either contain a colon (URI form), or
- consist of at least three reverse-DNS segments matching
  `[a-zA-Z][a-zA-Z0-9-]*`.

Core event types (`input.observed`, `human.review.completed`) are always
disjoint from extension event types.

## 2. Payload shape

An extension event's payload MUST be a JSON object. If the event's
namespace is registered as a reserved namespace on the receiver, the
payload MUST additionally include a top-level string field:

```json
{
  "extensionVersion": "1"
}
```

`extensionVersion` is a monotonically increasing string per namespace.
Any incompatible change to the committed shape of any event kind in the
namespace MUST bump this value. Byte-pinned vectors declared against a
particular `extensionVersion` MUST remain verifiable forever.

Namespaces that are not reserved on the receiver skip semantic validation
entirely — the core protocol commits to the bytes of the payload and
makes no further claim about them.

## 3. Reserved namespaces

`clinical-receipt` v1.0 reserves the following namespaces:

| Namespace | Purpose | Ships in |
| --- | --- | --- |
| `org.hl7.fhir` | Reads, searches, writes, and transactions against a FHIR R4 store | Package 0.2.0 |

Additional reserved namespaces MAY be added to future package versions;
they MUST NOT retroactively change the shape of receipts produced by
prior versions.

## 4. Verifier behavior

A core verifier MUST report, for every receipt, which reserved namespaces
appear in its events (`extensions.understood`) and which unrecognized
namespaces or URIs appear (`extensions.unknown`).

A core verifier MUST NOT reject a cryptographically valid receipt merely
because it does not understand a registered extension event. Integrity
and semantics are separate axes; the report communicates both.

A namespace-aware verifier MAY perform additional checks against the
payloads of events it understands. Those checks belong in a separate
verifier surface (for example, `@0xsarwagya/clinical-receipt/fhir`).

## 5. Selective disclosure

Extension events participate in the receipt's existing selective
disclosure mechanism unchanged. A disclosure package MAY reveal any
subset of extension events; the verifier proves that revealed events
belong to the original committed receipt without needing to understand
their semantics.

## 6. Extension registration

An implementation registers a reserved namespace at module load time.
Once registered, the recorder validates each extension event's payload
against the namespace's declared shape before the event enters the DAG.
Registration is idempotent — re-registering the same namespace under
CJS/ESM interop is a no-op, not an error.

Registration is a runtime concept, not part of the wire format. The wire
format is defined entirely by the event type strings and payload bytes.
