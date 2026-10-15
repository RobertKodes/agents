// Agents runtime: scheduler + public API + external-agent API.
// No OPENROUTER_API_KEY / RPC_URL => demo mode on SimChain with a scripted model.

import { createHash, randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { PRESETS, realizedPnl, type Style } from "@agents/core";
import { LlmClient } from "@agents/llm";
import { Tracer, buildTree, type SpanRecord, type SpanSink } from "@agents/trace";
import { createPublicClient, defineChain, http, type Address, type Hex } from "viem";
import { applyAction, type Action, type Quoter } from "./actions.js";
import { SimChain, ViemAgentChain, type Chain } from "./chain.js";
import { Indexer, PoolQuoter } from "./onchain.js";
import { tick } from "./tick.js";
import { World, type Agent } from "./world.js";

const env = process.env;
const PORT = Number(env.PORT ?? 4100);
const demo = !env.OPENROUTER_API_KEY;
const E = 10n ** 18n;

class Live implements SpanSink {
  spans = new Map<string, SpanRecord>();
  subs = new Set<(s: SpanRecord) => void>();
  onStart(s: Readonly<SpanRecord>) { this.put(s); }
  onEnd(s: Readonly<SpanRecord>) { this.put(s); }
  put(s: Readonly<SpanRecord>) { const c = { ...s }; this.spans.set(s.id, c); for (const f of this.subs) f(c); }
}

const live = new Live();
const tracer = new Tracer([live]);
const world = new World();
const onchain = !!(env.RPC_URL && env.SESSION_KEY && env.POOL_MANAGER && env.REGISTRY && env.HOOK);
let chain: Chain;
let quoter: Quoter;
let indexer: Indexer | null = null;
let poolQuoter: PoolQuoter | null = null;
if (onchain) {
  const net = defineChain({ id: Number(env.CHAIN_ID ?? 4663), name: env.CHAIN_NAME ?? "robinhood", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [env.RPC_URL!] } } });
  const pub = createPublicClient({ chain: net, transport: http(env.RPC_URL) });
  chain = new ViemAgentChain(env.RPC_URL!, net, env.SESSION_KEY as Hex, env.HOOK as Address);
  quoter = poolQuoter = new PoolQuoter(pub, env.POOL_MANAGER as Address, env.HOOK as Address);
  indexer = new Indexer(pub, env.REGISTRY as Address, env.HOOK as Address, world, BigInt(env.START_BLOCK ?? 0));
} else {
  const sim = new SimChain();
  chain = sim;
  quoter = sim;
}
const apiKeys = new Map<string, string>(); // sha256(key) -> agent account

// ---------------------------------------------------------------- demo LLM
const demoFetch = (() => {
  const lines = [
    "Nobody outside the fleet has touched {T} yet. I'll wait for a real bid before adding.",
    "{T} reserve is creeping up on small agent buys only; that is not demand, that is us.",
    "Rotating out of anything where I am the biggest holder. Liquidity matters more than conviction here.",
    "If {T} opens on time instead of on threshold, expect the first human bid to set the real price.",
    "Watching which launches attract buyers from different owners. That's the only signal I trust.",
  ];
  let i = 0;
  return (async (_u: string, init: RequestInit) => {
    const req = JSON.parse(String(init.body));
    const ctx: string = req.messages[1].content;
    const tokens = [...ctx.matchAll(/^(\w+) (0x\w+) launcher=(\w+) [^\n]*$/gm)].filter((m) => !m[0].includes("your fleet"));
    const me = /@(\w+)/.exec(req.messages[0].content)?.[1] ?? "x";
    const pick = tokens[(i + me.length) % Math.max(1, tokens.length)];
    const actions: Action[] = [];
    if (!tokens.length || i % 7 === 0) actions.push({ type: "launch", name: `${me} ${i}`, symbol: `${me.slice(0, 3).toUpperCase()}${String.fromCharCode(65 + (i % 26))}${String.fromCharCode(65 + ((i * 7) % 26))}`, pitch: `Launching ${me}'s coin #${i}: fees fund my next experiment.` });
    else if (pick && i % 2 === 0) actions.push({ type: "buy", token: pick[2]!, ethIn: (E / 50n).toString(), reason: "small starter position" });
    actions.push({ type: "post", body: lines[i % lines.length]!.replace("{T}", pick ? `$${pick[1]}` : "the pad") + ` (${me}, turn ${i})` });
    i++;
    return new Response(JSON.stringify({ model: req.model, choices: [{ message: { role: "assistant", content: JSON.stringify({ thought: `turn ${i}`, actions }) } }], usage: { prompt_tokens: 900, completion_tokens: 80, cost: 0.0004 } }));
  }) as unknown as typeof fetch;
})();

const llm = new LlmClient({ apiKey: env.OPENROUTER_API_KEY ?? "demo", fetch: demo ? demoFetch : undefined, tracer });

function addAgent(handle: string, owner: string, style: Style, persona: string, modelId = demo ? "demo/model" : "deepseek/deepseek-v4.1-flash", external = false): Agent {
  const a: Agent = { account: `0x${createHash("sha256").update(handle).digest("hex").slice(0, 40)}`, owner, handle, name: handle, persona, modelId, plan: { ...PRESETS[style] }, awake: true, external, createdAt: Date.now() };
  world.agents.set(a.account, a);
  world.balances.set(a.account, 1n * E);
  return a;
}

if (demo && !onchain) {
  addAgent("atlas", "0xowner1", "momentum", "Follows real demand, ignores fleet noise.");
  addAgent("vesper", "0xowner2", "contrarian", "Fades crowded trades; patient.");
  addAgent("quill", "0xowner3", "sniper", "First into fresh launches with small size.");
  addAgent("moss", "0xowner1", "conviction", "Few coins, held long.");
}

// On-chain: agents this runtime drives (created via AgentRegistry with our session key).
// AGENTS_JSON='[{"account":"0x..","owner":"0x..","handle":"atlas","persona":"..","style":"momentum","modelId":"deepseek/deepseek-v4.1-flash"}]'
if (onchain) {
  for (const a of JSON.parse(env.AGENTS_JSON ?? "[]") as { account: string; owner: string; handle: string; persona: string; style: Style; modelId: string }[]) {
    world.agents.set(a.account, { account: a.account, owner: a.owner, handle: a.handle, name: a.handle, persona: a.persona, modelId: a.modelId, plan: { ...PRESETS[a.style] }, awake: true, external: false, createdAt: Date.now() });
  }
}

// ---------------------------------------------------------------- scheduler
async function pass() {
  if (indexer && poolQuoter) {
    await indexer.pass();
    await poolQuoter.refresh([...world.coins.keys()]);
    await indexer.syncBalances();
  }
  for (const a of world.agents.values()) {
    if (!a.awake || a.external) continue;
    await tick(world, a, { llm, tracer, chain, quoter }).catch((e) => console.error(`[tick] @${a.handle}`, e));
  }
}

// ---------------------------------------------------------------- API
const send = (res: ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { "content-type": "application/json", "access-control-allow-origin": "*", "access-control-allow-headers": "authorization,content-type" });
  res.end(JSON.stringify(body, (_k, v) => (typeof v === "bigint" ? v.toString() : v)));
};
const readJson = (req: IncomingMessage) =>
  new Promise<any>((ok, bad) => { let d = ""; req.on("data", (c) => (d += c)); req.on("end", () => { try { ok(d ? JSON.parse(d) : {}); } catch (e) { bad(e); } }); });

const publicAgent = (a: Agent) => {
  const pnl = realizedPnl(world.fills).get(a.account);
  return {
    account: a.account, handle: a.handle, name: a.name, persona: a.persona, modelId: a.modelId, style: a.plan.style, external: a.external,
    balanceWei: world.balances.get(a.account) ?? 0n, positions: world.positions.get(a.account) ?? [],
    realizedPnlWei: pnl?.realizedWei ?? 0n, excludedWashWei: pnl?.excludedWei ?? 0n,
    followers: [...world.follows].filter((f) => f.endsWith(`->${a.account}`)).length,
  };
};

createServer(async (req, res) => {
  if (req.method === "OPTIONS") return send(res, 204, {});
  const url = new URL(req.url ?? "/", "http://x");
  const [v1, resource, id, sub] = url.pathname.split("/").filter(Boolean);
  try {
    if (v1 !== "v1") return send(res, 404, { error: "not found" });

    if (resource === "feed") return send(res, 200, { posts: world.feed(Number(url.searchParams.get("limit") ?? 50)).map((p) => ({ ...p, handle: world.agents.get(p.agent)?.handle })) });
    if (resource === "coins") return send(res, 200, { coins: [...world.coins.values()].map((c) => ({ ...c, launcherHandle: world.agents.get(c.launcher)?.handle, price: Number(E) / Number(quoter.quoteBuy(c.token, E / 1000n) * 1000n || 1n) })) });
    if (resource === "leaderboard") {
      const rows = [...world.agents.values()].map(publicAgent).sort((a, b) => (b.realizedPnlWei > a.realizedPnlWei ? 1 : -1));
      return send(res, 200, { agents: rows });
    }
    if (resource === "agents" && !id && req.method === "GET") return send(res, 200, { agents: [...world.agents.values()].map(publicAgent) });

    // External agent registration (prod: tied to an on-chain AgentRegistry.create by the owner).
    if (resource === "agents" && !id && req.method === "POST") {
      const b = await readJson(req);
      if (!/^[a-z0-9]{2,15}$/.test(b.handle ?? "") || world.agentByHandle(b.handle)) return send(res, 400, { error: "bad or taken handle" });
      const style: Style = (b.style in PRESETS ? b.style : "momentum") as Style;
      if (b.managed) {
        // Platform-run agent: our LLM loop drives it (demo: scripted model).
        const a = addAgent(b.handle, String(b.owner ?? "0xdemo-owner"), style, String(b.persona ?? "").slice(0, 400), demo ? "demo/model" : String(b.modelId ?? "deepseek/deepseek-v4.1-flash"), false);
        return send(res, 201, { agent: publicAgent(a) });
      }
      const a = addAgent(b.handle, String(b.owner ?? "0xexternal"), style, String(b.persona ?? ""), String(b.modelId ?? "external"), true);
      const key = `ak_${randomBytes(24).toString("hex")}`;
      apiKeys.set(createHash("sha256").update(key).digest("hex"), a.account);
      return send(res, 201, { agent: publicAgent(a), apiKey: key });
    }

    if (resource === "agents" && id) {
      const a = world.agentByHandle(id);
      if (!a) return send(res, 404, { error: "unknown agent" });
      if (sub === "actions" && req.method === "POST") {
        const token = (req.headers.authorization ?? "").replace(/^Bearer /, "");
        if (apiKeys.get(createHash("sha256").update(token).digest("hex")) !== a.account) return send(res, 401, { error: "bad api key" });
        const b = await readJson(req);
        const actions: Action[] = (b.actions ?? []).slice(0, 3);
        const results = await tracer.withSpan(`external @${a.handle}`, "run", async (s) => {
          s.setAttrs({ agent: a.account, handle: a.handle, external: true });
          const out = [];
          for (const act of actions) out.push(await applyAction(world, chain, quoter, a, act, tracer).catch((e) => ({ action: act, ok: false, detail: String(e) })));
          world.decisions.push({ agent: a.account, traceId: s.record.traceId, at: Date.now(), summary: String(b.thought ?? "") });
          return out;
        });
        return send(res, 200, { results });
      }
      const decisions = world.decisions.filter((d) => d.agent === a.account).slice(-30).reverse();
      return send(res, 200, { agent: publicAgent(a), posts: world.feed(30, a.account), decisions });
    }

    if (resource === "traces" && id) return send(res, 200, { tree: buildTree([...live.spans.values()].filter((s) => s.traceId === id)) });

    if (resource === "stream") {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", "access-control-allow-origin": "*" });
      const f = (s: SpanRecord) => { if (s.kind === "run" && s.endedAt) res.write(`data: ${JSON.stringify({ id: s.id, handle: s.attrs.handle })}\n\n`); };
      live.subs.add(f);
      req.on("close", () => live.subs.delete(f));
      return;
    }
    return send(res, 404, { error: "not found" });
  } catch (err) {
    return send(res, 500, { error: err instanceof Error ? err.message : String(err) });
  }
}).listen(PORT);

console.log(`[runtime] API on :${PORT}${demo ? " (demo LLM)" : ""}${onchain ? " on-chain" : " SimChain"}`);
await pass();
setInterval(() => void pass(), Number(env.TICK_MS ?? (demo ? 10_000 : 60_000)));
