/**
 * Standalone verification entry — depends only on core, verify/, errors,
 * and the signing primitives needed for public-key import. A verifier can
 * `import * from "@0xsarwagya/clinical-receipt/verify"` without pulling in
 * the recorder.
 */
export { parseReceipt, parseDisclosure } from "./verify/parse.js";
export { verifyReceipt, checkEvent } from "./verify/receipt.js";
export type { VerifyOptions } from "./verify/receipt.js";
export { verifyDisclosure } from "./verify/disclosure.js";
export type { VerifyDisclosureOptions } from "./verify/disclosure.js";
export type {
  DisclosureVerificationReport,
  EventFailure,
  SignatureStatus,
  VerificationReport,
  VerificationWarning,
} from "./verify/report.js";

export { verifyInclusionProof, leafHash, nodeHash } from "./core/merkle.js";
export type { InclusionProof } from "./core/merkle.js";
export { commitPayload, commitmentsEqual } from "./core/commitment.js";
export type { Commitment } from "./core/commitment.js";
export { canonicalize, CANONICALIZATION_PROFILES } from "./core/canonicalize.js";
export type { CanonicalizationProfile } from "./core/canonicalize.js";
export { sha256, resolveHash } from "./core/hash.js";
export type { HashAlgorithm } from "./core/hash.js";
export {
  bytesToHex,
  decodeBase64Url,
  encodeBase64Url,
  hexToBytes,
} from "./core/encoding.js";
export { SPEC_NAME, SPEC_VERSION, CORE_EVENT_TYPES } from "./core/constants.js";

export {
  importVerificationKey,
  exportVerificationKey,
} from "./signing/webcrypto.js";
export type { VerificationKey } from "./signing/webcrypto.js";
export { deriveKeyId, signaturePayloadBytes } from "./signing/signer.js";
export type { SignatureRecord } from "./signing/signer.js";

export { ReceiptError, isReceiptError } from "./errors.js";
export type { ReceiptErrorCode, ReceiptOperation } from "./errors.js";
