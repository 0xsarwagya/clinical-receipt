import { ReceiptError } from "../errors.js";
import type { ReceiptRun } from "../recorder/receipt.js";
import { fhirExtension, type FhirOperationInput } from "./operation.js";
import type { FhirServer } from "./schemas.js";
import type { PrivacyPolicy } from "./privacy.js";

export interface InstrumentFetchOptions {
  run: ReceiptRun;
  /** Absolute base URL of the FHIR server — everything else is passed through untouched. */
  baseUrl: string;
  /**
   * Server descriptor. Defaults to `{ id: baseUrl }` if not provided —
   * ergonomic, but callers with more than one FHIR store SHOULD supply
   * a stable id independent of the URL.
   */
  server?: FhirServer;
  privacy?: PrivacyPolicy;
}

interface RequestPlan {
  method: FhirOperationInput["method"];
  path: string;
  query: Record<string, string>;
  bodyPromise: Promise<unknown>;
}

/** Recover the origin + baseUrl path prefix so we know when a URL is "ours". */
function parseBase(baseUrl: string): { origin: string; pathPrefix: string } {
  const parsed = new URL(baseUrl);
  const pathPrefix = parsed.pathname.replace(/\/+$/, "");
  return { origin: parsed.origin, pathPrefix };
}

function urlMatchesBase(url: URL, base: ReturnType<typeof parseBase>): boolean {
  if (url.origin !== base.origin) return false;
  if (!url.pathname.startsWith(base.pathPrefix)) return false;
  const rest = url.pathname.slice(base.pathPrefix.length);
  return rest === "" || rest.startsWith("/");
}

function extractPath(url: URL, base: ReturnType<typeof parseBase>): string {
  const rest = url.pathname.slice(base.pathPrefix.length);
  return rest === "" ? "/" : rest;
}

async function planRequest(
  request: Request,
  base: ReturnType<typeof parseBase>,
): Promise<RequestPlan | null> {
  let url: URL;
  try {
    url = new URL(request.url);
  } catch {
    return null;
  }
  if (!urlMatchesBase(url, base)) return null;
  const method = request.method.toUpperCase() as FhirOperationInput["method"];
  if (
    method !== "GET" &&
    method !== "POST" &&
    method !== "PUT" &&
    method !== "PATCH" &&
    method !== "DELETE"
  ) {
    return null;
  }
  const path = extractPath(url, base);
  const query: Record<string, string> = {};
  url.searchParams.forEach((value, name) => {
    const existing = query[name];
    query[name] = existing === undefined ? value : `${existing},${value}`;
  });
  const bodyPromise =
    method === "GET" || method === "DELETE"
      ? Promise.resolve<unknown>(undefined)
      : readJsonBody(request.clone());
  return { method, path, query, bodyPromise };
}

async function readJsonBody(request: Request): Promise<unknown> {
  try {
    const text = await request.text();
    if (text === "") return undefined;
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

async function readJsonResponse(response: Response): Promise<unknown> {
  try {
    const text = await response.text();
    if (text === "") return undefined;
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

interface HeaderCollector {
  headers: Iterable<[string, string]>;
}

/**
 * Wrap a native `fetch` so requests to the configured FHIR base URL are
 * recorded into the receipt. Requests to any other origin pass through
 * untouched — this is not a generic HTTP recorder.
 *
 * The wrapper reads the response body into JSON exactly once and returns
 * a fresh Response to the caller with the same JSON serialized back; the
 * caller's stream is never partially consumed.
 */
export function instrumentFHIRFetch(
  fetchImpl: typeof fetch,
  options: InstrumentFetchOptions,
): typeof fetch {
  if (typeof fetchImpl !== "function") {
    throw new ReceiptError({
      code: "INVALID_ARGUMENT",
      message: "fetchImpl must be a function",
      operation: "fhirFetch",
    });
  }
  const base = parseBase(options.baseUrl);
  const server: FhirServer = options.server ?? { id: options.baseUrl };
  const handle = fhirExtension(options.run, {
    server,
    ...(options.privacy !== undefined ? { privacy: options.privacy } : {}),
  });

  const wrapped: typeof fetch = async (input, init) => {
    // Normalize to a Request for consistent access to method/url/body.
    const request =
      input instanceof Request
        ? new Request(input, init)
        : new Request(input as string | URL, init);
    const plan = await planRequest(request, base);
    if (plan === null) {
      // Non-FHIR request — pass through untouched.
      return fetchImpl(input, init);
    }
    const submittedBody = await plan.bodyPromise;
    const response = await fetchImpl(input, init);
    const responseBody = await readJsonResponse(response.clone());
    const headers = collectHeaders(response.headers);
    const operationInput: FhirOperationInput = {
      method: plan.method,
      baseUrl: options.baseUrl,
      path: plan.path,
      query: plan.query,
      body: submittedBody,
      server,
    };
    if (options.privacy !== undefined) operationInput.privacy = options.privacy;
    const op = handle.operation(operationInput);
    if (response.status >= 400) {
      await op.commitError({
        httpStatus: response.status,
        ...(isOperationOutcome(responseBody)
          ? { operationOutcome: responseBody }
          : {}),
      });
    } else {
      await op.commitResponse({
        status: response.status,
        body: responseBody,
        headers,
      });
    }
    // Reconstruct a fresh Response so the caller can consume the body.
    const clonedInit: ResponseInit = {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    };
    if (responseBody === undefined) {
      return new Response(null, clonedInit);
    }
    return new Response(JSON.stringify(responseBody), clonedInit);
  };
  return wrapped;
}

function collectHeaders(source: Headers): HeaderCollector["headers"] {
  const entries: Array<[string, string]> = [];
  source.forEach((value, name) => {
    entries.push([name, value]);
  });
  return entries;
}

function isOperationOutcome(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { resourceType?: unknown }).resourceType === "OperationOutcome"
  );
}
