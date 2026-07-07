import { ReceiptError } from "../errors.js";
import type { ReceiptRun } from "../recorder/receipt.js";
import { instrumentFHIRFetch } from "./fetch.js";
import type { PrivacyPolicy } from "./privacy.js";
import type { FhirServer } from "./schemas.js";

/**
 * Minimal contract we need from an underlying FHIR client. Any client
 * with a stable `baseUrl` and a fetch-like `fetch`/`http` method matches
 * — `fhirclient`, `medplum`, and hand-rolled clients over the platform
 * `fetch` all conform.
 */
export interface FhirClientLike {
  baseUrl: string;
  /**
   * The client's HTTP boundary. Must accept the same shape as the global
   * `fetch` (URL string OR Request, plus init). The instrumenter never
   * calls this directly — it wraps it and asks the underlying client to
   * use the wrapped version. If a client uses a private HTTP method the
   * instrumenter cannot substitute, the adapter MUST throw
   * `PARTIAL_INSTRUMENTATION_UNSAFE`.
   */
  fetch: typeof fetch;
}

/**
 * How the instrumenter substitutes its wrapped fetch into a client. The
 * default adapter (`fetchAdapter`) replaces `client.fetch` in place; more
 * exotic clients may need per-library adapters that we ship as separate
 * exports over time.
 */
export interface FhirClientAdapter<TClient extends FhirClientLike> {
  install(client: TClient, wrapped: typeof fetch): TClient;
}

export const fetchAdapter: FhirClientAdapter<FhirClientLike> = {
  install(client, wrapped) {
    if (typeof client.fetch !== "function") {
      throw new ReceiptError({
        code: "PARTIAL_INSTRUMENTATION_UNSAFE",
        message:
          "client does not expose a fetch method — supply an explicit adapter",
        operation: "fhirClient",
      });
    }
    // Replace in place so subsequent operations flow through us; return
    // the same client instance so callers keep their references.
    (client as { fetch: typeof fetch }).fetch = wrapped;
    return client;
  },
};

export interface InstrumentFhirOptions<TClient extends FhirClientLike> {
  run: ReceiptRun;
  client: TClient;
  adapter?: FhirClientAdapter<TClient>;
  server?: FhirServer;
  privacy?: PrivacyPolicy;
  /**
   * Optional random source for FHIR resource commitment salts. See
   * {@link FhirExtensionOptions.random} — same semantics.
   */
  random?: (byteLength: number) => Uint8Array<ArrayBuffer>;
}

/**
 * Level-1 friendly wrapper. Installs the instrumented fetch into the
 * client and returns the same client, now recording FHIR operations.
 *
 * If the client's shape cannot be confidently instrumented for every
 * operation (missing fetch, exotic HTTP method, transport not covered
 * by the adapter), the adapter MUST throw so the caller never ends up
 * with a partially-instrumented client that silently drops events.
 */
export function instrumentFHIR<TClient extends FhirClientLike>(
  options: InstrumentFhirOptions<TClient>,
): TClient {
  if (typeof options?.client?.baseUrl !== "string" || options.client.baseUrl.length === 0) {
    throw new ReceiptError({
      code: "INVALID_ARGUMENT",
      message: "client.baseUrl is required",
      operation: "fhirClient",
    });
  }
  if (options.adapter === undefined && typeof options.client.fetch !== "function") {
    // Default adapter can only instrument through the client's fetch
    // method. If it's missing, we cannot cover every operation — better
    // to refuse than silently instrument some paths and miss others.
    throw new ReceiptError({
      code: "PARTIAL_INSTRUMENTATION_UNSAFE",
      message:
        "client does not expose a fetch method — supply an explicit adapter",
      operation: "fhirClient",
    });
  }
  const adapter = options.adapter ?? (fetchAdapter as unknown as FhirClientAdapter<TClient>);
  const wrappedInit: {
    run: ReceiptRun;
    baseUrl: string;
    server?: FhirServer;
    privacy?: PrivacyPolicy;
    random?: (byteLength: number) => Uint8Array<ArrayBuffer>;
  } = { run: options.run, baseUrl: options.client.baseUrl };
  if (options.server !== undefined) wrappedInit.server = options.server;
  if (options.privacy !== undefined) wrappedInit.privacy = options.privacy;
  if (options.random !== undefined) wrappedInit.random = options.random;
  const wrapped = instrumentFHIRFetch(options.client.fetch, wrappedInit);
  return adapter.install(options.client, wrapped);
}
