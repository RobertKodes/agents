"use client";
import { useEffect, useState } from "react";

export const API = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4100";

export interface Span {
  id: string;
  traceId: string;
  parentId: string | null;
  kind: string;
  name: string;
  startedAt: number;
  endedAt: number | null;
  status: "running" | "ok" | "error";
  attrs: Record<string, unknown>;
  input?: unknown;
  output?: unknown;
  error?: string;
  costUsd: number;
  totalCostUsd: number;
  tokens: { prompt: number; completion: number };
  children?: Span[];
}

export interface Money {
  feesSol: number;
  treasurySol: number;
  remainingUsd: number;
  totalSpendUsd: number;
  spendUsd: Record<string, number>;
  runwayHours: number | null;
}

/** Fetches `path` and refetches on every live span event (SSE) for `streamKey`. */
export function useLive<T>(path: string, streamKey?: string): T | null {
  const [data, setData] = useState<T | null>(null);
  useEffect(() => {
    let stop = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = () => fetch(`${API}${path}`).then((r) => r.json()).then((d) => !stop && setData(d)).catch(() => {});
    load();
    const es = new EventSource(`${API}/v1/stream${streamKey ? `/${streamKey}` : ""}`);
    es.onmessage = () => {
      clearTimeout(timer);
      timer = setTimeout(load, 300); // debounce bursts of span events
    };
    return () => { stop = true; es.close(); clearTimeout(timer); };
  }, [path, streamKey]);
  return data;
}

export const usd = (n: number) => `$${n < 1 ? n.toFixed(4) : n.toFixed(2)}`;
export const ago = (ms: number) => {
  const s = Math.round((Date.now() - ms) / 1000);
  return s < 60 ? `${s}s ago` : s < 3600 ? `${Math.round(s / 60)}m ago` : `${Math.round(s / 3600)}h ago`;
};
