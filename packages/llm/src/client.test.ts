import { MemorySink, Tracer } from "@agents/trace";
import { describe, expect, it } from "vitest";
import { LlmClient, LlmError, sameModel } from "./client.js";
import type { ModelSwap } from "./types.js";

type Reply = { status: number; body: unknown };

function fakeFetch(replies: Reply[]) {
  const calls: { model: string }[] = [];
  const fn = (async (_url: string, init: RequestInit) => {
    calls.push(JSON.parse(String(init.body)));
    const r = replies.shift();
    if (!r) throw new Error("unexpected call");
    return new Response(JSON.stringify(r.body), { status: r.status });
  }) as unknown as typeof fetch;
  return { fn, calls };
}

const ok = (model: string, extra: Record<string, unknown> = {}): Reply => ({
  status: 200,
  body: {
    model,
    provider: "TestProvider",
    choices: [{ message: { role: "assistant", content: "hi" }, finish_reason: "stop" }],
    usage: { prompt_tokens: 1000, completion_tokens: 200, ...extra },
  },
});

describe("sameModel", () => {
  it("accepts dated and variant suffixes only", () => {
    expect(sameModel("a/m", "a/m")).toBe(true);
    expect(sameModel("a/m", "a/m-20261001")).toBe(true);
    expect(sameModel("a/m", "a/m:beta")).toBe(true);
    expect(sameModel("a/m", "b/other")).toBe(false);
  });
});

describe("LlmClient", () => {
  it("uses the provider's cost and reports no swap when served as requested", async () => {
    const { fn } = fakeFetch([ok("a/m-20261001", { cost: 0.0123 })]);
    const client = new LlmClient({ apiKey: "k", fetch: fn });
    const r = await client.chat({ model: "a/m", messages: [{ role: "user", content: "x" }] });
    expect(r.costUsd).toBe(0.0123);
    expect(r.costSource).toBe("provider");
    expect(r.swap).toBeNull();
  });

  it("falls back on refusal and discloses the swap", async () => {
    const swaps: ModelSwap[] = [];
    const { fn, calls } = fakeFetch([
      { status: 403, body: { error: { message: "Provider declined the request" } } },
      ok("b/cheap"),
    ]);
    const client = new LlmClient({
      apiKey: "k",
      fetch: fn,
      prices: { "b/cheap": { prompt: 1e-6, completion: 2e-6 } },
      onSwap: (s) => swaps.push(s),
    });
    const r = await client.chat({
      model: "a/frontier",
      fallbackModels: ["b/cheap"],
      messages: [{ role: "user", content: "x" }],
    });
    expect(calls.map((c) => c.model)).toEqual(["a/frontier", "b/cheap"]);
    expect(r.servedModel).toBe("b/cheap");
    expect(r.costUsd).toBeCloseTo(1000 * 1e-6 + 200 * 2e-6);
    expect(r.costSource).toBe("price_table");
    expect(r.swap?.reason).toMatch(/declined/);
    expect(swaps).toHaveLength(1);
  });

  it("flags a silent provider-side reroute", async () => {
    const { fn } = fakeFetch([ok("c/flash")]);
    const client = new LlmClient({ apiKey: "k", fetch: fn });
    const r = await client.chat({ model: "a/frontier", messages: [] });
    expect(r.swap).toEqual({
      requested: "a/frontier",
      served: "c/flash",
      reason: "provider routed to a different model",
    });
  });

  it("retries 429 then succeeds", async () => {
    const { fn } = fakeFetch([{ status: 429, body: {} }, ok("a/m")]);
    const client = new LlmClient({ apiKey: "k", fetch: fn, retryBaseMs: 1 });
    const r = await client.chat({ model: "a/m", messages: [] });
    expect(r.attempts).toBe(2);
  });

  it("does not fall back on account errors", async () => {
    const { fn } = fakeFetch([{ status: 402, body: { error: { message: "Insufficient credits" } } }]);
    const client = new LlmClient({ apiKey: "k", fetch: fn });
    await expect(
      client.chat({ model: "a/m", fallbackModels: ["b/x"], messages: [] }),
    ).rejects.toBeInstanceOf(LlmError);
  });

  it("records an llm_call span with cost, tokens and served model", async () => {
    const sink = new MemorySink();
    const tracer = new Tracer([sink]);
    const { fn } = fakeFetch([ok("a/m", { cost: 0.5 })]);
    const client = new LlmClient({ apiKey: "k", fetch: fn, tracer });
    await tracer.withSpan("turn", "turn", () =>
      client.chat({ model: "a/m", messages: [{ role: "user", content: "x" }] }),
    );
    const llm = sink.all().find((s) => s.kind === "llm_call");
    expect(llm?.attrs).toMatchObject({ requestedModel: "a/m", servedModel: "a/m", swapped: false });
    expect(llm?.costUsd).toBe(0.5);
    const turn = sink.all().find((s) => s.kind === "turn");
    expect(turn?.totalCostUsd).toBe(0.5);
    expect(turn?.tokens).toEqual({ prompt: 1000, completion: 200 });
  });
});
