"use client";
import { use, useMemo, useState } from "react";
import { useLive, usd, type Span } from "../../../lib/api";

function flatten(nodes: Span[], out: Span[] = []): Span[] {
  for (const n of nodes) { out.push(n); flatten(n.children ?? [], out); }
  return out;
}

function Node({ s, sel, onSel, at }: { s: Span; sel: string | null; onSel: (s: Span) => void; at: number }) {
  if (s.startedAt > at) return null; // replay: hide spans that had not started yet
  const done = s.endedAt != null && s.endedAt <= at;
  const swapped = s.kind === "llm_call" && s.attrs.swapped;
  return (
    <li>
      <div className={`span-row ${sel === s.id ? "sel" : ""}`} onClick={() => onSel(s)}>
        <span className={`pill ${done ? s.status : "running"}`}>{s.kind}</span>
        <span>{s.name}</span>
        {swapped ? <span className="pill error">model swap</span> : null}
        <span className="muted" style={{ marginLeft: "auto" }}>{usd(s.totalCostUsd)}</span>
      </div>
      {s.children?.length ? <ul className="tree">{s.children.map((c) => <Node key={c.id} s={c} sel={sel} onSel={onSel} at={at} />)}</ul> : null}
    </li>
  );
}

export default function TracePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const data = useLive<{ tree: Span[] }>(`/v1/traces/${id}`, id);
  const [sel, setSel] = useState<Span | null>(null);
  const [pos, setPos] = useState(1);

  const all = useMemo(() => flatten(data?.tree ?? []), [data]);
  if (!data) return <p className="muted">Loading…</p>;
  const root = data.tree[0];
  if (!root) return <p>No spans for this trace.</p>;

  const start = root.startedAt;
  const end = Math.max(...all.map((s) => s.endedAt ?? Date.now()));
  const at = start + (end - start) * pos;
  const llm = all.filter((s) => s.kind === "llm_call");
  const shot = [...all].reverse().find((s) => s.startedAt <= at && typeof s.attrs.screenshot === "string");

  return (
    <>
      <h1>{root.name}</h1>
      <div className="row muted">
        <span>{usd(root.totalCostUsd)} total</span>
        <span>{root.tokens.prompt + root.tokens.completion} tokens</span>
        <span>{llm.length} model calls</span>
        <span>{((end - start) / 1000).toFixed(1)}s</span>
        <span>requested {String(root.attrs.requestedModel)} · served {((root.attrs.servedModels as string[]) ?? []).join(", ")}</span>
      </div>

      <div className="card" style={{ marginTop: 12 }}>
        <b>Replay</b> <span className="muted">{new Date(at).toLocaleTimeString()}</span>
        <input type="range" min={0} max={1} step={0.001} value={pos} onChange={(e) => setPos(Number(e.target.value))} />
        {shot && <img src={String(shot.attrs.screenshot)} alt="browser frame" style={{ maxWidth: "100%", borderRadius: 6 }} />}
      </div>

      <div className="split" style={{ marginTop: 12 }}>
        <section className="card">
          <ul className="tree" style={{ paddingLeft: 0 }}>
            <Node s={root} sel={sel?.id ?? null} onSel={(s) => { setSel(s); setPos((s.startedAt - start) / Math.max(1, end - start)); }} at={at} />
          </ul>
        </section>
        <section className="card">
          {!sel ? <p className="muted">Select a span to see its full input, output, cost and model.</p> : (
            <>
              <h3>{sel.name}</h3>
              <div className="row muted">
                <span className={`pill ${sel.status}`}>{sel.status}</span>
                <span>own {usd(sel.costUsd)} · total {usd(sel.totalCostUsd)}</span>
                <span>{sel.tokens.prompt}+{sel.tokens.completion} tok</span>
                <span>{sel.endedAt ? `${sel.endedAt - sel.startedAt}ms` : "running"}</span>
              </div>
              {sel.error && <p className="warn">{sel.error}</p>}
              <h4>Attributes</h4><pre>{JSON.stringify(sel.attrs, null, 2)}</pre>
              <h4>Input</h4><pre>{JSON.stringify(sel.input, null, 2)}</pre>
              <h4>Output</h4><pre>{JSON.stringify(sel.output, null, 2)}</pre>
            </>
          )}
        </section>
      </div>
    </>
  );
}
