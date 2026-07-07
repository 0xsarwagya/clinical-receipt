# Canonicalization Profiles

Every commitment names the canonicalization profile that produced its
input bytes. Profiles are versioned; a receipt remains verifiable with
the profile it names, forever. Registered profiles in 1.0:

| Profile | Input | Output bytes |
| --- | --- | --- |
| `jcs@1` | JSON value | RFC 8785 canonical JSON, UTF-8 |
| `bytes@1` | binary | the bytes, unchanged |
| `utf8@1` | text | UTF-8 encoding, no Unicode normalization |
| `utf8-nfc@1` | text | NFC normalization, then UTF-8 |
| `clinical-receipt-event@1` | event committed form | `jcs@1` of the committed envelope object |

There is no default text profile: callers choose `utf8@1` or
`utf8-nfc@1` explicitly. FHIR-aware profiles (`fhir-r4-json@…`) are
reserved for a future revision of this specification and MUST NOT be
improvised.

## jcs@1 (RFC 8785)

The canonical form is RFC 8785 JSON Canonicalization Scheme:

- Object members sorted by property name, compared as sequences of
  UTF-16 code units.
- No insignificant whitespace.
- Strings serialized with ECMA-262 `JSON.stringify` escaping (minimal
  escapes; `\u` escapes lowercase hex, only where required).
- Numbers serialized with ECMAScript `Number::toString` — the
  shortest-round-trip form. Implementations in other languages MUST use
  a shortest-round-trip algorithm (Ryu or equivalent) that matches
  ECMAScript output exactly.
- `-0` serializes as `0`.

A conforming implementation MUST reject (not coerce) the following
inputs with a canonicalization error:

- `undefined` anywhere (including inside arrays);
- non-finite numbers (`NaN`, `±Infinity`);
- `BigInt`, functions, symbols;
- objects whose prototype is neither `Object.prototype` nor `null`
  (Dates, Maps, Sets, class instances — `toJSON` is never invoked);
- strings containing lone surrogates (the input must be well-formed
  Unicode).

Rationale: every rejected case is a value that ECMAScript JSON
serialization would silently reshape. A commitment over silently
reshaped data is a lie about what was committed.

## clinical-receipt-event@1

The committed form of an event envelope, defined field-by-field in
`commitments.md` §4, serialized with the `jcs@1` rules above.

## utf8-nfc@1

The text is normalized to Unicode Normalization Form C, then encoded as
UTF-8. Use this profile when the text may cross systems that disagree
about composed/decomposed forms (names, addresses). Use `utf8@1` when
byte-exactness of the original is the requirement.
