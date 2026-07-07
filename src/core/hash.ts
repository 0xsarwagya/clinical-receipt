import { ReceiptError, type ReceiptOperation } from "../errors.js";
import { HASH_SHA256 } from "./constants.js";

export interface HashAlgorithm {
  readonly id: string;
  digest(input: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>>;
}

/** SHA-256 via WebCrypto — present in Node ≥ 20, browsers, edge runtimes. */
export const sha256: HashAlgorithm = {
  id: HASH_SHA256,
  async digest(input) {
    const subtle = globalThis.crypto?.subtle;
    if (subtle === undefined) {
      throw new ReceiptError({
        code: "UNSUPPORTED",
        message: "Web Crypto (crypto.subtle) is not available in this runtime.",
        operation: "commit",
      });
    }
    return new Uint8Array(await subtle.digest("SHA-256", input));
  },
};

const REGISTERED: ReadonlyMap<string, HashAlgorithm> = new Map([
  [sha256.id, sha256],
]);

export function resolveHash(
  id: string,
  operation: ReceiptOperation,
): HashAlgorithm {
  const algorithm = REGISTERED.get(id);
  if (algorithm === undefined) {
    throw new ReceiptError({
      code: "UNSUPPORTED_ALGORITHM",
      message: `unknown hash algorithm identifier: ${JSON.stringify(id)}`,
      operation,
    });
  }
  return algorithm;
}
