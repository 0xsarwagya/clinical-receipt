/**
 * `@0xsarwagya/clinical-receipt/fhir` — first-party FHIR integration.
 *
 * This module ONLY exists at `dist/fhir.js`. Nothing in `dist/index.js`
 * imports anything from `src/fhir/*` — the boundary is one-way, and a
 * bundle-size regression test asserts that root imports load zero FHIR
 * code. See `tests/bundle-size.test.ts`.
 */

// Side effects: register the fhir-json-r4@1 canonicalization alias and
// the reserved namespace validator. Importing this barrel is enough.
import "./fhir/canonicalize.js";
import "./fhir/register.js";

export {
  FHIR_CANONICALIZATION,
  FHIR_EVENT_KINDS,
  FHIR_EXTENSION_VERSION,
  FHIR_NAMESPACE,
  FHIR_R4,
  isFhirEventKind,
} from "./fhir/constants.js";
export type { FhirEventKind } from "./fhir/constants.js";

export {
  commitFhirBundle,
  commitFhirResource,
  commitFhirValue,
} from "./fhir/commit.js";
export type { CommitFhirResourceOptions } from "./fhir/commit.js";

export { fhirExtension } from "./fhir/operation.js";
export type {
  FhirCommitErrorInput,
  FhirCommitResponseInput,
  FhirExtensionOptions,
  FhirNamespaceHandle,
  FhirOperation,
  FhirOperationInput,
} from "./fhir/operation.js";

export { instrumentFHIRFetch } from "./fhir/fetch.js";
export type { InstrumentFetchOptions } from "./fhir/fetch.js";

export {
  fetchAdapter,
  instrumentFHIR,
} from "./fhir/client.js";
export type {
  FhirClientAdapter,
  FhirClientLike,
  InstrumentFhirOptions,
} from "./fhir/client.js";

export { inspectFHIR } from "./fhir/inspect.js";
export type {
  FhirErrorEntry,
  FhirLineageEdge,
  FhirReadEntry,
  FhirSearchEntry,
  FhirTrace,
  FhirTransactionEntry,
  FhirWriteEntry,
} from "./fhir/inspect.js";

export type {
  AppliedPrivacy,
  PrivacyPolicy,
  QueryTransform,
  ResourceIdTransform,
} from "./fhir/privacy.js";

export type {
  FhirErrorPayload,
  FhirEventMeta,
  FhirEventPayload,
  FhirResourceReadPayload,
  FhirResourceRef,
  FhirResourceVersionedReadPayload,
  FhirResourceWritePayload,
  FhirSearchPayload,
  FhirServer,
  FhirTransactionPayload,
} from "./fhir/schemas.js";

export { verifyFHIR } from "./verify/fhir.js";
export type {
  FhirVerificationReport,
  VerifyFhirOptions,
  VerifyFhirResourceCheck,
} from "./verify/fhir.js";
