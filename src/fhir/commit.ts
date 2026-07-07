import { canonicalize } from "../core/canonicalize.js";
import { commitPayload, type Commitment } from "../core/commitment.js";
import { PAYLOAD_SALT_BYTES } from "../core/constants.js";
import type { HashAlgorithm } from "../core/hash.js";
import type { ReceiptOperation } from "../errors.js";
import { FHIR_CANONICALIZATION } from "./constants.js";

// Register the profile as a side effect of importing this module.
// canonicalize.ts is a pure switch on `resolved`; the alias registry
// resolves `fhir-json-r4@1` → `jcs@1` for v0.2.0.
import "./canonicalize.js";

export interface CommitFhirResourceOptions {
  salt?: Uint8Array<ArrayBuffer> | null;
  hash?: HashAlgorithm;
  operation?: ReceiptOperation;
  random?: (byteLength: number) => Uint8Array<ArrayBuffer>;
}

function defaultRandom(byteLength: number): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(byteLength);
  globalThis.crypto.getRandomValues(bytes);
  return bytes;
}

/**
 * Commit a FHIR JSON value (Resource, Bundle, or OperationOutcome) to a
 * `Commitment` tagged with `fhir-json-r4@1`. The default salt is a
 * fresh 16 random bytes; callers may inject a deterministic value for
 * test vectors, or pass `null` to skip salting (vectors only — PHI is
 * dictionary-attackable without salt).
 */
export async function commitFhirValue(
  value: unknown,
  options: CommitFhirResourceOptions = {},
): Promise<Commitment> {
  const random = options.random ?? defaultRandom;
  const salt =
    options.salt === null
      ? null
      : options.salt ?? random(PAYLOAD_SALT_BYTES);
  const canonicalBytes = canonicalize(
    FHIR_CANONICALIZATION,
    value,
    options.operation ?? "commit",
  );
  return commitPayload(canonicalBytes, {
    canonicalization: FHIR_CANONICALIZATION,
    salt,
    ...(options.hash !== undefined ? { hash: options.hash } : {}),
    ...(options.operation !== undefined ? { operation: options.operation } : {}),
  });
}

/**
 * Commit a FHIR Resource. Alias of `commitFhirValue` — kept as a named
 * export so call sites read cleanly.
 */
export const commitFhirResource = commitFhirValue;

/**
 * Commit a FHIR Bundle. Also an alias — the canonicalization is the
 * same as for any resource. Named separately so pinned vectors and
 * inspection tooling can distinguish "this commitment names a Bundle"
 * from "this commitment names a Resource".
 */
export const commitFhirBundle = commitFhirValue;
