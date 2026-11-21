import { EventEmitter } from "node:events";
import type { DomainEvent } from "@manga/contracts";

export class SequencedBus extends EventEmitter {
  private seq = 0;
  private readonly buffer: DomainEvent[] = [];
  private readonly maxBuffer: number;

  constructor(maxBuffer = 2_000) {
    super();
    this.maxBuffer = Math.max(1, Math.trunc(maxBuffer));
  }

  nextSeq(): number {
    return this.seq + 1;
  }

  publish(type: string, payload: Record<string, unknown>, eventId: string, createdAt: string): DomainEvent {
    this.seq += 1;
    const event: DomainEvent = {
      eventId,
      seq: this.seq,
      type,
      payload,
      createdAt,
    };
    this.buffer.push(event);
    if (this.buffer.length > this.maxBuffer) {
      this.buffer.splice(0, this.buffer.length - this.maxBuffer);
    }
    this.emit("event", event);
    return event;
  }

  snapshotFrom(seq: number): DomainEvent[] {
    return this.buffer.filter((item) => item.seq > seq);
  }

  get lastSeq(): number {
    return this.seq;
  }
}
