import type { ClinicalReceipt } from "./receipt.js";
import type { EventEnvelope } from "../core/event.js";

/**
 * Storage boundary. The core never assumes a backend; adapters
 * (filesystem, PostgreSQL, object storage) implement this interface.
 * Finalized receipts are write-once: `finalize` must reject overwrites.
 */
export interface ReceiptStore {
  append(receiptId: string, event: EventEnvelope): Promise<void>;
  finalize(receipt: ClinicalReceipt): Promise<void>;
  get(id: string): Promise<ClinicalReceipt | null>;
}

export class MemoryReceiptStore implements ReceiptStore {
  private readonly pending = new Map<string, EventEnvelope[]>();
  private readonly finalized = new Map<string, ClinicalReceipt>();

  append(receiptId: string, event: EventEnvelope): Promise<void> {
    const events = this.pending.get(receiptId) ?? [];
    events.push(event);
    this.pending.set(receiptId, events);
    return Promise.resolve();
  }

  finalize(receipt: ClinicalReceipt): Promise<void> {
    if (this.finalized.has(receipt.receipt.id)) {
      return Promise.reject(
        new Error(`receipt ${receipt.receipt.id} is already finalized`),
      );
    }
    this.finalized.set(receipt.receipt.id, receipt);
    this.pending.delete(receipt.receipt.id);
    return Promise.resolve();
  }

  get(id: string): Promise<ClinicalReceipt | null> {
    return Promise.resolve(this.finalized.get(id) ?? null);
  }
}
