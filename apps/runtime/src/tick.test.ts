import { PRESETS } from "@agents/core";
import { LlmClient } from "@agents/llm";
import { MemorySink, Tracer } from "@agents/trace";
import { describe, expect, it } from "vitest";
import { applyAction } from "./actions.js";
import { SimChain } from "./chain.js";
import { tick } from "./tick.js";
import { World, type Agent } from "./world.js";

const E = 10n ** 18n;
const mk = (handle: string, owner: string): Agent => ({
  account: `0x${handle}`, owner, handle, name: handle, persona: "test", modelId: "m/x",
  plan: PRESETS.momentum, awake: true, external: false, createdAt: 0,
});

function llmReturning(obj: unknown) {
  const fetch = (async () => new Response(JSON.stringify({ model: "m/x", choices: [{ message: { role: "assistant", content: JSON.stringify(obj) } }], usage: { prompt_tokens: 1, completion_tokens: 1, cost: 0.001 } }))) as unknown as typeof globalThis.fetch;
  return fetch;
}

describe("agent tick", () => {
  it("launches, posts, and a different owner's agent buys within bounds; traces it", async () => {
    const world = new World();
    const chain = new SimChain();
    const sink = new MemorySink();
    const tracer = new Tracer([sink]);
    const a = mk("alpha", "0xO1"), b = mk("beta", "0xO2"), c = mk("gamma", "0xO1");
    for (const x of [a, b, c]) { world.agents.set(x.account, x); world.balances.set(x.account, 1n * E); }

    await tick(world, a, { tracer, chain, quoter: chain, llm: new LlmClient({ apiKey: "k", tracer, fetch: llmReturning({ thought: "launch", actions: [{ type: "launch", name: "Relay", symbol: "RELAY", pitch: "Relay pays whoever routes the first outside bid." }] }) }) });
    const token = [...world.coins.keys()][0]!;
    expect(world.coins.get(token)?.symbol).toBe("RELAY");

    const r = await tick(world, b, { tracer, chain, quoter: chain, llm: new LlmClient({ apiKey: "k", tracer, fetch: llmReturning({ thought: "buy", actions: [{ type: "buy", token, ethIn: (1n * E).toString(), reason: "early" }] }) }) });
    expect(r.results[0]?.ok).toBe(true);
    expect(r.results[0]?.detail).toMatch(/size clipped/);
    expect(world.balances.get(b.account)! < 1n * E).toBe(true);

    // Same owner as launcher: refused by anti-wash rule.
    const own = await applyAction(world, chain, chain, c, { type: "buy", token, ethIn: (E / 100n).toString(), reason: "pump own coin" });
    expect(own).toMatchObject({ ok: false, detail: "risk: own fleet's coin (anti-wash)" });

    // Ticker spam refused.
    const spam = await applyAction(world, chain, chain, b, { type: "launch", name: "x", symbol: "RELAY2", pitch: "" });
    expect(spam.ok).toBe(false);

    expect(sink.all().some((s) => s.kind === "tx" && s.attrs.ok === true)).toBe(true);
    expect(world.decisions).toHaveLength(2);
  });
});
