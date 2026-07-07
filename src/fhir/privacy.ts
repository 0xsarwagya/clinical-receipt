import { ReceiptError, type ReceiptOperation } from "../errors.js";
import { canonicalize } from "../core/canonicalize.js";
import { HASH_SHA256 } from "../core/constants.js";
import { bytesToHex } from "../core/encoding.js";
import { resolveHash } from "../core/hash.js";
import {
  BLOCKED_RESPONSE_HEADERS,
  DEFAULT_PERMITTED_RESPONSE_HEADERS,
} from "./constants.js";

export type QueryTransform = "preserve" | "hash" | "redact";
export type ResourceIdTransform = "preserve" | "hash";

export interface PrivacyPolicy {
  /** Per-parameter transform. Default is `preserve`. */
  query?: Record<string, QueryTransform>;
  /** Applies to logical resource ids in event payloads. Default `preserve`. */
  resourceIds?: ResourceIdTransform;
  /** Case-insensitive allowlist of response headers permitted to be committed. */
  headers?: readonly string[];
}

export interface AppliedPrivacy {
  query: Record<string, QueryTransform>;
  resourceIds: ResourceIdTransform;
  headers: string[];
}

const BLOCKED_SET = new Set<string>(BLOCKED_RESPONSE_HEADERS);

/**
 * Validates the caller's privacy policy and returns a normalized copy.
 * Wildcards are refused — every parameter and header opts in explicitly
 * so an ergonomic mistake cannot silently commit PHI.
 */
export function normalizePrivacyPolicy(
  policy: PrivacyPolicy | undefined,
  operation: ReceiptOperation,
): AppliedPrivacy {
  const query: Record<string, QueryTransform> = {};
  const queryInput = policy?.query ?? {};
  for (const [name, transform] of Object.entries(queryInput)) {
    if (name === "*" || name === "") {
      throw new ReceiptError({
        code: "UNSAFE_QUERY_POLICY",
        message:
          "wildcard query privacy is not permitted — name each parameter explicitly",
        operation,
      });
    }
    if (
      transform !== "preserve" &&
      transform !== "hash" &&
      transform !== "redact"
    ) {
      throw new ReceiptError({
        code: "UNSAFE_QUERY_POLICY",
        message: `unknown query transform for parameter ${JSON.stringify(name)}`,
        operation,
      });
    }
    query[name] = transform;
  }

  const resourceIds: ResourceIdTransform = policy?.resourceIds ?? "preserve";
  if (resourceIds !== "preserve" && resourceIds !== "hash") {
    throw new ReceiptError({
      code: "UNSAFE_QUERY_POLICY",
      message: "resourceIds transform must be preserve or hash",
      operation,
    });
  }

  const headersInput = policy?.headers ?? DEFAULT_PERMITTED_RESPONSE_HEADERS;
  const headers: string[] = [];
  for (const header of headersInput) {
    if (header === "*") {
      throw new ReceiptError({
        code: "UNSAFE_HEADER",
        message:
          "wildcard header allowlist is not permitted — name each header explicitly",
        operation,
      });
    }
    const lower = String(header).toLowerCase();
    if (BLOCKED_SET.has(lower)) {
      throw new ReceiptError({
        code: "UNSAFE_HEADER",
        message: `header ${lower} is unconditionally blocked from committal`,
        operation,
      });
    }
    if (!headers.includes(lower)) {
      headers.push(lower);
    }
  }

  return { query, resourceIds, headers: headers.sort() };
}

/**
 * Deterministic short hash for query values / resource ids under
 * `hash` privacy. 32-hex chars of SHA-256 — long enough to be
 * dictionary-resistant for the input space, short enough to log.
 */
async function shortHash(input: string): Promise<string> {
  const hash = resolveHash(HASH_SHA256, "canonicalize");
  const digest = await hash.digest(
    canonicalize("utf8@1", input, "canonicalize"),
  );
  return bytesToHex(digest.slice(0, 16));
}

/**
 * Apply query transforms to a raw parameter map. Values are stringified
 * (FHIR search params are always textual). Returns a NEW object with
 * the applied transforms; the original is not mutated.
 */
export async function applyQueryPrivacy(
  raw: Record<string, string | string[] | number | boolean | null | undefined>,
  privacy: AppliedPrivacy,
): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const [name, rawValue] of Object.entries(raw)) {
    if (rawValue === null || rawValue === undefined) continue;
    const values = Array.isArray(rawValue) ? rawValue : [rawValue];
    const transformed: string[] = [];
    for (const value of values) {
      const asString = typeof value === "string" ? value : String(value);
      const rule = privacy.query[name] ?? "preserve";
      if (rule === "preserve") {
        transformed.push(asString);
      } else if (rule === "hash") {
        transformed.push(`sha256:${await shortHash(asString)}`);
      } else if (rule === "redact") {
        transformed.push("[redacted]");
      }
    }
    // Multiple values (FHIR OR search) become a comma-joined string;
    // the transform is applied per-value, not to the joined form.
    out[name] = transformed.join(",");
  }
  return out;
}

/** Apply a `hash` transform to a resource logical id, when configured. */
export async function applyResourceIdPrivacy(
  id: string,
  privacy: AppliedPrivacy,
): Promise<{ id?: string; idCommitment?: string }> {
  if (privacy.resourceIds === "hash") {
    return { idCommitment: `sha256:${await shortHash(id)}` };
  }
  return { id };
}

/**
 * Filter a header map down to the caller's allowlist. Names are compared
 * case-insensitively; the committed name is always lowercase.
 */
export function filterPermittedHeaders(
  headers: Iterable<[string, string]> | Record<string, string>,
  privacy: AppliedPrivacy,
): Record<string, string> {
  const iterable: Iterable<[string, string]> = Array.isArray(headers)
    ? (headers as unknown as Iterable<[string, string]>)
    : typeof (headers as { entries?: unknown }).entries === "function"
      ? (headers as unknown as { entries: () => Iterable<[string, string]> }).entries()
      : Object.entries(headers as Record<string, string>);
  const out: Record<string, string> = {};
  for (const [rawName, value] of iterable) {
    const name = String(rawName).toLowerCase();
    if (BLOCKED_SET.has(name)) continue;
    if (!privacy.headers.includes(name)) continue;
    out[name] = value;
  }
  return out;
}
