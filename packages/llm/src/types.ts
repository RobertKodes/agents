export type Role = "system" | "user" | "assistant" | "tool";

export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface ChatMessage {
  role: Role;
  content: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  name?: string;
}

export interface ToolDefinition {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface ChatRequest {
  /** The model locked for this agent. */
  model: string;
  messages: ChatMessage[];
  tools?: ToolDefinition[];
  temperature?: number;
  maxTokens?: number;
  /** Tried in order only when `model` is refused. Every swap is reported. */
  fallbackModels?: string[];
}

/** Per-token USD prices, as published in the OpenRouter catalog. */
export interface ModelPrice {
  prompt: number;
  completion: number;
}

export interface ModelSwap {
  requested: string;
  served: string;
  reason: string;
}

export interface ChatResult {
  message: ChatMessage;
  finishReason: string | null;
  requestedModel: string;
  /** The model id the provider reports it actually ran. */
  servedModel: string;
  provider: string | null;
  usage: { prompt: number; completion: number };
  costUsd: number;
  /** Where the cost figure came from: the provider's own accounting, or our price table. */
  costSource: "provider" | "price_table" | "unknown";
  latencyMs: number;
  attempts: number;
  /** Set when the call was not served by the requested model. */
  swap: ModelSwap | null;
}
