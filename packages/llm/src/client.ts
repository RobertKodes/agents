import type { Tracer } from "@agents/trace";
import type { ChatMessage, ChatRequest, ChatResult, ModelPrice, ModelSwap } from "./types.js";

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";

export class LlmError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
    readonly model: string,
    /** True when the provider declined the request; the caller may fall back. */
    readonly refused: boolean,
  ) {
    super(message);
    this.name = "LlmError";
  }
}

export interface LlmClientOptions {
  apiKey: string;
  fetch?: typeof fetch;
  tracer?: Tracer;
  /** Used when the provider response has no cost figure. */
  prices?: Record<string, ModelPrice>;
  maxRetries?: number;
  retryBaseMs?: number;
  /** Called whenever a call is served by a different model than requested. */
  onSwap?: (swap: ModelSwap) => void;
  appName?: string;
  appUrl?: string;
}

interface OpenRouterResponse {
  model?: string;
  provider?: string;
  choices?: { message?: ChatMessage; finish_reason?: string | null }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number; cost?: number };
  error?: { message?: string; code?: number };
}

/** Matches provider-dated or suffixed ids, e.g. "vendor/model" served as "vendor/model-20261001". */
export function sameModel(requested: string, served: string): boolean {
  return served === requested || served.startsWith(`${requested}-`) || served.startsWith(`${requested}:`);
}

export class LlmClient {
  readonly #opts: Required<Pick<LlmClientOptions, "maxRetries" | "retryBaseMs">> & LlmClientOptions;
  readonly #fetch: typeof fetch;

  constructor(opts: LlmClientOptions) {
    this.#opts = { maxRetries: 2, retryBaseMs: 500, ...opts };
    this.#fetch = opts.fetch ?? fetch;
  }

  /**
   * One chat completion. Tries the locked model first; a refusal moves to the next
   * fallback, and the result says so — a swap is never silent.
   */
  async chat(req: ChatRequest): Promise<ChatResult> {
    const candidates = [req.model, ...(req.fallbackModels ?? [])];
    let lastRefusal: LlmError | null = null;

    for (const model of candidates) {
      try {
        const result = await this.#traced(req, model);
        const swapReason =
          model !== req.model
            ? `refused: ${lastRefusal?.message ?? "unknown"}`
            : !sameModel(req.model, result.servedModel)
              ? "provider routed to a different model"
              : null;
        if (swapReason) {
          result.swap = { requested: req.model, served: result.servedModel, reason: swapReason };
          this.#opts.onSwap?.(result.swap);
        }
        return result;
      } catch (err) {
        if (err instanceof LlmError && err.refused) {
          lastRefusal = err;
          continue;
        }
        throw err;
      }
    }
    throw lastRefusal ?? new LlmError("no model available", null, req.model, true);
  }

  async #traced(req: ChatRequest, model: string): Promise<ChatResult> {
    const tracer = this.#opts.tracer;
    if (!tracer) return this.#call(req, model);

    return tracer.withSpan(
      `llm ${model}`,
      "llm_call",
      async (span) => {
        const result = await this.#call(req, model);
        span
          .addCost(result.costUsd)
          .addTokens(result.usage)
          .setAttrs({
            servedModel: result.servedModel,
            provider: result.provider,
            finishReason: result.finishReason,
            latencyMs: result.latencyMs,
            attempts: result.attempts,
            costSource: result.costSource,
            swapped: !sameModel(req.model, result.servedModel),
          })
          .setOutput(result.message);
        return result;
      },
      {
        attrs: { requestedModel: req.model, attemptedModel: model },
        input: { messages: req.messages, tools: req.tools?.map((t) => t.function.name) },
      },
    );
  }

  async #call(req: ChatRequest, model: string): Promise<ChatResult> {
    const body = {
      model,
      messages: req.messages,
      tools: req.tools,
      temperature: req.temperature,
      max_tokens: req.maxTokens,
      usage: { include: true },
    };

    const started = Date.now();
    let attempts = 0;
    for (;;) {
      attempts++;
      const res = await this.#fetch(OPENROUTER_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.#opts.apiKey}`,
          "Content-Type": "application/json",
          ...(this.#opts.appUrl ? { "HTTP-Referer": this.#opts.appUrl } : {}),
          ...(this.#opts.appName ? { "X-Title": this.#opts.appName } : {}),
        },
        body: JSON.stringify(body),
      });

      const retryable = res.status === 429 || res.status >= 500;
      if (retryable && attempts <= this.#opts.maxRetries) {
        await sleep(this.#opts.retryBaseMs * 2 ** (attempts - 1));
        continue;
      }

      const json = (await res.json().catch(() => ({}))) as OpenRouterResponse;
      if (!res.ok || json.error) {
        const message = json.error?.message ?? `HTTP ${res.status}`;
        // 400/403 from the provider layer are policy or capability refusals; 401/402 are our account.
        const refused = res.status === 403 || (res.status === 400 && /declin|refus|moderat|policy/i.test(message));
        throw new LlmError(message, res.status, model, refused);
      }

      const choice = json.choices?.[0];
      if (!choice?.message) throw new LlmError("empty completion", res.status, model, true);

      const usage = {
        prompt: json.usage?.prompt_tokens ?? 0,
        completion: json.usage?.completion_tokens ?? 0,
      };
      const servedModel = json.model ?? model;
      const { costUsd, costSource } = this.#cost(json, servedModel, usage);

      return {
        message: choice.message,
        finishReason: choice.finish_reason ?? null,
        requestedModel: req.model,
        servedModel,
        provider: json.provider ?? null,
        usage,
        costUsd,
        costSource,
        latencyMs: Date.now() - started,
        attempts,
        swap: null,
      };
    }
  }

  #cost(
    json: OpenRouterResponse,
    servedModel: string,
    usage: { prompt: number; completion: number },
  ): Pick<ChatResult, "costUsd" | "costSource"> {
    if (typeof json.usage?.cost === "number") return { costUsd: json.usage.cost, costSource: "provider" };
    const price =
      this.#opts.prices?.[servedModel] ??
      Object.entries(this.#opts.prices ?? {}).find(([id]) => sameModel(id, servedModel))?.[1];
    if (price) {
      return {
        costUsd: usage.prompt * price.prompt + usage.completion * price.completion,
        costSource: "price_table",
      };
    }
    return { costUsd: 0, costSource: "unknown" };
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
