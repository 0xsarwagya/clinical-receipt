import { registerCanonicalizationProfile } from "../core/canonicalize.js";
import { FHIR_CANONICALIZATION } from "./constants.js";

/**
 * Register `fhir-json-r4@1` as a first-class canonicalization profile.
 *
 * v0.2.0 is byte-equivalent to `jcs@1` — we run FHIR JSON through the
 * exact same canonicalizer. The profile exists as its own name for two
 * reasons:
 *
 *   1. Any future FHIR-specific pre-normalization (primitive
 *      extensions, contained resources, terminology folding) must be
 *      opt-in and versioned, so existing receipts stay verifiable.
 *   2. Consumers can tell from a commitment that FHIR-shaped input was
 *      expected without having to inspect the payload.
 *
 * Registration is exposed as an explicit function AND self-invoked at
 * module load: bundlers that respect `sideEffects` pick up the load-time
 * call, while bundlers that tree-shake side-effect-only imports are
 * covered by callers who invoke `registerFhirCanonicalization()`
 * eagerly (twin of `registerFhirNamespace()`).
 */

let registered = false;

export function registerFhirCanonicalization(): void {
  if (registered) return;
  registered = true;
  registerCanonicalizationProfile(FHIR_CANONICALIZATION, "jcs@1");
}

registerFhirCanonicalization();
