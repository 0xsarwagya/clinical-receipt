export type ReceiptErrorCode =
  | "UNSUPPORTED"
  | "INVALID_ARGUMENT"
  | "CANONICALIZATION_FAILED"
  | "UNSUPPORTED_CANONICALIZATION"
  | "UNSUPPORTED_ALGORITHM"
  | "UNSUPPORTED_VERSION"
  | "EMBED_NOT_ALLOWED"
  | "PAYLOAD_NOT_COMMITTABLE"
  | "UNKNOWN_PARENT"
  | "RECEIPT_FINALIZED"
  | "RECEIPT_NOT_FINALIZED"
  | "MALFORMED_RECEIPT"
  | "MALFORMED_DISCLOSURE"
  | "MALFORMED_PROOF"
  | "SIGNING_FAILED"
  | "KEY_IMPORT_FAILED"
  | "IO_ERROR"
  | "USAGE"
  | "MALFORMED_EXTENSION"
  | "PARTIAL_INSTRUMENTATION_UNSAFE"
  | "UNSAFE_HEADER"
  | "UNSAFE_QUERY_POLICY"
  | "FHIR_RESPONSE_UNCONSUMABLE";

export type ReceiptOperation =
  | "canonicalize"
  | "commit"
  | "record"
  | "finalize"
  | "sign"
  | "disclose"
  | "verifyReceipt"
  | "verifyDisclosure"
  | "parse"
  | "importKey"
  | "cli"
  | "fhirOperation"
  | "fhirFetch"
  | "fhirClient"
  | "verifyFhir"
  | "inspectFhir";

/**
 * Every failure is typed. Messages may name field paths, types, and
 * identifiers — never payload values. A clinical error log must be safe
 * to attach to a ticket.
 */
export class ReceiptError extends Error {
  readonly code: ReceiptErrorCode;
  readonly operation: ReceiptOperation;

  constructor(options: {
    code: ReceiptErrorCode;
    message: string;
    operation: ReceiptOperation;
    cause?: unknown;
  }) {
    super(options.message, { cause: options.cause });
    this.name = "ReceiptError";
    this.code = options.code;
    this.operation = options.operation;
  }
}

export function isReceiptError(value: unknown): value is ReceiptError {
  return value instanceof ReceiptError;
}
