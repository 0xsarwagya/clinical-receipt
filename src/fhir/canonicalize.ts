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
 */
registerCanonicalizationProfile(FHIR_CANONICALIZATION, "jcs@1");
