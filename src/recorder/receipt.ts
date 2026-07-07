import { ReceiptError } from "../errors.js";
import { canonicalize } from "../core/canonicalize.js";
import { commitPayload, type Commitment } from "../core/commitment.js";
import {
  HASH_SHA256,
  PAYLOAD_SALT_BYTES,
  RECEIPT_ID_PATTERN,
  SPEC_NAME,
  SPEC_VERSION,
  TREE_STRUCTURE,
  isCoreEventType,
  isExtensionEventType,
} from "../core/constants.js";
import { assertExtensionEventShape } from "../core/extensions.js";
import {
  bytesToHex,
  decodeBase64Url,
  encodeBase64Url,
} from "../core/encoding.js";
import {
  committedEventForm,
  deriveEventIdentity,
  type Actor,
  type EventEnvelope,
  type PayloadDescriptor,
  type PayloadMode,
  type PayloadRef,
} from "../core/event.js";
import { buildHeader, headerLeafBytes } from "../core/header.js";
import { resolveHash, type HashAlgorithm } from "../core/hash.js";
import { merkleRoot } from "../core/merkle.js";
import type { ReceiptSigner, SignatureRecord } from "../signing/signer.js";
import { createSignatureRecord } from "../signing/signer.js";
import type {
  EvidenceQueriedPayload,
  EvidenceRetrievedPayload,
  GuardrailEvaluatedPayload,
  HumanReviewCompletedPayload,
  HumanReviewRequestedPayload,
  InputObservedPayload,
  ModelRequestedPayload,
  ModelRespondedPayload,
  OutputPayload,
  PromptRenderedPayload,
  PromptTemplateSelectedPayload,
  ToolRequestedPayload,
  ToolRespondedPayload,
} from "./payloads.js";

export interface Workflow {
  id: string;
  version: string;
}

export interface ClinicalReceipt {
  specification: { name: string; version: string };
  receipt: { id: string; createdAt: string; finalizedAt: string };
  workflow: Workflow;
  subject?: { commitment: Commitment };
  supersedes?: string;
  events: EventEnvelope[];
  commitments: {
    tree: string;
    leafCount: number;
    root: { algorithm: string; structure: string; digest: string };
  };
  signatures: SignatureRecord[];
  disclosures?: Array<{ id: string; createdAt: string; eventIds: string[] }>;
}

/** What callers pass when recording a payload. */
export interface PayloadInput {
  /** The content. JSON by default; Uint8Array with canonicalization bytes@1. */
  value?: unknown;
  /** Canonicalization profile. Defaults: bytes@1 for Uint8Array, jcs@1 otherwise. */
  canonicalization?: string;
  mediaType?: string;
  /** Recording mode. DEFAULT: "commitment" — clinical data is never embedded silently. */
  mode?: PayloadMode;
  /** Explicit opt-in gate for embedding. Required when mode is "embedded". */
  embed?: boolean;
  /** Reference-mode target. */
  ref?: PayloadRef;
  /** Precomputed commitment when the content itself is unavailable. */
  digest?: Commitment;
  /** Override the default random 16-byte salt; null = unsalted (vectors only). */
  salt?: Uint8Array<ArrayBuffer> | null;
}

export interface RecordOptions {
  /** Causal parents. Defaults to the previously recorded event. */
  parents?: string[];
  occurredAt?: string;
  actor?: Actor;
}

export interface RecordedEvent {
  id: string;
  sequence: number;
  commitment: Commitment;
}

export interface CreateReceiptOptions {
  workflow: Workflow;
  subject?: PayloadInput;
  supersedes?: string;
  /** Injectables — the deterministic test surface. */
  id?: string;
  clock?: () => Date;
  random?: (byteLength: number) => Uint8Array<ArrayBuffer>;
  hash?: HashAlgorithm;
}

export interface FinalizeOptions {
  signer?: ReceiptSigner;
  signers?: ReceiptSigner[];
}

type Recorder = (
  payload: PayloadInput,
  options?: RecordOptions,
) => Promise<RecordedEvent>;

export interface ReceiptRun {
  readonly id: string;
  readonly input: { observed: Recorder; transformed: Recorder };
  readonly evidence: { queried: Recorder; retrieved: Recorder };
  readonly prompt: { templateSelected: Recorder; rendered: Recorder };
  readonly model: { requested: Recorder; responded: Recorder };
  readonly tool: { requested: Recorder; responded: Recorder };
  readonly guardrail: { evaluated: Recorder };
  readonly humanReview: { requested: Recorder; completed: Recorder };
  readonly output: { proposed: Recorder; modified: Recorder; committed: Recorder };
  /** Extension events — type must be an absolute URI. */
  event(type: string, payload: PayloadInput, options?: RecordOptions): Promise<RecordedEvent>;
  finalize(options?: FinalizeOptions): Promise<ClinicalReceipt>;
}

function defaultRandom(byteLength: number): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(byteLength);
  globalThis.crypto.getRandomValues(bytes);
  return bytes;
}

function timestamp(clock: () => Date): string {
  return clock().toISOString();
}

export async function createReceipt(
  options: CreateReceiptOptions,
): Promise<ReceiptRun> {
  if (
    typeof options?.workflow?.id !== "string" ||
    options.workflow.id.length === 0 ||
    typeof options.workflow.version !== "string" ||
    options.workflow.version.length === 0
  ) {
    throw new ReceiptError({
      code: "INVALID_ARGUMENT",
      message: "workflow.id and workflow.version are required",
      operation: "record",
    });
  }
  const clock = options.clock ?? (() => new Date());
  const random = options.random ?? defaultRandom;
  const hash = options.hash ?? resolveHash(HASH_SHA256, "record");
  const receiptId = options.id ?? `rcpt_1_${bytesToHex(random(16))}`;
  if (!RECEIPT_ID_PATTERN.test(receiptId)) {
    throw new ReceiptError({
      code: "INVALID_ARGUMENT",
      message: "receipt id must match rcpt_1_<32 hex>",
      operation: "record",
    });
  }
  if (
    options.supersedes !== undefined &&
    !RECEIPT_ID_PATTERN.test(options.supersedes)
  ) {
    throw new ReceiptError({
      code: "INVALID_ARGUMENT",
      message: "supersedes must be a well-formed receipt id",
      operation: "record",
    });
  }

  const createdAt = timestamp(clock);
  const events: EventEnvelope[] = [];
  const eventIds = new Set<string>();
  let finalized = false;

  const subjectCommitment =
    options.subject !== undefined
      ? (await buildDescriptor(options.subject, random, hash, true)).descriptor
          .commitment
      : undefined;

  async function record(
    type: string,
    input: PayloadInput,
    recordOptions: RecordOptions = {},
  ): Promise<RecordedEvent> {
    if (finalized) {
      throw new ReceiptError({
        code: "RECEIPT_FINALIZED",
        message: "this receipt is finalized; corrections create a new receipt with supersedes",
        operation: "record",
      });
    }
    const sequence = events.length;
    const isStart = type === "run.started";
    let parents: string[];
    if (recordOptions.parents !== undefined) {
      parents = [...new Set(recordOptions.parents)].sort();
      for (const parent of parents) {
        if (!eventIds.has(parent)) {
          throw new ReceiptError({
            code: "UNKNOWN_PARENT",
            message: `parent event ${parent} has not been recorded in this receipt`,
            operation: "record",
          });
        }
      }
      if (parents.length === 0 && !isStart) {
        throw new ReceiptError({
          code: "INVALID_ARGUMENT",
          message: "every event after run.started needs at least one parent",
          operation: "record",
        });
      }
    } else if (isStart) {
      parents = [];
    } else {
      const previous = events[events.length - 1];
      if (previous === undefined) {
        throw new ReceiptError({
          code: "INVALID_ARGUMENT",
          message: "no previous event to default the parent to",
          operation: "record",
        });
      }
      parents = [previous.id];
    }

    const { descriptor } = await buildDescriptor(input, random, hash, false);
    const committedFields: Parameters<typeof committedEventForm>[0] = {
      type,
      sequence,
      recordedAt: timestamp(clock),
      parentIds: parents,
      payload: {
        commitment: descriptor.commitment,
        ...(descriptor.mediaType !== undefined
          ? { mediaType: descriptor.mediaType }
          : {}),
        ...(descriptor.ref !== undefined ? { ref: descriptor.ref } : {}),
      },
      ...(recordOptions.occurredAt !== undefined
        ? { occurredAt: recordOptions.occurredAt }
        : {}),
      ...(recordOptions.actor !== undefined ? { actor: recordOptions.actor } : {}),
    };
    const identity = await deriveEventIdentity(
      committedEventForm(committedFields),
      hash,
    );
    const envelope: EventEnvelope = {
      id: identity.id,
      type,
      sequence,
      ...(recordOptions.occurredAt !== undefined
        ? { occurredAt: recordOptions.occurredAt }
        : {}),
      recordedAt: committedFields.recordedAt,
      ...(recordOptions.actor !== undefined ? { actor: recordOptions.actor } : {}),
      parentIds: parents,
      payload: descriptor,
      commitment: identity.commitment,
    };
    events.push(envelope);
    eventIds.add(identity.id);
    return { id: identity.id, sequence, commitment: identity.commitment };
  }

  const typed =
    (type: string): Recorder =>
    (payload, recordOptions) =>
      record(type, payload, recordOptions);

  await record("run.started", {
    value: { workflow: { id: options.workflow.id, version: options.workflow.version } },
    mode: "embedded",
    embed: true,
  });

  return {
    id: receiptId,
    input: {
      observed: typed("input.observed"),
      transformed: typed("input.transformed"),
    },
    evidence: {
      queried: typed("evidence.queried"),
      retrieved: typed("evidence.retrieved"),
    },
    prompt: {
      templateSelected: typed("prompt.template.selected"),
      rendered: typed("prompt.rendered"),
    },
    model: {
      requested: typed("model.requested"),
      responded: typed("model.responded"),
    },
    tool: {
      requested: typed("tool.requested"),
      responded: typed("tool.responded"),
    },
    guardrail: { evaluated: typed("guardrail.evaluated") },
    humanReview: {
      requested: typed("human.review.requested"),
      completed: typed("human.review.completed"),
    },
    output: {
      proposed: typed("output.proposed"),
      modified: typed("output.modified"),
      committed: typed("output.committed"),
    },
    async event(type, payload, recordOptions) {
      if (isCoreEventType(type)) {
        throw new ReceiptError({
          code: "INVALID_ARGUMENT",
          message: "core event types are recorded through their typed builders",
          operation: "record",
        });
      }
      if (!isExtensionEventType(type)) {
        throw new ReceiptError({
          code: "INVALID_ARGUMENT",
          message:
            "extension event types must be an absolute URI or a reverse-DNS name with 3+ segments",
          operation: "record",
        });
      }
      // Reserved-namespace payloads are validated eagerly so an ill-shaped
      // event never enters the DAG. Non-reserved namespaces are trusted.
      assertExtensionEventShape(type, payload?.value, "record");
      return record(type, payload, recordOptions);
    },
    async finalize(finalizeOptions: FinalizeOptions = {}): Promise<ClinicalReceipt> {
      if (finalized) {
        throw new ReceiptError({
          code: "RECEIPT_FINALIZED",
          message: "this receipt is already finalized",
          operation: "finalize",
        });
      }
      await record("run.finalized", {
        value: { eventCount: events.length + 1 },
        mode: "embedded",
        embed: true,
      });
      finalized = true;

      const finalizedAt = timestamp(clock);
      const header = buildHeader({
        receiptId,
        createdAt,
        finalizedAt,
        workflow: options.workflow,
        ...(subjectCommitment !== undefined
          ? { subject: { commitment: subjectCommitment } }
          : {}),
        ...(options.supersedes !== undefined
          ? { supersedes: options.supersedes }
          : {}),
        hashAlgorithm: hash.id,
        eventCount: events.length,
      });
      const leaves: Uint8Array<ArrayBuffer>[] = [
        headerLeafBytes(header),
        ...events.map((event) => decodeBase64Url(event.commitment.digest)),
      ];
      const root = await merkleRoot(leaves, receiptId, hash, "finalize");
      const receipt: ClinicalReceipt = {
        specification: { name: SPEC_NAME, version: SPEC_VERSION },
        receipt: { id: receiptId, createdAt, finalizedAt },
        workflow: { id: options.workflow.id, version: options.workflow.version },
        ...(subjectCommitment !== undefined
          ? { subject: { commitment: subjectCommitment } }
          : {}),
        ...(options.supersedes !== undefined
          ? { supersedes: options.supersedes }
          : {}),
        events: [...events],
        commitments: {
          tree: TREE_STRUCTURE,
          leafCount: leaves.length,
          root: {
            algorithm: hash.id,
            structure: TREE_STRUCTURE,
            digest: encodeBase64Url(root),
          },
        },
        signatures: [],
      };

      const signers = [
        ...(finalizeOptions.signer ? [finalizeOptions.signer] : []),
        ...(finalizeOptions.signers ?? []),
      ];
      for (const signer of signers) {
        receipt.signatures.push(
          await createSignatureRecord(receipt, signer, timestamp(clock)),
        );
      }
      return receipt;
    },
  };
}

async function buildDescriptor(
  input: PayloadInput,
  random: (n: number) => Uint8Array<ArrayBuffer>,
  hash: HashAlgorithm,
  forSubject: boolean,
): Promise<{ descriptor: PayloadDescriptor }> {
  const mode: PayloadMode = input.mode ?? "commitment";
  if (mode === "embedded") {
    if (input.embed !== true) {
      throw new ReceiptError({
        code: "EMBED_NOT_ALLOWED",
        message:
          "embedding requires explicit opt-in ({ mode: \"embedded\", embed: true }) — clinical data is never embedded silently",
        operation: "record",
      });
    }
    if (forSubject) {
      throw new ReceiptError({
        code: "EMBED_NOT_ALLOWED",
        message: "the subject is commitment-mode only in specification 1.0",
        operation: "record",
      });
    }
  }
  if (mode === "reference" && (input.ref?.uri ?? "") === "") {
    throw new ReceiptError({
      code: "INVALID_ARGUMENT",
      message: "reference mode requires ref.uri",
      operation: "record",
    });
  }

  // Precomputed commitment — content unavailable to the recorder.
  if (input.value === undefined) {
    if (input.digest === undefined) {
      throw new ReceiptError({
        code: "PAYLOAD_NOT_COMMITTABLE",
        message:
          "a payload needs content or a precomputed commitment — nothing to commit",
        operation: "record",
      });
    }
    if (mode === "embedded") {
      throw new ReceiptError({
        code: "INVALID_ARGUMENT",
        message: "embedded mode requires the content itself",
        operation: "record",
      });
    }
    return {
      descriptor: {
        mode,
        commitment: input.digest,
        ...(input.mediaType !== undefined ? { mediaType: input.mediaType } : {}),
        ...(mode === "reference" && input.ref !== undefined ? { ref: input.ref } : {}),
      },
    };
  }

  const canonicalization =
    input.canonicalization ??
    (input.value instanceof Uint8Array ? "bytes@1" : "jcs@1");
  const canonicalBytes = canonicalize(canonicalization, input.value, "record");
  const salt =
    input.salt === null ? null : input.salt ?? random(PAYLOAD_SALT_BYTES);
  const commitment = await commitPayload(canonicalBytes, {
    canonicalization,
    salt,
    hash,
    operation: "record",
  });

  const descriptor: PayloadDescriptor = {
    mode,
    commitment,
    ...(input.mediaType !== undefined ? { mediaType: input.mediaType } : {}),
    ...(mode === "reference" && input.ref !== undefined ? { ref: input.ref } : {}),
  };
  if (mode === "embedded") {
    if (input.value instanceof Uint8Array) {
      descriptor.value = encodeBase64Url(input.value);
      descriptor.encoding = "base64url";
    } else {
      descriptor.value = input.value;
    }
    if (salt !== null) {
      descriptor.salt = encodeBase64Url(salt);
    }
  }
  return { descriptor };
}

export type {
  EvidenceQueriedPayload,
  EvidenceRetrievedPayload,
  GuardrailEvaluatedPayload,
  HumanReviewCompletedPayload,
  HumanReviewRequestedPayload,
  InputObservedPayload,
  ModelRequestedPayload,
  ModelRespondedPayload,
  OutputPayload,
  PromptRenderedPayload,
  PromptTemplateSelectedPayload,
  ToolRequestedPayload,
  ToolRespondedPayload,
};
