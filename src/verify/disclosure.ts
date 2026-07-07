import { SPEC_NAME, SPEC_VERSION } from "../core/constants.js";
import { classifyEventType, reservedNamespaceOf } from "../core/extensions.js";
import { bytesEqual, decodeBase64Url } from "../core/encoding.js";
import { headerLeafBytes } from "../core/header.js";
import { resolveHash } from "../core/hash.js";
import { leafHash, verifyInclusionProof } from "../core/merkle.js";
import { ReceiptError } from "../errors.js";
import type { DisclosurePackage } from "../disclosure/disclose.js";
import { signaturePayloadBytes } from "../signing/signer.js";
import {
  importVerificationKey,
  type VerificationKey,
} from "../signing/webcrypto.js";
import { parseDisclosure } from "./parse.js";
import { checkEvent } from "./receipt.js";
import type {
  DisclosureVerificationReport,
  EventFailure,
  SignatureStatus,
  VerificationWarning,
} from "./report.js";

export interface VerifyDisclosureOptions {
  keys?: VerificationKey[];
}

/**
 * Rebuilds every claim the disclosure package makes from disclosed content
 * plus the pinned root. Never trusts the package's own root field for
 * anything the header does not commit — the header's `eventCount` is what
 * pins tree size against truncation.
 */
export async function verifyDisclosure(
  input: DisclosurePackage | string | Uint8Array,
  options: VerifyDisclosureOptions = {},
): Promise<DisclosureVerificationReport> {
  const pkg = parseDisclosure(input, "verifyDisclosure");
  const warnings: VerificationWarning[] = [];
  const failures: EventFailure[] = [];

  const rootAlgorithm = pkg.disclosure.root.algorithm;
  const hash = resolveHash(rootAlgorithm, "verifyDisclosure");
  const receiptId = pkg.disclosure.receiptId;
  const claimedRoot = decodeBase64Url(pkg.disclosure.root.digest);

  // 1. Header leaf must recompute and its own proof must verify against
  //    the claimed root. This is the only claim that has to happen first
  //    because everything else uses `eventCount`.
  let headerVerified = false;
  let eventCount = 0;
  try {
    const headerBytes = headerLeafBytes(pkg.header.value);
    headerVerified = await verifyInclusionProof(
      headerBytes,
      pkg.header.proof,
      claimedRoot,
      receiptId,
      hash,
    );
    if (pkg.header.value.receiptId !== receiptId) {
      headerVerified = false;
    }
    if (pkg.header.value.hashAlgorithm !== rootAlgorithm) {
      headerVerified = false;
    }
    eventCount = pkg.header.value.eventCount;
  } catch {
    headerVerified = false;
  }

  // 2. Each disclosed event must self-verify AND its inclusion proof must
  //    thread the same claimed root at its declared sequence.
  let rootVerified = headerVerified;
  for (let i = 0; i < pkg.events.length; i += 1) {
    const disclosed = pkg.events[i];
    if (disclosed === undefined) continue;
    const envelope = disclosed.envelope;

    if (envelope.sequence < 0 || envelope.sequence >= eventCount) {
      failures.push({
        index: envelope.sequence,
        eventId: envelope.id,
        reason: "sequence outside header-declared range",
      });
      rootVerified = false;
      continue;
    }

    const reason = await checkEvent(envelope);
    if (reason !== null) {
      failures.push({ index: envelope.sequence, eventId: envelope.id, reason });
      rootVerified = false;
      continue;
    }

    // The proof must claim the leafIndex the envelope claims to occupy.
    if (disclosed.proof.leafIndex !== envelope.sequence + 1) {
      failures.push({
        index: envelope.sequence,
        eventId: envelope.id,
        reason: "inclusion proof leafIndex does not match sequence",
      });
      rootVerified = false;
      continue;
    }

    let inclusionOk = false;
    try {
      const content = decodeBase64Url(envelope.commitment.digest);
      inclusionOk = await verifyInclusionProof(
        content,
        disclosed.proof,
        claimedRoot,
        receiptId,
        hash,
      );
    } catch {
      inclusionOk = false;
    }
    if (!inclusionOk) {
      failures.push({
        index: envelope.sequence,
        eventId: envelope.id,
        reason: "inclusion proof does not thread the claimed root",
      });
      rootVerified = false;
    }
  }

  // 3. Optional completeness check: if the disclosure lists every leaf,
  //    a verifier can rebuild the same root leaf-by-leaf.
  let complete: boolean | "unknown" = "unknown";
  let cryptographicallyConsistent = true;
  if (pkg.leaves !== undefined) {
    if (pkg.leaves.length !== eventCount + 1) {
      complete = false;
      cryptographicallyConsistent = false;
      warnings.push({
        code: "LEAVES_COUNT_MISMATCH",
        message: `disclosure lists ${pkg.leaves.length} leaves; header declared ${eventCount + 1}`,
      });
    } else {
      try {
        const leafBytes = pkg.leaves.map((leaf) => decodeBase64Url(leaf));
        const headerLeafFromList = leafBytes[0];
        const recomputedHeaderLeaf = headerLeafBytes(pkg.header.value);
        if (
          headerLeafFromList === undefined ||
          !bytesEqual(headerLeafFromList, recomputedHeaderLeaf)
        ) {
          complete = false;
          cryptographicallyConsistent = false;
        } else {
          // Rebuild the tree from listed leaves and compare digests.
          const { merkleRoot } = await import("../core/merkle.js");
          const rebuilt = await merkleRoot(leafBytes, receiptId, hash, "verifyDisclosure");
          const listedMatchesClaimed = bytesEqual(rebuilt, claimedRoot);
          if (!listedMatchesClaimed) {
            cryptographicallyConsistent = false;
          }

          // Every disclosed envelope's committed digest must equal the
          // leaf at its (sequence + 1) position — otherwise the leaves
          // list is lying about which digests belong at which positions.
          let allMatch = listedMatchesClaimed;
          for (const disclosed of pkg.events) {
            const listedLeaf = leafBytes[disclosed.envelope.sequence + 1];
            const commitmentBytes = decodeBase64Url(
              disclosed.envelope.commitment.digest,
            );
            if (
              listedLeaf === undefined ||
              !bytesEqual(listedLeaf, commitmentBytes)
            ) {
              allMatch = false;
              break;
            }
          }
          complete = allMatch && listedMatchesClaimed;
          if (!complete) cryptographicallyConsistent = false;
        }
      } catch {
        complete = false;
        cryptographicallyConsistent = false;
      }
    }
  }

  // 4. Signatures — bind to the SAME root the disclosure declares.
  const keyIndex = new Map<string, VerificationKey>();
  for (const key of options.keys ?? []) keyIndex.set(key.keyId, key);
  const signatures: Array<{
    keyId: string;
    algorithm: string;
    status: SignatureStatus;
  }> = [];
  for (const record of pkg.signatures) {
    // Signatures do not carry a duplicate `root` field — the root is
    // bound into the signed bytes via signaturePayloadBytes. Recomputing
    // those bytes with the disclosure's root is the binding check: if
    // the signature endorsed a different root, verify() fails naturally.
    let key = keyIndex.get(record.keyId);
    let selfAttested = false;
    if (key === undefined && record.publicKeyJwk !== undefined) {
      try {
        const imported = await importVerificationKey(record.publicKeyJwk);
        if (imported.keyId === record.keyId) {
          key = imported;
          selfAttested = true;
        }
      } catch {
        key = undefined;
      }
    }
    let status: SignatureStatus;
    if (key === undefined) {
      status = "no-key-provided";
      warnings.push({
        code: "NO_KEY_PROVIDED",
        message: `no trusted key supplied for ${record.keyId}`,
      });
    } else {
      const payload = signaturePayloadBytes({
        receiptId,
        root: pkg.disclosure.root,
        algorithm: record.algorithm,
        keyId: record.keyId,
        signedAt: record.signedAt,
      });
      let valid = false;
      try {
        valid =
          key.algorithm === record.algorithm &&
          (await key.verify(payload, decodeBase64Url(record.signature)));
      } catch {
        valid = false;
      }
      status = valid ? (selfAttested ? "self-attested" : "verified") : "failed";
      if (status === "self-attested") {
        warnings.push({
          code: "SELF_ATTESTED_KEY",
          message: `signature ${record.keyId} verified against a key embedded in the receipt — it proves possession, not identity`,
        });
      }
    }
    signatures.push({ keyId: record.keyId, algorithm: record.algorithm, status });
  }

  // 5. Timeline notes only — recorder-asserted claims.
  const notes: string[] = ["All timestamps are recorder-asserted claims."];
  let internallyConsistent = true;
  let previousRecordedAt = "";
  for (const disclosed of pkg.events) {
    const event = disclosed.envelope;
    if (event.recordedAt < previousRecordedAt) {
      internallyConsistent = false;
      notes.push(`recordedAt regresses at sequence ${event.sequence}`);
    }
    previousRecordedAt = event.recordedAt;
    if (event.occurredAt !== undefined && event.occurredAt > event.recordedAt) {
      internallyConsistent = false;
      notes.push(`occurredAt is after recordedAt at sequence ${event.sequence}`);
    }
  }
  if (!internallyConsistent) {
    warnings.push({
      code: "TIMELINE_INCONSISTENT",
      message: "recorder-asserted timestamps are internally inconsistent within the disclosed subset",
    });
  }
  warnings.push({
    code: "NO_EXTERNAL_TIMESTAMP",
    message: "disclosure has no externally trusted timestamp",
  });

  // Truncation guard: even a valid subset can be misleading.
  if (pkg.events.length < eventCount) {
    warnings.push({
      code: "PARTIAL_DISCLOSURE",
      message: `disclosure reveals ${pkg.events.length} of ${eventCount} committed events`,
    });
  }

  // Bucket the extension namespaces present in the disclosed subset.
  const understood = new Set<string>();
  const unknown = new Set<string>();
  for (const disclosed of pkg.events) {
    const kind = disclosed.envelope.type;
    if (classifyEventType(kind) === "core") continue;
    const namespace = reservedNamespaceOf(kind);
    if (namespace !== null) {
      understood.add(namespace);
    } else {
      const anchor = kind.includes(":")
        ? kind.split(":")[0] ?? kind
        : kind.split(".").slice(0, 2).join(".");
      unknown.add(anchor);
    }
  }

  const anySignatureFailed = signatures.some((s) => s.status === "failed");
  const ok = rootVerified && failures.length === 0 && !anySignatureFailed;

  return {
    ok,
    specification: { name: SPEC_NAME, version: SPEC_VERSION },
    integrity: {
      root: rootVerified ? "verified" : "failed",
      events: {
        total: pkg.events.length,
        verified: pkg.events.length - failures.length,
        failed: failures,
      },
    },
    signatures,
    disclosures: {
      applicable: true,
      complete,
      cryptographicallyConsistent,
    },
    timeline: {
      internallyConsistent,
      externallyTimestamped: false,
      notes,
    },
    reproducibility: {
      deterministic: "not-evaluated",
      nondeterministic: "not-claimed",
    },
    extensions: {
      understood: Array.from(understood).sort(),
      unknown: Array.from(unknown).sort(),
    },
    warnings,
    disclosedEvents: pkg.events.length,
  };
}

// re-exported for callers who want direct proof verification (CLI, etc.)
export { verifyInclusionProof, leafHash };
