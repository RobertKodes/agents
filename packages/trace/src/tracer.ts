import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import type { SpanKind, SpanRecord, SpanSink, SpanStatus, TokenUsage } from "./types.js";

export interface StartSpanOptions {
  parent?: Span | null;
  attrs?: Record<string, unknown>;
  input?: unknown;
}

export interface TracerOptions {
  now?: () => number;
  newId?: () => string;
  onSinkError?: (err: unknown, sink: SpanSink) => void;
}

export class Span {
  readonly record: SpanRecord;
  #ended = false;

  constructor(
    record: SpanRecord,
    private readonly tracer: Tracer,
    private readonly parent: Span | null,
  ) {
    this.record = record;
  }

  get id(): string {
    return this.record.id;
  }

  get ended(): boolean {
    return this.#ended;
  }

  setAttrs(attrs: Record<string, unknown>): this {
    Object.assign(this.record.attrs, attrs);
    return this;
  }

  setOutput(output: unknown): this {
    this.record.output = output;
    return this;
  }

  addCost(usd: number): this {
    this.record.costUsd += usd;
    this.record.totalCostUsd += usd;
    return this;
  }

  addTokens(tokens: Partial<TokenUsage>): this {
    this.record.tokens.prompt += tokens.prompt ?? 0;
    this.record.tokens.completion += tokens.completion ?? 0;
    return this;
  }

  fail(err: unknown): void {
    this.record.error = err instanceof Error ? err.message : String(err);
    this.end("error");
  }

  end(status: Exclude<SpanStatus, "running"> = "ok"): void {
    if (this.#ended) return;
    this.#ended = true;
    this.record.status = status;
    this.record.endedAt = this.tracer.now();
    if (this.parent) {
      this.parent.record.totalCostUsd += this.record.totalCostUsd;
      this.parent.record.tokens.prompt += this.record.tokens.prompt;
      this.parent.record.tokens.completion += this.record.tokens.completion;
    }
    this.tracer.emit("onEnd", this.record);
  }
}

export class Tracer {
  readonly now: () => number;
  readonly #newId: () => string;
  readonly #onSinkError: (err: unknown, sink: SpanSink) => void;
  readonly #context = new AsyncLocalStorage<Span>();

  constructor(
    private readonly sinks: SpanSink[] = [],
    opts: TracerOptions = {},
  ) {
    this.now = opts.now ?? Date.now;
    this.#newId = opts.newId ?? randomUUID;
    this.#onSinkError =
      opts.onSinkError ?? ((err) => console.error("[trace] sink failed", err));
  }

  /** The span active in the current async context, if any. */
  current(): Span | undefined {
    return this.#context.getStore();
  }

  startSpan(name: string, kind: SpanKind, opts: StartSpanOptions = {}): Span {
    const parent = opts.parent === undefined ? (this.current() ?? null) : opts.parent;
    const id = this.#newId();
    const record: SpanRecord = {
      id,
      traceId: parent ? parent.record.traceId : id,
      parentId: parent ? parent.id : null,
      kind,
      name,
      startedAt: this.now(),
      endedAt: null,
      status: "running",
      attrs: { ...opts.attrs },
      input: opts.input,
      costUsd: 0,
      totalCostUsd: 0,
      tokens: { prompt: 0, completion: 0 },
    };
    const span = new Span(record, this, parent);
    this.emit("onStart", record);
    return span;
  }

  /**
   * Runs `fn` inside a new span that is the active parent for any spans started
   * within it. The span ends with "ok" when `fn` resolves and "error" when it throws.
   */
  async withSpan<T>(
    name: string,
    kind: SpanKind,
    fn: (span: Span) => Promise<T> | T,
    opts: StartSpanOptions = {},
  ): Promise<T> {
    const span = this.startSpan(name, kind, opts);
    return this.#context.run(span, async () => {
      try {
        const result = await fn(span);
        span.end("ok");
        return result;
      } catch (err) {
        span.fail(err);
        throw err;
      }
    });
  }

  /** @internal */
  emit(event: "onStart" | "onEnd", record: SpanRecord): void {
    const snapshot = structuredClone(record);
    for (const sink of this.sinks) {
      const handler = sink[event];
      if (!handler) continue;
      try {
        const res = handler.call(sink, snapshot);
        if (res instanceof Promise) res.catch((err) => this.#onSinkError(err, sink));
      } catch (err) {
        this.#onSinkError(err, sink);
      }
    }
  }
}
