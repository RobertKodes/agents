export type SpanKind =
  | "run"
  | "turn"
  | "llm_call"
  | "tool_call"
  | "experiment"
  | "tx"
  | "custom";

export type SpanStatus = "running" | "ok" | "error";

export interface TokenUsage {
  prompt: number;
  completion: number;
}

export interface SpanRecord {
  id: string;
  traceId: string;
  parentId: string | null;
  kind: SpanKind;
  name: string;
  startedAt: number;
  endedAt: number | null;
  status: SpanStatus;
  attrs: Record<string, unknown>;
  input?: unknown;
  output?: unknown;
  error?: string;
  /** Cost incurred by this span itself, in USD. */
  costUsd: number;
  /** Cost of this span plus every descendant that has ended. */
  totalCostUsd: number;
  /** Tokens used by this span plus every descendant that has ended. */
  tokens: TokenUsage;
}

/**
 * Receives span lifecycle events. Sinks persist (Postgres), stream (Redis) or
 * export (OTLP). A failing sink must never break the agent loop, so the tracer
 * isolates sink errors.
 */
export interface SpanSink {
  onStart?(span: Readonly<SpanRecord>): void | Promise<void>;
  onEnd?(span: Readonly<SpanRecord>): void | Promise<void>;
}
