import { ReceiptError, type ReceiptOperation } from "../errors.js";
import { utf8Bytes } from "./encoding.js";
import { jcsBytes } from "./jcs.js";

export const CANONICALIZATION_PROFILES = [
  "jcs@1",
  "bytes@1",
  "utf8@1",
  "utf8-nfc@1",
  "clinical-receipt-event@1",
] as const;

export type CanonicalizationProfile = (typeof CANONICALIZATION_PROFILES)[number];

/**
 * Alias registry. An alias names an existing base profile so that a
 * commitment tag can carry FHIR-specific expectations without changing
 * bytes. Registration is idempotent (same alias → same base is a
 * no-op); re-registering an alias to a different base throws. Aliases
 * cannot be removed.
 */
const ALIASES = new Map<string, CanonicalizationProfile>();

export function registerCanonicalizationProfile(
  alias: string,
  base: CanonicalizationProfile,
): void {
  const existing = ALIASES.get(alias);
  if (existing !== undefined) {
    if (existing !== base) {
      throw new ReceiptError({
        code: "UNSUPPORTED_CANONICALIZATION",
        message: `canonicalization alias ${alias} already registered under ${existing}`,
        operation: "canonicalize",
      });
    }
    return;
  }
  ALIASES.set(alias, base);
}

/**
 * Produces the canonical bytes a commitment is computed over. Aliases
 * are resolved to their base profile before dispatch, so pinned vectors
 * stay valid across the alias table.
 */
export function canonicalize(
  profile: string,
  value: unknown,
  operation: ReceiptOperation = "canonicalize",
): Uint8Array<ArrayBuffer> {
  const alias = ALIASES.get(profile);
  const resolved = alias ?? profile;
  switch (resolved) {
    case "jcs@1":
    case "clinical-receipt-event@1":
      // The event profile IS jcs@1 applied to the committed envelope form;
      // the distinct identifier exists so a commitment names what it was.
      return jcsBytes(value);
    case "bytes@1": {
      if (!(value instanceof Uint8Array)) {
        throw new ReceiptError({
          code: "CANONICALIZATION_FAILED",
          message: "bytes@1 requires a Uint8Array",
          operation,
        });
      }
      return new Uint8Array(value) as Uint8Array<ArrayBuffer>;
    }
    case "utf8@1": {
      if (typeof value !== "string") {
        throw new ReceiptError({
          code: "CANONICALIZATION_FAILED",
          message: "utf8@1 requires a string",
          operation,
        });
      }
      return utf8Bytes(value);
    }
    case "utf8-nfc@1": {
      if (typeof value !== "string") {
        throw new ReceiptError({
          code: "CANONICALIZATION_FAILED",
          message: "utf8-nfc@1 requires a string",
          operation,
        });
      }
      return utf8Bytes(value.normalize("NFC"));
    }
    default:
      throw new ReceiptError({
        code: "UNSUPPORTED_CANONICALIZATION",
        message: `unknown canonicalization profile: ${JSON.stringify(profile)}`,
        operation,
      });
  }
}
