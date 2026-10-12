import type { SpanRecord, SpanSink } from "./types.js";

/** Keeps the latest state of every span. Used in tests and for local dev. */
export class MemorySink implements SpanSink {
  readonly spans = new Map<string, SpanRecord>();

  onStart(span: Readonly<SpanRecord>): void {
    this.spans.set(span.id, { ...span });
  }

  onEnd(span: Readonly<SpanRecord>): void {
    this.spans.set(span.id, { ...span });
  }

  all(): SpanRecord[] {
    return [...this.spans.values()];
  }
}

/** Anything with a `publish(channel, message)` method, e.g. an ioredis client. */
export interface Publisher {
  publish(channel: string, message: string): unknown;
}

/**
 * Streams span events for the live views. Channel per trace so a coin page
 * subscribes only to its own runs.
 */
export class PublishSink implements SpanSink {
  constructor(
    private readonly publisher: Publisher,
    private readonly channelFor: (span: Readonly<SpanRecord>) => string = (s) =>
      `trace:${s.traceId}`,
  ) {}

  onStart(span: Readonly<SpanRecord>): void {
    this.#send("start", span);
  }

  onEnd(span: Readonly<SpanRecord>): void {
    this.#send("end", span);
  }

  #send(event: "start" | "end", span: Readonly<SpanRecord>): void {
    void this.publisher.publish(this.channelFor(span), JSON.stringify({ event, span }));
  }
}
