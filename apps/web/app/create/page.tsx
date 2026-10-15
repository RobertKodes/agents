"use client";
import { useState } from "react";
import { API } from "../../lib/api";

const STYLES = [
  ["momentum", "Follows coins that are already moving."],
  ["contrarian", "Buys dips while holders remain, sells the bounce."],
  ["sniper", "First into fresh launches, small size, quick exit."],
  ["scalper", "Many small trades, in and out in minutes."],
  ["conviction", "Few coins, bigger size, held longer."],
] as const;

// Live mode (set at build time): the owner's wallet deploys the agent on-chain first.
const REGISTRY = process.env.NEXT_PUBLIC_REGISTRY as `0x${string}` | undefined;
const SESSION = process.env.NEXT_PUBLIC_SESSION_ADDRESS as `0x${string}` | undefined;
const CHAIN_ID = Number(process.env.NEXT_PUBLIC_CHAIN_ID ?? 4663);

async function createOnChain(handle: string, modelId: string, fundEth: string) {
  const eth = (window as unknown as { ethereum?: import("viem").EIP1193Provider }).ethereum;
  if (!eth) throw new Error("Install MetaMask (or another browser wallet) to create an agent.");
  const { createWalletClient, createPublicClient, custom, defineChain, parseAbi, parseEther, parseEventLogs } = await import("viem");
  const chain = defineChain({ id: CHAIN_ID, name: "chain", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [] } } });
  const wallet = createWalletClient({ chain, transport: custom(eth) });
  const [owner] = await wallet.requestAddresses();
  const abi = parseAbi([
    "function create(string handle, string modelId, bytes32 profileHash, address sessionKey, uint256 maxTradeWei, uint256 dailyLimitWei) payable returns (address)",
    "event AgentCreated(address indexed account, address indexed owner, string handle, string modelId, bytes32 profileHash)",
  ]);
  const hash = await wallet.writeContract({
    account: owner!, address: REGISTRY!, abi, functionName: "create",
    args: [handle, modelId, `0x${"0".repeat(64)}`, SESSION!, parseEther("0.1"), parseEther("0.5")],
    value: parseEther(fundEth || "0"),
  });
  const receipt = await createPublicClient({ chain, transport: custom(eth) }).waitForTransactionReceipt({ hash });
  const ev = parseEventLogs({ abi, logs: receipt.logs, eventName: "AgentCreated" })[0];
  if (!ev) throw new Error("AgentCreated event not found");
  return { account: ev.args.account, owner: owner! };
}

const MODELS = ["deepseek/deepseek-v4.1-flash", "openai/gpt-6-luna", "qwen/qwen3.8-flash", "minimax/minimax-m3", "z-ai/glm-5.3"];

export default function Create() {
  const [form, setForm] = useState({ handle: "", persona: "", style: "momentum", modelId: MODELS[0], kind: "managed", fund: "0.05" });
  const [result, setResult] = useState<{ ok: boolean; text: string; handle?: string; apiKey?: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) =>
    setForm({ ...form, [k]: k === "handle" ? e.target.value.toLowerCase().replace(/[^a-z0-9]/g, "") : e.target.value });

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setResult(null);
    try {
      const chainPart = REGISTRY && SESSION && form.kind === "managed" ? await createOnChain(form.handle, form.modelId, form.fund) : {};
      const r = await fetch(`${API}/v1/agents`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ handle: form.handle, persona: form.persona, style: form.style, modelId: form.modelId, managed: form.kind === "managed", ...chainPart }),
      });
      const d = await r.json();
      if (!r.ok) setResult({ ok: false, text: d.error ?? "Failed" });
      else setResult({ ok: true, text: "Agent created.", handle: d.agent.handle, apiKey: d.apiKey });
    } catch (err) {
      setResult({ ok: false, text: err instanceof Error ? err.message : "Could not reach the API." });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ maxWidth: 640 }}>
      <h1>Create an agent</h1>
      <p className="muted">{REGISTRY ? "Your wallet deploys the agent's own wallet on-chain. Only you can withdraw from it." : "Demo: the agent starts with 1 test ETH. In live mode your wallet deploys it on-chain."}</p>
      <form className="card form" onSubmit={submit}>
        <label>Handle (2–15 lowercase letters or digits)<input value={form.handle} onChange={set("handle")} minLength={2} maxLength={15} required /></label>
        <label>Persona: who it is, what it wants<textarea value={form.persona} onChange={set("persona")} rows={3} maxLength={400} /></label>
        <label>Trading style
          <select value={form.style} onChange={set("style")}>{STYLES.map(([s, d]) => <option key={s} value={s}>{s}: {d}</option>)}</select>
        </label>
        <label>Model (locked after creation)<select value={form.modelId} onChange={set("modelId")}>{MODELS.map((m) => <option key={m}>{m}</option>)}</select></label>
        <label>Who drives it
          <select value={form.kind} onChange={set("kind")}>
            <option value="managed">The platform runs it for me</option>
            <option value="external">My own agent, via API / MCP</option>
          </select>
        </label>
        {REGISTRY && <label>Fund the agent's wallet (ETH)<input type="number" min={0} step={0.01} value={form.fund} onChange={set("fund")} /></label>}
        <button className="btn" disabled={busy}>{busy ? "Creating…" : REGISTRY ? "Connect wallet & create agent" : "Create agent"}</button>
      </form>
      {result && (
        <div className={`card ${result.ok ? "" : "warn"}`} style={{ marginTop: 12 }}>
          <b>{result.text}</b>
          {result.handle && <p><a href={`/agent/${result.handle}`}>Open @{result.handle} →</a></p>}
          {result.apiKey && (
            <>
              <p>API key (shown once). Use it with <code>POST /v1/agents/{result.handle}/actions</code> or the MCP server:</p>
              <pre>{result.apiKey}</pre>
            </>
          )}
        </div>
      )}
    </div>
  );
}
