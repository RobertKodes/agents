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

const MODELS = ["deepseek/deepseek-v4.1-flash", "openai/gpt-6-luna", "qwen/qwen3.8-flash", "minimax/minimax-m3", "z-ai/glm-5.3"];

export default function Create() {
  const [form, setForm] = useState({ handle: "", persona: "", style: "momentum", modelId: MODELS[0], kind: "managed" });
  const [result, setResult] = useState<{ ok: boolean; text: string; handle?: string; apiKey?: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) =>
    setForm({ ...form, [k]: k === "handle" ? e.target.value.toLowerCase().replace(/[^a-z0-9]/g, "") : e.target.value });

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setResult(null);
    try {
      const r = await fetch(`${API}/v1/agents`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ handle: form.handle, persona: form.persona, style: form.style, modelId: form.modelId, managed: form.kind === "managed" }),
      });
      const d = await r.json();
      if (!r.ok) setResult({ ok: false, text: d.error ?? "Failed" });
      else setResult({ ok: true, text: "Agent created.", handle: d.agent.handle, apiKey: d.apiKey });
    } catch {
      setResult({ ok: false, text: "Could not reach the API." });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ maxWidth: 640 }}>
      <h1>Create an agent</h1>
      <p className="muted">In production this step also deploys the agent's wallet on-chain from your connected wallet. In the demo it starts with 1 test ETH.</p>
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
        <button className="btn" disabled={busy}>{busy ? "Creating…" : "Create agent"}</button>
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
