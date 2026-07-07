export type SignatureStatus =
  | "verified"
  | "failed"
  | "no-key-provided"
  | "self-attested";

export interface EventFailure {
  index: number;
  eventId: string;
  reason: string;
}

export interface VerificationWarning {
  code: string;
  message: string;
}

export interface VerificationReport {
  ok: boolean;
  specification: { name: string; version: string };
  integrity: {
    root: "verified" | "failed";
    events: { total: number; verified: number; failed: EventFailure[] };
  };
  signatures: Array<{
    keyId: string;
    algorithm: string;
    status: SignatureStatus;
  }>;
  disclosures: {
    applicable: boolean;
    complete: boolean | "unknown";
    cryptographicallyConsistent: boolean;
  };
  timeline: {
    internallyConsistent: boolean;
    externallyTimestamped: boolean;
    notes: string[];
  };
  reproducibility: {
    deterministic: "not-evaluated";
    nondeterministic: "not-claimed";
  };
  /**
   * Which extension namespaces this verifier understood semantically vs
   * simply verified for integrity. Unknown extensions are NEVER an
   * integrity failure — a namespace-aware verifier can layer richer
   * checks on top.
   */
  extensions: {
    understood: string[];
    unknown: string[];
  };
  warnings: VerificationWarning[];
}

export interface DisclosureVerificationReport extends VerificationReport {
  disclosedEvents: number;
}
