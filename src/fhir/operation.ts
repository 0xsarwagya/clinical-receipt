import { ReceiptError } from "../errors.js";
import type { ReceiptRun, RecordedEvent, RecordOptions } from "../recorder/receipt.js";
import {
  FHIR_EVENT_KINDS,
  FHIR_EXTENSION_VERSION,
  FHIR_R4,
  FHIR_RESOURCE_PATH,
  FHIR_TYPE_PATH,
  FHIR_VERSIONED_PATH,
} from "./constants.js";
import { commitFhirBundle, commitFhirValue } from "./commit.js";
import {
  applyQueryPrivacy,
  applyResourceIdPrivacy,
  filterPermittedHeaders,
  normalizePrivacyPolicy,
  type AppliedPrivacy,
  type PrivacyPolicy,
} from "./privacy.js";
import "./register.js";
import type {
  FhirErrorPayload,
  FhirResourceReadPayload,
  FhirResourceRef,
  FhirResourceVersionedReadPayload,
  FhirResourceWritePayload,
  FhirSearchPayload,
  FhirServer,
  FhirTransactionPayload,
} from "./schemas.js";

export interface FhirNamespaceHandle {
  operation(input: FhirOperationInput): FhirOperation;
}

export interface FhirOperationInput {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  /** Absolute URL to the FHIR server, e.g. `https://hapi.fhir.org/baseR4`. */
  baseUrl: string;
  /** Path relative to `baseUrl`, e.g. `/Patient/123`. */
  path: string;
  /** Raw query parameters as observed on the wire (before privacy). */
  query?: Record<string, string | string[] | number | boolean | null | undefined>;
  /** Body the caller submitted; committed under `submitted.commitment` for writes. */
  body?: unknown;
  /**
   * Server descriptor. Only `.id` is committed as identity; everything
   * else is optional metadata.
   */
  server?: FhirServer;
  privacy?: PrivacyPolicy;
}

export interface FhirCommitResponseInput {
  status: number;
  body?: unknown;
  headers?: Iterable<[string, string]> | Record<string, string>;
}

export interface FhirCommitErrorInput {
  reason?: FhirErrorPayload["reason"];
  httpStatus?: number;
  /** OperationOutcome resource, if the server returned one. */
  operationOutcome?: unknown;
}

export interface FhirOperation {
  commitResponse(
    response: FhirCommitResponseInput,
    recordOptions?: RecordOptions,
  ): Promise<RecordedEvent>;
  commitError(
    error: FhirCommitErrorInput,
    recordOptions?: RecordOptions,
  ): Promise<RecordedEvent>;
}

interface ParsedOp {
  kind: "read" | "vread" | "write-create" | "write-update" | "write-patch" | "write-delete" | "search" | "transaction" | "type-post-unknown";
  resourceType?: string;
  logicalId?: string;
  versionId?: string;
}

/** Route a normalized FHIR operation to its event kind. */
function parseOperation(
  method: string,
  path: string,
  body: unknown,
): ParsedOp {
  const trimmed = path.split("?")[0] ?? path;
  const versioned = FHIR_VERSIONED_PATH.exec(trimmed);
  if (versioned !== null && method === "GET") {
    // All three captures are guaranteed non-empty by the regex.
    const resourceType = versioned[1] as string;
    const logicalId = versioned[2] as string;
    const versionId = versioned[3] as string;
    return { kind: "vread", resourceType, logicalId, versionId };
  }
  const single = FHIR_RESOURCE_PATH.exec(trimmed);
  if (single !== null) {
    const resourceType = single[1] as string;
    const logicalId = single[2] as string;
    if (method === "GET") return { kind: "read", resourceType, logicalId };
    if (method === "PUT") return { kind: "write-update", resourceType, logicalId };
    if (method === "PATCH") return { kind: "write-patch", resourceType, logicalId };
    if (method === "DELETE") return { kind: "write-delete", resourceType, logicalId };
  }
  const type = FHIR_TYPE_PATH.exec(trimmed);
  if (type !== null) {
    const resourceType = type[1] as string;
    if (method === "GET") return { kind: "search", resourceType };
    if (method === "POST") return { kind: "write-create", resourceType };
  }
  // Bundle POST at the base — transaction/batch.
  if ((trimmed === "" || trimmed === "/") && method === "POST") {
    const body_ = body as { type?: unknown } | undefined | null;
    if (
      body_ !== null &&
      typeof body_ === "object" &&
      (body_.type === "transaction" || body_.type === "batch")
    ) {
      return { kind: "transaction" };
    }
    return { kind: "type-post-unknown" };
  }
  return { kind: "type-post-unknown" };
}

interface HandleContext {
  run: ReceiptRun;
  server: FhirServer;
  privacy: AppliedPrivacy;
  privacyDescriptor: {
    query?: Record<string, "preserve" | "hash" | "redact">;
    resourceIds?: "preserve" | "hash";
  };
  /**
   * Optional random source used for FHIR resource commitment salts. When
   * two independent receipts pass the SAME random source (or the same
   * seeded generator), identical FHIR bodies produce identical
   * commitment digests — the invariant a "same input state" comparison
   * needs. Absent by default; `commitFhirValue` falls back to
   * `crypto.getRandomValues`.
   */
  random: ((byteLength: number) => Uint8Array<ArrayBuffer>) | undefined;
}

/**
 * The commitment options every FHIR resource commit inside this
 * module uses. Threads `random` from the extension handle so callers
 * who want deterministic commitments (Same State-style comparisons,
 * test vectors) get identical digests for identical bytes.
 */
function commitOptions(
  context: HandleContext,
): { operation: "fhirOperation"; random?: (byteLength: number) => Uint8Array<ArrayBuffer> } {
  return context.random !== undefined
    ? { operation: "fhirOperation", random: context.random }
    : { operation: "fhirOperation" };
}

function privacyDescriptor(privacy: AppliedPrivacy): HandleContext["privacyDescriptor"] {
  const query = Object.keys(privacy.query).length > 0 ? privacy.query : undefined;
  const resourceIds =
    privacy.resourceIds === "hash" ? ("hash" as const) : undefined;
  const descriptor: HandleContext["privacyDescriptor"] = {};
  if (query !== undefined) descriptor.query = query;
  if (resourceIds !== undefined) descriptor.resourceIds = resourceIds;
  return descriptor;
}

async function makeResourceRef(
  resourceType: string,
  logicalId: string | undefined,
  meta: { versionId?: string; lastUpdated?: string } | undefined,
  privacy: AppliedPrivacy,
): Promise<FhirResourceRef> {
  const idPart =
    logicalId !== undefined
      ? await applyResourceIdPrivacy(logicalId, privacy)
      : {};
  return {
    type: resourceType,
    ...idPart,
    ...(meta?.versionId !== undefined ? { versionId: meta.versionId } : {}),
    ...(meta?.lastUpdated !== undefined ? { lastUpdated: meta.lastUpdated } : {}),
  };
}

function commonMeta(context: HandleContext): {
  extensionVersion: typeof FHIR_EXTENSION_VERSION;
  fhirVersion: typeof FHIR_R4;
  server: FhirServer;
  privacy?: HandleContext["privacyDescriptor"];
} {
  const descriptor = context.privacyDescriptor;
  const hasPrivacy =
    descriptor.query !== undefined || descriptor.resourceIds !== undefined;
  return {
    extensionVersion: FHIR_EXTENSION_VERSION,
    fhirVersion: FHIR_R4,
    server: context.server,
    ...(hasPrivacy ? { privacy: descriptor } : {}),
  };
}

async function buildReadPayload(
  context: HandleContext,
  parsed: ParsedOp & { kind: "read"; resourceType: string; logicalId?: string },
  body: unknown,
  headers: Record<string, string>,
): Promise<FhirResourceReadPayload> {
  const commitment = await commitFhirValue(body, commitOptions(context));
  const bodyMeta = (body as { meta?: { versionId?: string; lastUpdated?: string } } | undefined)?.meta;
  return {
    ...commonMeta(context),
    operation: "read",
    resource: await makeResourceRef(parsed.resourceType, parsed.logicalId, bodyMeta, context.privacy),
    commitment,
    ...(Object.keys(headers).length > 0 ? { responseHeaders: headers } : {}),
  } as FhirResourceReadPayload;
}

async function buildVreadPayload(
  context: HandleContext,
  parsed: ParsedOp & { kind: "vread"; resourceType: string; logicalId?: string; versionId?: string },
  body: unknown,
): Promise<FhirResourceVersionedReadPayload> {
  const commitment = await commitFhirValue(body, commitOptions(context));
  const bodyMeta = (body as { meta?: { versionId?: string; lastUpdated?: string } } | undefined)?.meta;
  const versionId = parsed.versionId ?? bodyMeta?.versionId;
  if (typeof versionId !== "string") {
    throw new ReceiptError({
      code: "MALFORMED_EXTENSION",
      message: "versioned read is missing a versionId",
      operation: "fhirOperation",
    });
  }
  const resource = await makeResourceRef(parsed.resourceType, parsed.logicalId, bodyMeta, context.privacy);
  return {
    ...commonMeta(context),
    operation: "vread",
    resource: { ...resource, versionId },
    commitment,
    versionPinned: true,
  };
}

async function buildSearchPayload(
  context: HandleContext,
  parsed: ParsedOp & { kind: "search"; resourceType: string },
  query: Record<string, string>,
  body: unknown,
): Promise<FhirSearchPayload> {
  const bundle = (body ?? {}) as {
    resourceType?: unknown;
    type?: unknown;
    total?: unknown;
    entry?: Array<{
      fullUrl?: unknown;
      resource?: {
        resourceType?: unknown;
        id?: unknown;
        meta?: { versionId?: unknown; lastUpdated?: unknown };
      };
    }>;
    link?: Array<{ relation?: unknown }>;
  };
  const commitment = await commitFhirBundle(bundle, commitOptions(context));
  const resources: FhirResourceRef[] = [];
  const entries = Array.isArray(bundle.entry) ? bundle.entry : [];
  for (const entry of entries) {
    const resource = entry?.resource;
    if (resource === undefined || resource === null) continue;
    const type = typeof resource.resourceType === "string" ? resource.resourceType : undefined;
    if (type === undefined) continue;
    const idRaw = typeof resource.id === "string" ? resource.id : undefined;
    const meta = resource.meta ?? {};
    const versionMeta: { versionId?: string; lastUpdated?: string } = {};
    if (typeof meta.versionId === "string") versionMeta.versionId = meta.versionId;
    if (typeof meta.lastUpdated === "string") versionMeta.lastUpdated = meta.lastUpdated;
    resources.push(
      await makeResourceRef(type, idRaw, versionMeta, context.privacy),
    );
  }
  const hasNext = Array.isArray(bundle.link)
    ? bundle.link.some((link) => link?.relation === "next")
    : false;
  const pagination = hasNext ? "complete-first-page-only" : "complete";
  const sort = query["_sort"];
  return {
    ...commonMeta(context),
    operation: "search",
    resourceType: parsed.resourceType,
    query,
    ...(typeof bundle.total === "number" ? { total: bundle.total } : {}),
    ...(typeof sort === "string" ? { sort } : {}),
    bundle: { commitment, resources },
    pagination,
  };
}

async function buildWritePayload(
  context: HandleContext,
  parsed: ParsedOp & { kind: `write-${"create" | "update" | "patch" | "delete"}`; resourceType?: string; logicalId?: string; versionId?: string },
  submittedBody: unknown,
  responseBody: unknown,
  headers: Record<string, string>,
): Promise<FhirResourceWritePayload> {
  const operation: FhirResourceWritePayload["operation"] =
    parsed.kind === "write-create"
      ? "create"
      : parsed.kind === "write-update"
        ? "update"
        : parsed.kind === "write-patch"
          ? "patch"
          : "delete";
  const target = {
    type: parsed.resourceType ?? "Resource",
    ...(parsed.logicalId !== undefined ? { id: parsed.logicalId } : {}),
    ...(parsed.versionId !== undefined ? { versionId: parsed.versionId } : {}),
  };
  const submitted =
    submittedBody === undefined || operation === "delete"
      ? undefined
      : { commitment: await commitFhirValue(submittedBody, commitOptions(context)) };
  let persisted: FhirResourceWritePayload["persisted"];
  if (responseBody !== undefined && responseBody !== null) {
    const body = responseBody as {
      resourceType?: unknown;
      id?: unknown;
      meta?: { versionId?: unknown; lastUpdated?: unknown };
    };
    const type = typeof body.resourceType === "string" ? body.resourceType : target.type;
    const id = typeof body.id === "string" ? body.id : parsed.logicalId;
    const meta = body.meta ?? {};
    const versionMeta: { versionId?: string; lastUpdated?: string } = {};
    if (typeof meta.versionId === "string") versionMeta.versionId = meta.versionId;
    if (typeof meta.lastUpdated === "string") versionMeta.lastUpdated = meta.lastUpdated;
    persisted = {
      resource: await makeResourceRef(type, id, versionMeta, context.privacy),
      commitment: await commitFhirValue(body, commitOptions(context)),
    };
  }
  const location = headers["location"] ?? headers["content-location"];
  return {
    ...commonMeta(context),
    operation,
    target,
    ...(submitted !== undefined ? { submitted } : {}),
    ...(persisted !== undefined ? { persisted } : {}),
    ...(typeof location === "string" ? { location } : {}),
  };
}

async function buildTransactionPayload(
  context: HandleContext,
  submittedBody: unknown,
  responseBody: unknown,
): Promise<FhirTransactionPayload> {
  const submittedBundle = (submittedBody ?? {}) as { entry?: unknown[]; type?: string };
  const entryCount = Array.isArray(submittedBundle.entry) ? submittedBundle.entry.length : 0;
  const submitted = {
    commitment: await commitFhirBundle(submittedBundle, commitOptions(context)),
    entryCount,
  };
  let response: FhirTransactionPayload["response"];
  if (responseBody !== undefined && responseBody !== null) {
    const respBundle = responseBody as { entry?: Array<{ response?: { status?: unknown; location?: unknown } }> };
    const entries = Array.isArray(respBundle.entry)
      ? respBundle.entry.map((entry) => ({
          status: String(entry?.response?.status ?? ""),
          ...(typeof entry?.response?.location === "string"
            ? { location: entry.response.location }
            : {}),
        }))
      : [];
    response = {
      commitment: await commitFhirBundle(respBundle, commitOptions(context)),
      entries,
    };
  }
  const operation: "transaction" | "batch" =
    submittedBundle.type === "batch" ? "batch" : "transaction";
  return {
    ...commonMeta(context),
    operation,
    submitted,
    ...(response !== undefined ? { response } : {}),
  };
}

/**
 * The FHIR namespace handle exposed on a receipt run:
 *
 *   const fhir = fhirExtension(run, { server, privacy });
 *   const op = fhir.operation({ method: "GET", baseUrl, path: "/Patient/123" });
 *   const response = await customFetch(...);
 *   await op.commitResponse({ status: 200, body: await response.json() });
 *
 * This is the Level-3 universal fallback — every higher-level integration
 * (fetch wrapper, instrumented client) is a shape on top of this one path.
 */
export interface FhirExtensionOptions {
  server: FhirServer;
  privacy?: PrivacyPolicy;
  /**
   * Optional random source for FHIR resource commitment salts. Two
   * independent `fhirExtension` handles sharing the same random source
   * (or the same seeded generator) will produce IDENTICAL commitment
   * digests for identical FHIR bodies — the invariant a "same input
   * state" comparison needs. Absent by default, and the fallback is
   * `globalThis.crypto.getRandomValues`.
   *
   * Note: this ONLY controls the salt on FHIR resource commitments
   * (the `commitment` field inside `resource.read`, `search.bundle`,
   * `resource.write` payloads). The recorder-side event envelope salt
   * is controlled by `createReceipt({ random })`.
   */
  random?: (byteLength: number) => Uint8Array<ArrayBuffer>;
}

export function fhirExtension(
  run: ReceiptRun,
  options: FhirExtensionOptions,
): FhirNamespaceHandle {
  if (typeof options?.server?.id !== "string" || options.server.id.length === 0) {
    throw new ReceiptError({
      code: "INVALID_ARGUMENT",
      message: "server.id is required",
      operation: "fhirOperation",
    });
  }
  const privacy = normalizePrivacyPolicy(options.privacy, "fhirOperation");
  const context: HandleContext = {
    run,
    server: options.server,
    privacy,
    privacyDescriptor: privacyDescriptor(privacy),
    random: options.random,
  };
  return {
    operation(input) {
      return makeOperation(context, input);
    },
  };
}

function makeOperation(context: HandleContext, input: FhirOperationInput): FhirOperation {
  const parsed = parseOperation(input.method, input.path, input.body);
  const queryPromise = input.query
    ? applyQueryPrivacy(input.query, context.privacy)
    : Promise.resolve<Record<string, string>>({});

  const commit = async (
    response: FhirCommitResponseInput,
    recordOptions?: RecordOptions,
  ): Promise<RecordedEvent> => {
    const filteredHeaders = filterPermittedHeaders(
      response.headers ?? {},
      context.privacy,
    );
    const query = await queryPromise;
    let kind: string;
    let payload: unknown;
    switch (parsed.kind) {
      case "read":
        kind = FHIR_EVENT_KINDS.resourceRead;
        payload = await buildReadPayload(
          context,
          parsed as ParsedOp & { kind: "read"; resourceType: string; logicalId?: string },
          response.body,
          filteredHeaders,
        );
        break;
      case "vread":
        kind = FHIR_EVENT_KINDS.resourceVersionedRead;
        payload = await buildVreadPayload(
          context,
          parsed as ParsedOp & { kind: "vread"; resourceType: string; logicalId?: string; versionId?: string },
          response.body,
        );
        break;
      case "search":
        kind = FHIR_EVENT_KINDS.search;
        payload = await buildSearchPayload(
          context,
          parsed as ParsedOp & { kind: "search"; resourceType: string },
          query,
          response.body,
        );
        break;
      case "write-create":
      case "write-update":
      case "write-patch":
      case "write-delete":
        kind = FHIR_EVENT_KINDS.resourceWrite;
        payload = await buildWritePayload(
          context,
          parsed as ParsedOp & { kind: `write-${"create" | "update" | "patch" | "delete"}`; resourceType?: string; logicalId?: string; versionId?: string },
          input.body,
          response.body,
          filteredHeaders,
        );
        break;
      case "transaction":
        kind = FHIR_EVENT_KINDS.transaction;
        payload = await buildTransactionPayload(context, input.body, response.body);
        break;
      default:
        throw new ReceiptError({
          code: "INVALID_ARGUMENT",
          message: `unsupported FHIR path shape for ${input.method} ${input.path}`,
          operation: "fhirOperation",
        });
    }
    return context.run.event(
      kind,
      { value: payload, mode: "embedded", embed: true },
      recordOptions,
    );
  };

  const error = async (
    err: FhirCommitErrorInput,
    recordOptions?: RecordOptions,
  ): Promise<RecordedEvent> => {
    const payload: FhirErrorPayload = {
      ...commonMeta(context),
      operation: "error",
      target: {
        method: input.method,
        path: input.path,
        ...(parsed.resourceType !== undefined ? { resourceType: parsed.resourceType } : {}),
      },
      ...(typeof err.httpStatus === "number" ? { httpStatus: err.httpStatus } : {}),
      ...(err.operationOutcome !== undefined
        ? {
            operationOutcome: {
              commitment: await commitFhirValue(
                err.operationOutcome,
                commitOptions(context),
              ),
            },
          }
        : {}),
      reason: err.reason ?? classifyReason(err.httpStatus),
    };
    return context.run.event(
      FHIR_EVENT_KINDS.error,
      { value: payload, mode: "embedded", embed: true },
      recordOptions,
    );
  };

  return {
    commitResponse: commit,
    commitError: error,
  };
}

function classifyReason(status: number | undefined): FhirErrorPayload["reason"] {
  if (status === undefined) return "unknown";
  if (status >= 400 && status < 500) return "http-4xx";
  if (status >= 500 && status < 600) return "http-5xx";
  return "unknown";
}
