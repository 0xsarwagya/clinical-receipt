import type { Commitment } from "../core/commitment.js";

/**
 * Recommended payload shapes for the core event types. These are
 * recommendations for interoperability, not integrity requirements —
 * integrity applies to whatever bytes were committed. All shapes are
 * JSON-compatible by construction.
 */

export interface RunStartedPayload {
  workflow: { id: string; version: string };
}

export interface RunFinalizedPayload {
  eventCount: number;
}

export interface InputObservedPayload {
  name?: string;
  source?: { system?: string; uri?: string; version?: string };
  [key: string]: unknown;
}

export interface EvidenceQueriedPayload {
  query?: unknown;
  system?: { id: string; version?: string };
  filters?: unknown;
  topK?: number;
  [key: string]: unknown;
}

export interface EvidenceRetrievedPayload {
  source?: { id?: string; uri?: string; version?: string };
  rank?: number;
  score?: number;
  [key: string]: unknown;
}

export interface PromptTemplateSelectedPayload {
  template: { id: string; version: string };
  [key: string]: unknown;
}

export interface PromptRenderedPayload {
  template?: { id: string; version: string };
  [key: string]: unknown;
}

export interface ModelRequestedPayload {
  provider?: string;
  model?: string;
  operation?: string;
  configuration?: {
    temperature?: number;
    topP?: number;
    seed?: number;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export interface ModelRespondedPayload {
  provider?: string;
  model?: string;
  providerRequestId?: string;
  usage?: { inputTokens?: number; outputTokens?: number };
  latencyMs?: number;
  terminationReason?: string;
  [key: string]: unknown;
}

export interface ToolRequestedPayload {
  name: string;
  version?: string;
  [key: string]: unknown;
}

export interface ToolRespondedPayload {
  name: string;
  version?: string;
  outcome?: "success" | "failure";
  [key: string]: unknown;
}

export interface GuardrailEvaluatedPayload {
  policy: { id: string; version: string };
  result: "passed" | "failed" | "warned" | "overridden" | "not-executed";
  override?: { actorId: string; reason?: string; authority?: string };
  [key: string]: unknown;
}

export interface HumanReviewRequestedPayload {
  reviewer?: { type: string; reference: string };
  [key: string]: unknown;
}

export interface HumanReviewCompletedPayload {
  reviewer: { type: string; reference: string };
  action:
    | "approved"
    | "rejected"
    | "modified-and-approved"
    | "escalated"
    | "abstained";
  reason?: { code?: string; display?: string };
  [key: string]: unknown;
}

export interface OutputPayload {
  [key: string]: unknown;
}

export type { Commitment };
