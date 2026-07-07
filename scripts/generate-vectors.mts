// TEMPORARY-ish — regenerate spec vectors from the real implementation.
// Run: `pnpm tsx scripts/generate-vectors.mts` — pins land in
// spec/1.0/vectors/*.json. Files are committed as part of the spec; any
// diff is a protocol break, not a rewrite.
//
// Vectors are pinned in the DECODE direction for signatures (WebKit hedges
// Ed25519, ECDSA is randomized) and byte-exact everywhere else.

import { writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { jcsSerialize } from "../src/core/jcs.js";
import { canonicalize } from "../src/core/canonicalize.js";
import { commitPayload } from "../src/core/commitment.js";
import { sha256 } from "../src/core/hash.js";
import {
  bytesToHex,
  decodeBase64Url,
  encodeBase64Url,
  hexToBytes,
} from "../src/core/encoding.js";
import { merkleRoot, proveInclusion } from "../src/core/merkle.js";
import { buildHeader, headerLeafBytes } from "../src/core/header.js";
import { signaturePayloadBytes, deriveKeyId } from "../src/signing/signer.js";
import { createReceipt } from "../src/recorder/receipt.js";
import { createEd25519Signer } from "../src/signing/webcrypto.js";
import { disclose } from "../src/disclosure/disclose.js";
import { fixedClock, fixedRandom } from "../tests/fixtures.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const OUT = path.resolve(__dirname, "..", "spec", "1.0", "vectors");
mkdirSync(OUT, { recursive: true });

function write(name: string, value: unknown) {
  writeFileSync(
    path.join(OUT, name),
    JSON.stringify(value, null, 2) + "\n",
    "utf8",
  );
}

// ── JCS bytes vector ──────────────────────────────────────────────────
const jcsInput = {
  b: 2,
  a: 1,
  nested: { z: [true, false, null], y: "hi" },
};
write("jcs.json", {
  description:
    "RFC 8785 JCS: recursive member sort. Input value is committed exactly by the serialization on the right.",
  input: jcsInput,
  bytesUtf8: jcsSerialize(jcsInput),
  bytesHex: bytesToHex(new TextEncoder().encode(jcsSerialize(jcsInput)) as Uint8Array<ArrayBuffer>),
});

// ── Commitment vector ─────────────────────────────────────────────────
const bytes = canonicalize("jcs@1", { code: "I50.9", system: "ICD-10" });
const saltHex = "0123456789abcdef0123456789abcdef";
const commitment = await commitPayload(bytes, {
  canonicalization: "jcs@1",
  salt: hexToBytes(saltHex),
  hash: sha256,
  operation: "commit",
});
write("commitment.json", {
  description:
    "SHA-256(f(tag)||f(alg)||f(canon)||f(salt)||f(canonicalBytes)). Fields are length-prefixed with uint32BE.",
  input: { code: "I50.9", system: "ICD-10" },
  canonicalization: "jcs@1",
  saltHex,
  commitment,
});

// ── Merkle tree + inclusion proofs ────────────────────────────────────
const receiptIdForTree = `rcpt_1_${"0".repeat(32)}`;
const leafBytes = Array.from({ length: 5 }, (_, i) => {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, i + 1);
  return b as Uint8Array<ArrayBuffer>;
});
const rootBytes = await merkleRoot(leafBytes, receiptIdForTree, sha256, "verifyReceipt");
const treeProofs = [];
for (let i = 0; i < leafBytes.length; i += 1) {
  const proof = await proveInclusion(leafBytes, i, receiptIdForTree, sha256);
  treeProofs.push({
    leafIndex: i,
    leafBytesHex: bytesToHex(leafBytes[i]!),
    proof,
  });
}
write("tree.json", {
  description:
    "RFC 6962-style Merkle tree with receipt-scoped ctx. Split at largest power of two < n (no duplication).",
  receiptId: receiptIdForTree,
  leafCount: leafBytes.length,
  rootBytes: encodeBase64Url(rootBytes),
  proofs: treeProofs,
});

// ── Header leaf ───────────────────────────────────────────────────────
const header = buildHeader({
  receiptId: receiptIdForTree,
  createdAt: "2026-07-07T10:00:00.000Z",
  finalizedAt: "2026-07-07T10:00:15.000Z",
  workflow: { id: "test-wf", version: "1.0.0" },
  hashAlgorithm: "sha-256",
  eventCount: 3,
});
const headerBytes = headerLeafBytes(header);
write("header.json", {
  description:
    "Header leaf: JCS of the frozen header object. eventCount pins tree size.",
  header,
  bytesBase64Url: encodeBase64Url(headerBytes),
  bytesHex: bytesToHex(headerBytes),
});

// ── receipt-minimal (deterministic full run through the recorder) ────
const minimalRun = await createReceipt({
  workflow: { id: "minimal", version: "1.0.0" },
  id: `rcpt_1_${"a".repeat(32)}`,
  clock: fixedClock(Date.UTC(2026, 6, 7, 10, 0, 0, 0)),
  random: fixedRandom(),
});
await minimalRun.input.observed({
  value: { patient: "Patient/1" },
});
await minimalRun.model.responded({
  value: { text: "hello" },
});
await minimalRun.output.committed({ value: { text: "hello" } });
const minimalReceipt = await minimalRun.finalize({});
write("receipt-minimal.json", minimalReceipt);

// ── signature-ed25519 (pinned from a fixed PKCS#8 key) ────────────────
// RFC 8032 §7.1 TEST 1 seed wrapped in the standard PKCS#8 prefix.
const RFC_SEED_HEX =
  "9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60";
const RFC_PUBLIC_HEX =
  "d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a";
const PKCS8_PREFIX_HEX = "302e020100300506032b657004220420";
const pkcs8 = hexToBytes(PKCS8_PREFIX_HEX + RFC_SEED_HEX);
const publicRaw = hexToBytes(RFC_PUBLIC_HEX);
const signer = await createEd25519Signer({
  pkcs8: pkcs8 as Uint8Array<ArrayBuffer>,
  publicKeyRaw: publicRaw as Uint8Array<ArrayBuffer>,
});
const keyId = await deriveKeyId(publicRaw as Uint8Array<ArrayBuffer>);
const sigPayload = signaturePayloadBytes({
  receiptId: minimalReceipt.receipt.id,
  root: minimalReceipt.commitments.root,
  algorithm: signer.algorithm,
  keyId,
  signedAt: "2026-07-07T10:00:30.000Z",
});
const signatureBytes = await signer.sign(sigPayload as Uint8Array<ArrayBuffer>);
write("signature-ed25519.json", {
  description:
    "Verify-direction only: import the JWK, verify the signature over the pinned payload. Ed25519 is deterministic on paper but WebKit hedges, so byte-identical signatures across engines are not guaranteed.",
  receiptId: minimalReceipt.receipt.id,
  root: minimalReceipt.commitments.root,
  algorithm: "ed25519",
  keyId,
  publicKeyJwk: signer.publicKeyJwk,
  signedAt: "2026-07-07T10:00:30.000Z",
  payloadBase64Url: encodeBase64Url(sigPayload),
  signatureBase64Url: encodeBase64Url(signatureBytes),
});

// ── disclosure-basic (a subset of receipt-minimal) ────────────────────
const pkg = await disclose(minimalReceipt, {
  events: ["output.*"],
  random: fixedRandom(),
  clock: () => new Date(Date.UTC(2026, 6, 7, 10, 0, 30, 0)),
});
write("disclosure-basic.json", pkg);

// ── FHIR vectors ──────────────────────────────────────────────────────
// The FHIR extension registers its canonicalization alias + reserved
// namespace when its barrel is imported. `fhirExtension` is the
// entrypoint every level ultimately funnels through.
const { fhirExtension } = await import("../src/fhir/operation.js");
const { commitFhirValue } = await import("../src/fhir/commit.js");
const { FHIR_CANONICALIZATION } = await import("../src/fhir/constants.js");

const HAPI_BASE = "https://hapi.fhir.org/baseR4";
const HAPI_SERVER = { id: "hapi-r4-public" };

// A resource whose commitment we can compute unsalted so callers can
// recompute deterministically.
const FHIR_PATIENT = {
  resourceType: "Patient",
  id: "vector-1",
  meta: { versionId: "3", lastUpdated: "2026-07-07T10:00:00.000Z" },
  name: [{ family: "Vector", given: ["Alpha"] }],
};
const patientCommitment = await commitFhirValue(FHIR_PATIENT, { salt: null });
write("fhir-read-r4.json", {
  description:
    "commitFhirValue over a Patient resource, unsalted. Any implementation MUST reproduce the digest below when hashing the canonical bytes of the resource on the left.",
  canonicalization: FHIR_CANONICALIZATION,
  resource: FHIR_PATIENT,
  commitment: patientCommitment,
});

// Versioned-read: same resource, but the receipt event carries
// `versionPinned: true` and the resource.versionId matches _history/N.
const FHIR_PATIENT_V3 = FHIR_PATIENT;
const vreadRun = await createReceipt({
  workflow: { id: "fhir-vread-vector", version: "1.0.0" },
  id: `rcpt_1_${"b".repeat(32)}`,
  clock: fixedClock(Date.UTC(2026, 6, 7, 10, 0, 0, 0)),
  random: fixedRandom(),
});
await fhirExtension(vreadRun, { server: HAPI_SERVER })
  .operation({
    method: "GET",
    baseUrl: HAPI_BASE,
    path: `/Patient/${FHIR_PATIENT_V3.id}/_history/3`,
  })
  .commitResponse({ status: 200, body: FHIR_PATIENT_V3 });
const vreadReceipt = await vreadRun.finalize({});
write("fhir-versioned-read-r4.json", vreadReceipt);

// Search: a two-entry searchset. The pinned bundle commitment MUST
// recompute from an identical Bundle body.
const FHIR_SEARCHSET = {
  resourceType: "Bundle",
  type: "searchset",
  total: 2,
  link: [{ relation: "self", url: `${HAPI_BASE}/Observation?patient=vector-1` }],
  entry: [
    {
      fullUrl: `${HAPI_BASE}/Observation/o1`,
      resource: {
        resourceType: "Observation",
        id: "o1",
        meta: { versionId: "1", lastUpdated: "2026-07-07T09:00:00.000Z" },
        status: "final",
        code: { coding: [{ system: "http://loinc.org", code: "718-7" }] },
        subject: { reference: "Patient/vector-1" },
      },
      search: { mode: "match" },
    },
    {
      fullUrl: `${HAPI_BASE}/Observation/o2`,
      resource: {
        resourceType: "Observation",
        id: "o2",
        meta: { versionId: "1", lastUpdated: "2026-07-07T09:05:00.000Z" },
        status: "final",
        code: { coding: [{ system: "http://loinc.org", code: "1988-5" }] },
        subject: { reference: "Patient/vector-1" },
      },
      search: { mode: "match" },
    },
  ],
};
const searchsetCommitment = await commitFhirValue(FHIR_SEARCHSET, { salt: null });
write("fhir-search-r4.json", {
  description:
    "Bundle commitment over a searchset. Order-sensitive: reversing the entry array MUST change the digest.",
  canonicalization: FHIR_CANONICALIZATION,
  bundle: FHIR_SEARCHSET,
  commitment: searchsetCommitment,
});

// Create: the persisted resource carries the assigned version.
const CI_SUBMITTED = {
  resourceType: "ClinicalImpression",
  status: "completed",
  subject: { reference: "Patient/vector-1" },
  summary: "Consider urgent cardiology review.",
};
const CI_PERSISTED = {
  resourceType: "ClinicalImpression",
  id: "789",
  meta: { versionId: "1", lastUpdated: "2026-07-07T10:00:32.000Z" },
  status: "completed",
  subject: { reference: "Patient/vector-1" },
  summary: "Consider urgent cardiology review.",
};
write("fhir-create-r4.json", {
  description:
    "A create event: submitted commitment ≠ persisted commitment when the server assigns an id/versionId. Both are pinned below.",
  submitted: {
    resource: CI_SUBMITTED,
    commitment: await commitFhirValue(CI_SUBMITTED, { salt: null }),
  },
  persisted: {
    resource: CI_PERSISTED,
    commitment: await commitFhirValue(CI_PERSISTED, { salt: null }),
  },
});

// Transaction: request Bundle → response Bundle.
const TX_REQUEST = {
  resourceType: "Bundle",
  type: "transaction",
  entry: [
    {
      request: { method: "POST", url: "ClinicalImpression" },
      resource: CI_SUBMITTED,
    },
  ],
};
const TX_RESPONSE = {
  resourceType: "Bundle",
  type: "transaction-response",
  entry: [
    {
      response: {
        status: "201 Created",
        location: `${HAPI_BASE}/ClinicalImpression/789/_history/1`,
        etag: 'W/"1"',
      },
    },
  ],
};
write("fhir-transaction-r4.json", {
  description:
    "Request and response Bundles are committed separately; the pair proves what was submitted vs what the server returned.",
  submitted: {
    bundle: TX_REQUEST,
    commitment: await commitFhirValue(TX_REQUEST, { salt: null }),
  },
  response: {
    bundle: TX_RESPONSE,
    commitment: await commitFhirValue(TX_RESPONSE, { salt: null }),
  },
});

// Error: OperationOutcome commitment. The receipt event carries the
// short reason class + optional OperationOutcome commitment; both must
// be recomputable.
const OPERATION_OUTCOME = {
  resourceType: "OperationOutcome",
  issue: [
    {
      severity: "error",
      code: "not-found",
      diagnostics: "Patient/missing does not exist",
    },
  ],
};
write("fhir-error-r4.json", {
  description:
    "OperationOutcome commitment. The recorder maps HTTP 4xx → reason:'http-4xx' and hashes the outcome as normal FHIR JSON.",
  operationOutcome: OPERATION_OUTCOME,
  commitment: await commitFhirValue(OPERATION_OUTCOME, { salt: null }),
});

// Redacted query: proves privacy transforms produce a stable string
// representation that is committed byte-for-byte.
const REDACTED_RUN = await createReceipt({
  workflow: { id: "fhir-redact-vector", version: "1.0.0" },
  id: `rcpt_1_${"c".repeat(32)}`,
  clock: fixedClock(Date.UTC(2026, 6, 7, 10, 0, 0, 0)),
  random: fixedRandom(),
});
await fhirExtension(REDACTED_RUN, {
  server: HAPI_SERVER,
  privacy: { query: { patient: "hash", identifier: "redact" } },
})
  .operation({
    method: "GET",
    baseUrl: HAPI_BASE,
    path: "/Observation",
    query: { patient: "vector-1", identifier: "SSN-42" },
  })
  .commitResponse({ status: 200, body: FHIR_SEARCHSET });
const redactedReceipt = await REDACTED_RUN.finalize({});
write("fhir-redacted-query-r4.json", redactedReceipt);

console.log(`wrote vectors to ${OUT}`);
