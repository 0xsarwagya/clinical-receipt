import type { ClinicalReceipt } from "../recorder/receipt.js";
import { FHIR_EVENT_KINDS, isFhirEventKind } from "./constants.js";
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

export interface FhirReadEntry {
  eventId: string;
  operation: "read" | "vread";
  server: FhirServer;
  resource: FhirResourceRef;
}

export interface FhirSearchEntry {
  eventId: string;
  server: FhirServer;
  resourceType: string;
  resources: FhirResourceRef[];
  pagination: FhirSearchPayload["pagination"];
  total?: number;
  sort?: string;
}

export interface FhirWriteEntry {
  eventId: string;
  operation: FhirResourceWritePayload["operation"];
  server: FhirServer;
  target: FhirResourceWritePayload["target"];
  persisted?: FhirResourceRef;
}

export interface FhirTransactionEntry {
  eventId: string;
  server: FhirServer;
  operation: "transaction" | "batch";
  entryCount: number;
}

export interface FhirErrorEntry {
  eventId: string;
  server: FhirServer;
  target: FhirErrorPayload["target"];
  reason: FhirErrorPayload["reason"];
  httpStatus?: number;
}

export interface FhirLineageEdge {
  parent: string;
  child: string;
}

export interface FhirTrace {
  servers: FhirServer[];
  reads: FhirReadEntry[];
  searches: FhirSearchEntry[];
  writes: FhirWriteEntry[];
  transactions: FhirTransactionEntry[];
  errors: FhirErrorEntry[];
  lineage: FhirLineageEdge[];
}

/**
 * Pure projection of a receipt's FHIR events. This is not a canonical
 * representation — it exists to feed a CLI and downstream tooling, not
 * to be signed or committed. The projection can be reshaped without
 * touching the protocol.
 */
export function inspectFHIR(receipt: ClinicalReceipt): FhirTrace {
  const trace: FhirTrace = {
    servers: [],
    reads: [],
    searches: [],
    writes: [],
    transactions: [],
    errors: [],
    lineage: [],
  };
  const seenServers = new Set<string>();
  const fhirEventIds = new Set<string>();

  for (const event of receipt.events) {
    if (!isFhirEventKind(event.type)) continue;
    // FHIR events always carry their payload embedded — recorder API
    // requires `embed: true` for the extension record path.
    const embedded = event.payload;
    if (embedded.mode !== "embedded") continue;
    const value = embedded.value as { server?: FhirServer };
    if (value?.server?.id !== undefined && !seenServers.has(value.server.id)) {
      seenServers.add(value.server.id);
      trace.servers.push(value.server);
    }
    fhirEventIds.add(event.id);
    projectEvent(event.id, event.type, value, trace);
  }

  // Lineage edges — parent → child within the FHIR subgraph.
  for (const event of receipt.events) {
    if (!fhirEventIds.has(event.id)) continue;
    for (const parent of event.parentIds) {
      if (fhirEventIds.has(parent)) {
        trace.lineage.push({ parent, child: event.id });
      }
    }
  }
  return trace;
}

function projectEvent(
  eventId: string,
  kind: string,
  value: unknown,
  trace: FhirTrace,
): void {
  const server = (value as { server?: FhirServer }).server ?? { id: "unknown" };
  switch (kind) {
    case FHIR_EVENT_KINDS.resourceRead: {
      const payload = value as FhirResourceReadPayload;
      trace.reads.push({
        eventId,
        operation: "read",
        server,
        resource: payload.resource,
      });
      return;
    }
    case FHIR_EVENT_KINDS.resourceVersionedRead: {
      const payload = value as FhirResourceVersionedReadPayload;
      trace.reads.push({
        eventId,
        operation: "vread",
        server,
        resource: payload.resource,
      });
      return;
    }
    case FHIR_EVENT_KINDS.search: {
      const payload = value as FhirSearchPayload;
      trace.searches.push({
        eventId,
        server,
        resourceType: payload.resourceType,
        resources: payload.bundle.resources,
        pagination: payload.pagination,
        ...(payload.total !== undefined ? { total: payload.total } : {}),
        ...(payload.sort !== undefined ? { sort: payload.sort } : {}),
      });
      return;
    }
    case FHIR_EVENT_KINDS.resourceWrite: {
      const payload = value as FhirResourceWritePayload;
      trace.writes.push({
        eventId,
        operation: payload.operation,
        server,
        target: payload.target,
        ...(payload.persisted !== undefined
          ? { persisted: payload.persisted.resource }
          : {}),
      });
      return;
    }
    case FHIR_EVENT_KINDS.transaction: {
      const payload = value as FhirTransactionPayload;
      trace.transactions.push({
        eventId,
        server,
        operation: payload.operation,
        entryCount: payload.submitted.entryCount,
      });
      return;
    }
    case FHIR_EVENT_KINDS.error: {
      const payload = value as FhirErrorPayload;
      trace.errors.push({
        eventId,
        server,
        target: payload.target,
        reason: payload.reason,
        ...(payload.httpStatus !== undefined ? { httpStatus: payload.httpStatus } : {}),
      });
      return;
    }
  }
}
