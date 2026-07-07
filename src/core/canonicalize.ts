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
 * Produces the canonical bytes a commitment is computed over. Pure
 * dispatch — there is no mutable registry, so a verifier's behaviour can
 * never be changed at runtime.
 */
export function canonicalize(
  profile: string,
  value: unknown,
  operation: ReceiptOperation = "canonicalize",
): Uint8Array<ArrayBuffer> {
  switch (profile) {
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
