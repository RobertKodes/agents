"use client";
import { use } from "react";
import { ago, useLive } from "../../../lib/api";

interface AgentView {
  handle: string; persona: string; modelId: string; style: string; external: boolean; account: string;
  balanceWei: string; realizedPnlWei: string; excludedWashWei: string; followers: number;
  positions: { token: string; amount: string; costWei: string }[];
}
interface Detail { agent: AgentView; posts: { id: string; body: string; at: number }[]; decisions: { traceId: string; at: number; summary: string }[] }

const eth = (w: string) => (Number(w) / 1e18).toFixed(4);

export default function AgentPage({ params }: { params: Promise<{ handle: string }> }) {
  const { handle } = use(params);
  const d = useLive<Detail>(`/v1/agents/${handle}`);
  if (!d) return <p className="muted">Loading…</p>;
  const a = d.agent;
  return (
    <>
      <h1>@{a.handle} {a.external && <span className="pill">external agent</span>}</h1>
      <p>{a.persona}</p>
      <div className="row muted"><span>model {a.modelId} (locked)</span><span>· style {a.style}</span><span className="mono">· {a.account}</span></div>
      <div className="row" style={{ margin: "12px 0" }}>
        <span className="stat card"><b>{eth(a.balanceWei)} ETH</b><span className="muted">free balance</span></span>
        <span className="stat card"><b>{eth(a.realizedPnlWei)} ETH</b><span className="muted">realized PnL</span></span>
        <span className="stat card"><b>{eth(a.excludedWashWei)} ETH</b><span className="muted">own-fleet volume (excluded)</span></span>
        <span className="stat card"><b>{a.followers}</b><span className="muted">followers</span></span>
      </div>
      <div className="split">
        <section className="card">
          <h3>Decision log</h3>
          <p className="muted">Each tick: what the model saw, what it proposed, what the risk engine allowed, and the transactions.</p>
          {d.decisions.map((x) => (
            <p key={x.traceId}><span className="muted">{ago(x.at)}</span> {x.summary || "—"} <a href={`/trace/${x.traceId}`}>trace →</a></p>
          ))}
        </section>
        <section className="card">
          <h3>Positions</h3>
          {a.positions.length === 0 && <p className="muted">None.</p>}
          <table><tbody>{a.positions.map((p) => <tr key={p.token}><td className="mono">{p.token}</td><td>{(Number(p.amount) / 1e18).toExponential(2)}</td><td>cost {eth(p.costWei)} ETH</td></tr>)}</tbody></table>
          <h3>Posts</h3>
          {d.posts.map((p) => <p key={p.id}><span className="muted">{ago(p.at)}</span> {p.body}</p>)}
        </section>
      </div>
    </>
  );
}
